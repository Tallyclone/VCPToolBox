"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const chokidar = require("chokidar");
const { AsyncLocalStorage } = require("async_hooks");

let requestContext = new AsyncLocalStorage();
const shadowRegistry = new Map(); // toolName -> Map<serverId, record>
const serverAliases = new Map(); // serverId/serverName -> canonical serverId
const serverInfoRegistry = new Map(); // serverId -> { serverName, localIPs, publicIP, reportedAt }

const PATCH_FLAG = Symbol.for("ShadowDistributedRouter.patched");
const ORIGINAL_FN = Symbol.for("ShadowDistributedRouter.original");
const INTERNAL_TOOLS = new Set(["internal_request_file"]);
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);
const DEVICE_ALIASES_PATH = path.join(__dirname, "device-aliases.json");
const SHADOW_PLACEHOLDER = "{{VCPShadowDistributedRouter}}";

let installed = false;

class ShadowDistributedRouter {
  constructor() {
    this.name = "ShadowDistributedRouter";
    this.patchRecords = [];
    this.pluginManager = null;
    this.deviceAliases = createDefaultDeviceAliases();
    this.aliasWatcher = null;
  }

  async initialize(config = {}, dependencies = {}) {
    if (installed) {
      console.log("[ShadowDistributedRouter] already installed, skip.");
      return;
    }

    const wss = require("../../WebSocketServer");
    const pluginManager = require("../../Plugin");
    this.pluginManager = dependencies.pluginManager || pluginManager;
    this.loadDeviceAliases();
    this.syncDeviceAliasesAndRefreshPlaceholder();
    this.watchDeviceAliasesWithChokidar();

    const patchedHandle = this.patchHandleDistributedServerMessage(wss);
    const patchedProcess = this.patchProcessToolCall(this.pluginManager);
    const patchedDistributedExecute = this.patchExecuteDistributedTool(wss);
    const patchedToolExecutor = this.patchToolExecutorExecute();
    this.patchUnregisterDistributedTools(this.pluginManager);

    if (
      !patchedHandle ||
      !patchedProcess ||
      !patchedDistributedExecute ||
      !patchedToolExecutor
    ) {
      this.shutdown();
      throw new Error(
        "[ShadowDistributedRouter] failed to install required patches."
      );
    }

    installed = true;
    console.log(
      "[ShadowDistributedRouter] initialized. Session-affinity + explicit #device routing active."
    );
  }

  shutdown() {
    for (let i = this.patchRecords.length - 1; i >= 0; i--) {
      const record = this.patchRecords[i];
      if (record.target && record.target[record.method] === record.patched) {
        record.target[record.method] = record.original;
      }
    }

    this.patchRecords = [];
    if (this.aliasWatcher) {
      this.aliasWatcher.close().catch(() => {});
      this.aliasWatcher = null;
    }
    if (this.pluginManager?.staticPlaceholderValues) {
      this.pluginManager.staticPlaceholderValues.delete(SHADOW_PLACEHOLDER);
      this.pluginManager.staticPlaceholderValues.delete(
        "{{ShadowDistributedRouter}}"
      );
    }
    this.pluginManager = null;
    installed = false;
    requestContext.disable();
    requestContext = new AsyncLocalStorage();
    shadowRegistry.clear();
    serverAliases.clear();
    serverInfoRegistry.clear();
    console.log(
      "[ShadowDistributedRouter] shutdown complete, patches restored."
    );
  }

  patchHandleDistributedServerMessage(wss) {
    if (!wss || typeof wss.handleDistributedServerMessage !== "function") {
      console.warn(
        "[ShadowDistributedRouter] handleDistributedServerMessage not found, skip patch."
      );
      return false;
    }

    if (wss.handleDistributedServerMessage[PATCH_FLAG]) {
      this.adoptExistingPatch(wss, "handleDistributedServerMessage");
      console.log(
        "[ShadowDistributedRouter] handleDistributedServerMessage already patched, adopted."
      );
      return true;
    }

    const original = wss.handleDistributedServerMessage;
    const self = this;

    const patched = async function patchedHandleDistributedServerMessage(
      serverId,
      message
    ) {
      try {
        self.captureDistributedServerMessage(serverId, message);
      } catch (err) {
        console.warn(
          "[ShadowDistributedRouter] capture distributed message error:",
          err.message
        );
      }

      return original.call(this, serverId, message);
    };

    markPatched(patched, original);
    wss.handleDistributedServerMessage = patched;
    this.patchRecords.push({
      target: wss,
      method: "handleDistributedServerMessage",
      original,
      patched,
    });
    console.log(
      "[ShadowDistributedRouter] patched handleDistributedServerMessage"
    );
    return true;
  }

  patchProcessToolCall(pluginManager) {
    if (!pluginManager || typeof pluginManager.processToolCall !== "function") {
      console.warn(
        "[ShadowDistributedRouter] processToolCall not found, skip patch."
      );
      return false;
    }

    if (pluginManager.processToolCall[PATCH_FLAG]) {
      this.adoptExistingPatch(pluginManager, "processToolCall");
      console.log(
        "[ShadowDistributedRouter] processToolCall already patched, adopted."
      );
      return true;
    }

    const original = pluginManager.processToolCall;

    const patched = async function patchedProcessToolCall(
      toolName,
      toolArgs,
      requestIp = null,
      sourceNode = null
    ) {
      const parentStore = requestContext.getStore() || {};
      return requestContext.run(
        {
          ...parentStore,
          requestIp: requestIp || parentStore.requestIp,
          sourceNode: sourceNode || parentStore.sourceNode,
        },
        async () =>
          original.call(this, toolName, toolArgs, requestIp, sourceNode)
      );
    };

    markPatched(patched, original);
    pluginManager.processToolCall = patched;
    this.patchRecords.push({
      target: pluginManager,
      method: "processToolCall",
      original,
      patched,
    });
    console.log("[ShadowDistributedRouter] patched processToolCall");
    return true;
  }

  patchUnregisterDistributedTools(pluginManager) {
    if (
      !pluginManager ||
      typeof pluginManager.unregisterAllDistributedTools !== "function"
    ) {
      console.warn(
        "[ShadowDistributedRouter] unregisterAllDistributedTools not found, offline cleanup patch skipped."
      );
      return false;
    }

    if (pluginManager.unregisterAllDistributedTools[PATCH_FLAG]) {
      this.adoptExistingPatch(pluginManager, "unregisterAllDistributedTools");
      console.log(
        "[ShadowDistributedRouter] unregisterAllDistributedTools already patched, adopted."
      );
      return true;
    }

    const original = pluginManager.unregisterAllDistributedTools;
    const self = this;
    const patched = function patchedUnregisterAllDistributedTools(
      serverId,
      ...rest
    ) {
      try {
        self.handleDistributedServerOffline(serverId);
      } catch (err) {
        console.warn(
          "[ShadowDistributedRouter] offline cleanup before unregister failed:",
          err.message
        );
      }
      return original.call(this, serverId, ...rest);
    };

    markPatched(patched, original);
    pluginManager.unregisterAllDistributedTools = patched;
    this.patchRecords.push({
      target: pluginManager,
      method: "unregisterAllDistributedTools",
      original,
      patched,
    });
    console.log(
      "[ShadowDistributedRouter] patched unregisterAllDistributedTools"
    );
    return true;
  }

  handleDistributedServerOffline(serverId) {
    if (!serverId) return;

    let removedToolInstances = 0;
    for (const [toolName, instances] of Array.from(shadowRegistry.entries())) {
      if (instances.delete(serverId)) removedToolInstances++;
      if (instances.size === 0) shadowRegistry.delete(toolName);
    }

    serverInfoRegistry.delete(serverId);
    serverAliases.delete(serverId);
    for (const [alias, canonical] of Array.from(serverAliases.entries())) {
      if (canonical === serverId) serverAliases.delete(alias);
    }

    this.refreshShadowDistributedRouterPlaceholder();
    console.log(
      `[ShadowDistributedRouter] distributed server offline cleanup: ${serverId}; removedToolInstances=${removedToolInstances}`
    );
  }

  patchExecuteDistributedTool(wss) {
    if (!wss || typeof wss.executeDistributedTool !== "function") {
      console.warn(
        "[ShadowDistributedRouter] executeDistributedTool not found, skip patch."
      );
      return false;
    }

    if (wss.executeDistributedTool[PATCH_FLAG]) {
      this.adoptExistingPatch(wss, "executeDistributedTool");
      console.log(
        "[ShadowDistributedRouter] executeDistributedTool already patched, adopted."
      );
      return true;
    }

    const original = wss.executeDistributedTool;
    const self = this;

    const patched = async function patchedExecuteDistributedTool(
      serverIdOrName,
      toolName,
      toolArgs,
      timeout
    ) {
      try {
        const targetServerId = self.resolveTargetServerId(
          wss,
          serverIdOrName,
          toolName
        );

        if (targetServerId && targetServerId !== serverIdOrName) {
          const store = requestContext.getStore();
          console.log(
            `[ShadowDistributedRouter] reroute ${toolName}: ${serverIdOrName} -> ${targetServerId} (requestIp: ${
              store?.requestIp || "unknown"
            })`
          );
          return original.call(
            this,
            targetServerId,
            toolName,
            toolArgs,
            timeout
          );
        }
      } catch (err) {
        const store = requestContext.getStore();
        if (store?.routeContext?.explicitAlias) {
          throw err;
        }
        console.warn(
          "[ShadowDistributedRouter] route error, fallback:",
          err.message
        );
      }

      return original.call(this, serverIdOrName, toolName, toolArgs, timeout);
    };

    markPatched(patched, original);
    wss.executeDistributedTool = patched;
    this.patchRecords.push({
      target: wss,
      method: "executeDistributedTool",
      original,
      patched,
    });
    console.log("[ShadowDistributedRouter] patched executeDistributedTool");
    return true;
  }

  patchToolExecutorExecute() {
    let ToolExecutor;
    try {
      ToolExecutor = require("../../modules/vcpLoop/toolExecutor");
    } catch (err) {
      console.warn(
        "[ShadowDistributedRouter] failed to require ToolExecutor:",
        err.message
      );
      return false;
    }

    if (
      !ToolExecutor?.prototype ||
      typeof ToolExecutor.prototype.execute !== "function"
    ) {
      console.warn(
        "[ShadowDistributedRouter] ToolExecutor.prototype.execute not found, skip patch."
      );
      return false;
    }

    if (ToolExecutor.prototype.execute[PATCH_FLAG]) {
      this.adoptExistingPatch(ToolExecutor.prototype, "execute");
      console.log(
        "[ShadowDistributedRouter] ToolExecutor.execute already patched, adopted."
      );
      return true;
    }

    const original = ToolExecutor.prototype.execute;
    const self = this;
    const patched = async function patchedExecute(
      toolCall,
      clientIp,
      contextMessages = [],
      ...rest
    ) {
      const parsed = parseToolNameWithAlias(toolCall?.name || "");
      const normalizedToolCall = parsed.deviceAlias
        ? { ...toolCall, name: parsed.rawToolName }
        : toolCall;
      const routeContext = parsed.deviceAlias
        ? {
            explicitAlias: parsed.deviceAlias,
            rawToolName: parsed.rawToolName,
            originalToolName: toolCall?.name || "",
            createdAt: Date.now(),
          }
        : null;

      if (parsed.deviceAlias && !self.isDistributedTool(parsed.rawToolName)) {
        console.log(
          `[ShadowDistributedRouter] Ignored device alias "${parsed.deviceAlias}" for local tool "${parsed.rawToolName}".`
        );
      }

      const parentStore = requestContext.getStore() || {};
      return requestContext.run(
        {
          ...parentStore,
          requestIp: clientIp || parentStore.requestIp,
          sourceNode: parentStore.sourceNode || "post",
          routeContext,
        },
        async () =>
          original.call(
            this,
            normalizedToolCall,
            clientIp,
            contextMessages,
            ...rest
          )
      );
    };

    markPatched(patched, original);
    ToolExecutor.prototype.execute = patched;
    this.patchRecords.push({
      target: ToolExecutor.prototype,
      method: "execute",
      original,
      patched,
    });
    console.log("[ShadowDistributedRouter] patched ToolExecutor.execute");
    return true;
  }

  adoptExistingPatch(target, method) {
    const patched = target?.[method];
    const original = patched?.[ORIGINAL_FN];

    if (!patched || !original) return false;

    const alreadyRecorded = this.patchRecords.some(
      (record) =>
        record.target === target &&
        record.method === method &&
        record.patched === patched
    );
    if (!alreadyRecorded) {
      this.patchRecords.push({ target, method, original, patched });
    }
    return true;
  }

  resolveTargetServerId(wss, originalServerId, toolName) {
    const store = requestContext.getStore();
    const instances = shadowRegistry.get(toolName);
    if (!instances || instances.size === 0) return originalServerId;

    const explicitAlias = store?.routeContext?.explicitAlias;
    if (explicitAlias) {
      const explicitTarget = this.routeWithExplicitAlias(
        toolName,
        explicitAlias
      );
      if (explicitTarget) return explicitTarget;
    }

    const requestIp = store?.requestIp;
    if (!requestIp) return originalServerId;

    const deviceMatch = findMatchingDeviceForSystemFields(
      this.deviceAliases.devices,
      requestIp,
      { lastKnownIPs: [requestIp] }
    );
    if (deviceMatch === false) {
      return originalServerId;
    }
    if (deviceMatch?.serverId && instances.has(deviceMatch.serverId)) {
      return deviceMatch.serverId;
    }

    const directSourceServerId = findServerIdByReportedIp(requestIp);
    if (directSourceServerId) {
      if (instances.has(directSourceServerId)) {
        return directSourceServerId;
      }

      console.log(
        `[ShadowDistributedRouter] fallback ${toolName}: requestIp=${requestIp} directly matched ${directSourceServerId}, but it has no shadow instance`
      );
      return originalServerId;
    }

    if (typeof wss.findServerByIp === "function") {
      const sourceServerIdOrName = wss.findServerByIp(requestIp);
      if (sourceServerIdOrName) {
        const sourceServerId = resolveServerAlias(sourceServerIdOrName);
        if (instances.has(sourceServerId)) {
          return sourceServerId;
        }

        console.log(
          `[ShadowDistributedRouter] fallback ${toolName}: source server ${sourceServerIdOrName} resolved as ${sourceServerId}, but it has no shadow instance`
        );
        return originalServerId;
      }
    }

    if (isLocalhostAddress(requestIp)) {
      return resolveLocalhostTargetServerId(
        toolName,
        instances,
        originalServerId,
        requestIp
      );
    }

    console.log(
      `[ShadowDistributedRouter] fallback ${toolName}: no server matched requestIp=${requestIp}`
    );
    return originalServerId;
  }

  isDistributedTool(rawToolName) {
    const instances = shadowRegistry.get(rawToolName);
    return Boolean(instances && instances.size > 0);
  }

  routeWithExplicitAlias(rawToolName, deviceAlias) {
    const instances = shadowRegistry.get(rawToolName);
    if (!instances || instances.size === 0) return null;

    const match = this.resolveDeviceByFriendlyName(deviceAlias);
    if (!match) {
      throw new Error(
        `设备别名“${deviceAlias}”不存在或当前无可匹配在线设备。当前在线设备：${listOnlineDeviceAliases(
          this.deviceAliases.devices
        )}`
      );
    }
    if (match.ambiguous) {
      throw new Error(
        `设备别名“${deviceAlias}”存在歧义，候选设备：${match.candidates
          .map(formatDeviceCandidate)
          .join("；")}`
      );
    }

    const targetServerId = getOnlineDeviceServerId(match.device);
    if (!targetServerId || !instances.has(targetServerId)) {
      const candidates = Array.from(instances.keys())
        .map((serverId) =>
          findDeviceByServerId(this.deviceAliases.devices, serverId)
        )
        .filter(Boolean)
        .map(getPrimaryDeviceAlias)
        .filter(Boolean);
      throw new Error(
        `设备“${deviceAlias}”在线，但未注册工具“${rawToolName}”。支持该工具的在线设备：${
          candidates.join("、") || "无"
        }`
      );
    }

    console.log(
      `[ShadowDistributedRouter] explicit route ${rawToolName}#${deviceAlias} -> ${targetServerId}`
    );
    return targetServerId;
  }

  resolveDeviceByFriendlyName(deviceAlias) {
    const normalizedAlias = normalizeAliasForExactMatch(deviceAlias);
    if (!normalizedAlias) return null;

    const candidates = [];
    for (const device of this.deviceAliases.devices || []) {
      if (!device.enabled || !getOnlineDeviceServerId(device)) continue;
      const friendlyNames = Array.isArray(device.friendlyNames)
        ? device.friendlyNames
        : [];
      if (
        friendlyNames.some(
          (alias) => normalizeAliasForExactMatch(alias) === normalizedAlias
        )
      ) {
        candidates.push(device);
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length > 1) return { ambiguous: true, candidates };
    return { ambiguous: false, device: candidates[0] };
  }

  captureDistributedServerMessage(serverId, message) {
    if (!serverId || !message) return;

    registerServerAlias(serverId, serverId);

    if (message.type === "register_tools") {
      const serverName = message.data?.serverName;
      if (serverName) registerServerAlias(serverName, serverId);
      captureRegisterTools(serverId, message);
      this.syncDeviceAliasesAndRefreshPlaceholder();
      return;
    }

    if (message.type === "report_ip") {
      captureReportIp(serverId, message);
      this.syncDeviceAliasesAndRefreshPlaceholder();
    }
  }

  loadDeviceAliases() {
    try {
      if (!fs.existsSync(DEVICE_ALIASES_PATH)) {
        this.deviceAliases = createDefaultDeviceAliases();
        this.saveDeviceAliases();
        return;
      }

      const parsed = JSON.parse(fs.readFileSync(DEVICE_ALIASES_PATH, "utf8"));
      this.deviceAliases = normalizeDeviceAliases(parsed);
    } catch (err) {
      console.warn(
        "[ShadowDistributedRouter] failed to load device-aliases.json, using defaults:",
        err.message
      );
      this.deviceAliases = createDefaultDeviceAliases();
    }
  }

  saveDeviceAliases() {
    const latestOnDisk = loadDeviceAliasesFromDiskForMerge();
    this.deviceAliases = mergeUserOwnedDeviceFields(
      normalizeDeviceAliases(this.deviceAliases),
      latestOnDisk
    );
    fs.writeFileSync(
      DEVICE_ALIASES_PATH,
      `${JSON.stringify(this.deviceAliases, null, 2)}\n`,
      "utf8"
    );
  }

  syncDeviceAliasesAndRefreshPlaceholder() {
    this.syncDeviceAliasesFromRegistries();
    this.refreshShadowDistributedRouterPlaceholder();
  }

  syncDeviceAliasesFromRegistries() {
    this.deviceAliases = normalizeDeviceAliases(this.deviceAliases);

    const knownServerIds = collectKnownServerIds();
    let changed = false;

    for (const serverId of knownServerIds) {
      const systemFields = getSystemDeviceFields(serverId);
      if (systemFields.lastKnownIPs.length === 0) {
        continue;
      }

      const existing = findMatchingDeviceForSystemFields(
        this.deviceAliases.devices,
        serverId,
        systemFields
      );

      if (existing === false) {
        continue;
      }

      if (!existing) {
        this.deviceAliases.devices.push(
          createAutoGeneratedDevice(systemFields)
        );
        changed = true;
        console.log(
          `[ShadowDistributedRouter] device alias auto-created: ${serverId}; reportedIPs=${systemFields.lastKnownIPs.join(
            ","
          )}`
        );
        continue;
      }

      const previousServerId = existing.serverId;
      const matchedIPs = intersectIpLists(
        existing.lastKnownIPs,
        systemFields.lastKnownIPs
      );
      const nextLastKnownIPs = mergeUniqueStrings(
        existing.lastKnownIPs,
        systemFields.lastKnownIPs
      );
      const updates = {
        serverId: systemFields.serverId,
        hostName: systemFields.hostName,
        serverName: systemFields.serverName,
        lastKnownIPs: nextLastKnownIPs,
        autoGenerated: existing.autoGenerated === true,
      };

      let deviceChanged = false;
      for (const [key, value] of Object.entries(updates)) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(value)) {
          existing[key] = value;
          deviceChanged = true;
        }
      }

      const removedDuplicates = removeBlankAutoGeneratedDuplicateDevices(
        this.deviceAliases.devices,
        existing,
        systemFields.serverId
      );
      const purgedRegistryAliases = purgeStaleServerIdentity(
        previousServerId,
        systemFields.serverId
      );
      if (deviceChanged || removedDuplicates > 0 || purgedRegistryAliases > 0) {
        existing.updatedAt = new Date().toISOString();
        changed = true;
        console.log(
          `[ShadowDistributedRouter] device alias synced by lastKnownIPs/serverId: ${previousServerId} -> ${
            systemFields.serverId
          }; matchedIPs=${
            matchedIPs.join(",") || "none"
          }; reportedIPs=${systemFields.lastKnownIPs.join(",")}`
        );
      }
    }

    if (changed || !fs.existsSync(DEVICE_ALIASES_PATH)) {
      this.saveDeviceAliases();
    }
  }

  watchDeviceAliasesWithChokidar() {
    if (this.aliasWatcher) return;

    this.aliasWatcher = chokidar.watch(DEVICE_ALIASES_PATH, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const reloadAliases = () => {
      try {
        this.loadDeviceAliases();
        this.refreshShadowDistributedRouterPlaceholder();
        console.log("[ShadowDistributedRouter] device-aliases.json reloaded.");
      } catch (err) {
        console.warn(
          "[ShadowDistributedRouter] failed to reload device-aliases.json:",
          err.message
        );
      }
    };

    this.aliasWatcher.on("change", reloadAliases);
    this.aliasWatcher.on("add", reloadAliases);
    this.aliasWatcher.on("error", (err) => {
      console.warn(
        "[ShadowDistributedRouter] alias watcher error:",
        err.message
      );
    });
  }

  refreshShadowDistributedRouterPlaceholder() {
    if (!this.pluginManager?.staticPlaceholderValues) return;
    const usageText = this.generateDynamicUsageText();
    const value = { value: usageText, serverId: "local" };
    this.pluginManager.staticPlaceholderValues.set(SHADOW_PLACEHOLDER, value);
    this.pluginManager.staticPlaceholderValues.delete(
      "{{ShadowDistributedRouter}}"
    );
  }

  generateDynamicUsageText() {
    const lines = [
      "【ShadowDistributedRouter：分布式设备寻址规则】",
      "",
      "你可以在 tool_name 后追加 #设备别名，指定某台在线设备执行分布式插件。",
      "",
      "格式：",
      "tool_name:「始」插件名#设备别名「末」",
      "",
      "示例：",
      "tool_name:「始」FileOperator#盛世国际电脑「末」",
      "tool_name:「始」PowerShellExecutor#家里主机「末」",
      "",
      "规则：",
      "1. # 后必须使用下方在线设备列表中的“设备别名”。",
      "2. 如果目标工具是分布式插件，系统会路由到对应设备。",
      "3. 如果目标工具是服务器本地插件，系统会忽略 #设备别名，并正常执行本地工具。",
      "4. 如果不需要指定设备，直接使用原工具名。",
      "5. 不要使用 clientId、serverId、连接 ID 等内部字段作为设备名。",
      "",
      "当前在线设备：",
    ];

    const onlineDevices = (this.deviceAliases.devices || []).filter(
      (device) => device.enabled && getOnlineDeviceServerId(device)
    );

    if (onlineDevices.length === 0) {
      lines.push("- 暂无在线分布式设备");
      return lines.join("\n");
    }

    const displayNames = buildDisplayNames(onlineDevices);
    for (const device of onlineDevices) {
      const displayName =
        displayNames.get(device) || getPrimaryDeviceAlias(device);
      lines.push(`- ${displayName}`);
      lines.push(`  系统：${getDeviceOsSummary(device)}`);
      lines.push(`  主机名：${device.hostName || device.serverName || "未知"}`);
      lines.push(`  IP：${formatDeviceIps(device.lastKnownIPs)}`);
      if (device.note) lines.push(`  说明：${device.note}`);
      lines.push("  状态：在线");
      lines.push(`  更新时间：${formatTimestamp(device.updatedAt)}`);
    }

    return lines.join("\n");
  }
}

function markPatched(patched, original) {
  Object.defineProperty(patched, PATCH_FLAG, { value: true });
  Object.defineProperty(patched, ORIGINAL_FN, { value: original });
}

function captureRegisterTools(serverId, message) {
  const tools = message.data?.tools || message.tools || [];
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const toolName = tool?.name;
    if (!toolName || INTERNAL_TOOLS.has(toolName)) continue;

    if (!shadowRegistry.has(toolName)) {
      shadowRegistry.set(toolName, new Map());
    }

    shadowRegistry.get(toolName).set(serverId, {
      serverId,
      serverName: message.data?.serverName || null,
      manifest: tool,
      registeredAt: Date.now(),
    });

    console.log(
      `[ShadowDistributedRouter] captured: ${toolName} from ${
        message.data?.serverName || serverId
      } (${serverId})`
    );
  }
}

function captureReportIp(serverId, message) {
  const data = message.data || {};
  const serverName = data.serverName;
  if (serverName) registerServerAlias(serverName, serverId);

  serverInfoRegistry.set(serverId, {
    serverId,
    serverName: serverName || null,
    localIPs: normalizeIpList(data.localIPs || []),
    publicIP: normalizeIp(data.publicIP) || null,
    reportedAt: Date.now(),
  });
}

function findServerIdByReportedIp(ip) {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return null;

  const candidates = [];
  for (const [serverId, serverInfo] of serverInfoRegistry.entries()) {
    const reportedIps = normalizeIpList([
      ...(serverInfo.localIPs || []),
      serverInfo.publicIP,
    ]);
    if (reportedIps.includes(normalizedIp)) {
      candidates.push(serverId);
    }
  }

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    console.log(
      `[ShadowDistributedRouter] requestIp=${normalizedIp} matched multiple reported servers=${candidates.join(
        ","
      )}; keep original route`
    );
  }

  return null;
}

function createDefaultDeviceAliases() {
  return {
    devices: [],
  };
}

function loadDeviceAliasesFromDiskForMerge() {
  try {
    if (!fs.existsSync(DEVICE_ALIASES_PATH))
      return createDefaultDeviceAliases();
    return normalizeDeviceAliases(
      JSON.parse(fs.readFileSync(DEVICE_ALIASES_PATH, "utf8"))
    );
  } catch (err) {
    console.warn(
      "[ShadowDistributedRouter] failed to load device-aliases.json for merge:",
      err.message
    );
    return createDefaultDeviceAliases();
  }
}

function mergeUserOwnedDeviceFields(current, latestOnDisk) {
  const latestDevices = Array.isArray(latestOnDisk.devices)
    ? latestOnDisk.devices
    : [];

  for (const device of current.devices || []) {
    const latest = findMatchingDeviceForSystemFields(
      latestDevices,
      device.serverId,
      {
        hostName: device.hostName,
        serverName: device.serverName,
        lastKnownIPs: device.lastKnownIPs || [],
      }
    );
    if (!latest || latest === false) continue;

    const currentUserFields = getUserOwnedDeviceFields(device);
    const latestUserFields = getUserOwnedDeviceFields(latest);
    device.friendlyNames = preferNonEmptyStringList(
      latestUserFields.friendlyNames,
      currentUserFields.friendlyNames
    );
    device.note = preferNonEmptyString(
      latestUserFields.note,
      currentUserFields.note
    );
    device.username = preferNonEmptyString(
      latestUserFields.username,
      currentUserFields.username
    );
    device.enabled = latestUserFields.enabled;
  }

  return current;
}

function normalizeDeviceAliases(value) {
  const normalized =
    value && typeof value === "object"
      ? { ...value }
      : createDefaultDeviceAliases();
  delete normalized.vectorRoute;
  normalized.devices = Array.isArray(normalized.devices)
    ? normalized.devices
    : [];
  normalized.devices = normalized.devices
    .filter((device) => device && typeof device === "object")
    .map((device) => {
      const userFields = getUserOwnedDeviceFields(device);
      const serverId = device.serverId ? String(device.serverId) : "";
      const hostName = device.hostName
        ? String(device.hostName)
        : serverId || "";
      const serverName = device.serverName
        ? String(device.serverName)
        : serverId || hostName || "";
      return {
        ...(serverId ? { serverId } : {}),
        ...userFields,
        hostName,
        serverName,
        lastKnownIPs: normalizeIpList(device.lastKnownIPs || []),
        autoGenerated: device.autoGenerated === true,
        updatedAt: device.updatedAt || new Date().toISOString(),
      };
    })
    .filter((device) =>
      Boolean(
        device.serverId ||
          device.hostName ||
          device.serverName ||
          device.lastKnownIPs.length > 0 ||
          device.friendlyNames.length > 0 ||
          device.note ||
          device.username
      )
    );
  return normalized;
}

function getUserOwnedDeviceFields(device) {
  return {
    friendlyNames: normalizeStringList(
      device.friendlyNames ||
        device.friendlyName ||
        device.aliases ||
        device.alias ||
        []
    ),
    note: device.note ? String(device.note) : "",
    username: device.username ? String(device.username) : "",
    enabled: device.enabled !== false,
  };
}

function preferNonEmptyStringList(primary, fallback) {
  const primaryList = normalizeStringList(primary || []);
  if (primaryList.length > 0) return primaryList;
  return normalizeStringList(fallback || []);
}

function preferNonEmptyString(primary, fallback) {
  const primaryText = primary ? String(primary) : "";
  if (primaryText.trim() !== "") return primaryText;
  return fallback ? String(fallback) : "";
}

function collectKnownServerIds() {
  const serverIds = new Set();
  for (const [, instances] of shadowRegistry) {
    for (const [serverId] of instances) {
      serverIds.add(serverId);
    }
  }
  for (const serverId of serverInfoRegistry.keys()) {
    serverIds.add(serverId);
  }
  return Array.from(serverIds).filter(Boolean);
}

function getSystemDeviceFields(serverId) {
  const serverInfo = serverInfoRegistry.get(serverId) || {};
  const registryServerNames = [];

  for (const [, instances] of shadowRegistry) {
    const record = instances.get(serverId);
    if (record?.serverName) registryServerNames.push(record.serverName);
  }

  const serverName =
    serverInfo.serverName || registryServerNames.find(Boolean) || serverId;
  const lastKnownIPs = normalizeIpList(
    [...(serverInfo.localIPs || []), serverInfo.publicIP].filter(Boolean)
  );

  return {
    serverId,
    hostName: serverName || serverId,
    serverName,
    lastKnownIPs,
  };
}

function findMatchingDeviceForSystemFields(devices, serverId, systemFields) {
  if (!Array.isArray(devices)) return null;

  const systemIps = new Set(normalizeIpList(systemFields.lastKnownIPs || []));
  if (systemIps.size > 0) {
    const lastKnownIpCandidates = devices.filter((device) =>
      normalizeIpList(device.lastKnownIPs || []).some((ip) => systemIps.has(ip))
    );

    if (lastKnownIpCandidates.length === 1) return lastKnownIpCandidates[0];

    if (lastKnownIpCandidates.length > 1) {
      console.warn(
        `[ShadowDistributedRouter] lastKnownIPs device match ambiguous for serverId=${serverId}; matched=${lastKnownIpCandidates
          .map(
            (device) =>
              `${device.serverId || "<no-serverId>"}:${normalizeIpList(
                device.lastKnownIPs || []
              ).join("|")}`
          )
          .join(
            ","
          )}. Skipping alias sync for this serverId to avoid merging devices.`
      );
      return false;
    }
  }

  const exact = devices.find(
    (device) => device.serverId && device.serverId === serverId
  );
  if (exact) return exact;

  const hostNameCandidates = findHostNameCandidates(devices, systemFields);
  if (hostNameCandidates.length === 1) return hostNameCandidates[0];
  if (hostNameCandidates.length > 1) {
    console.warn(
      `[ShadowDistributedRouter] hostName device match ambiguous for serverId=${serverId}; matched=${hostNameCandidates
        .map((device) => device.hostName || device.serverName || "<unknown>")
        .join(
          ","
        )}. Skipping alias sync for this serverId to avoid merging devices.`
    );
    return false;
  }

  return null;
}
function findHostNameCandidates(devices, systemFields) {
  const systemNames = new Set(
    normalizeStringList([systemFields?.hostName, systemFields?.serverName]).map(
      normalizeAliasForExactMatch
    )
  );
  systemNames.delete("");
  if (systemNames.size === 0) return [];

  return devices.filter((device) => {
    if (!device || device.serverId) return false;
    const deviceNames = normalizeStringList([
      device.hostName,
      device.serverName,
    ]).map(normalizeAliasForExactMatch);
    return deviceNames.some((name) => systemNames.has(name));
  });
}
function shouldBootstrapDeviceAliases(devices) {
  return !Array.isArray(devices) || devices.length === 0;
}

function createAutoGeneratedDevice(systemFields) {
  return {
    ...systemFields,
    friendlyNames: [],
    username: "",
    note: "",
    enabled: true,
    autoGenerated: true,
    updatedAt: new Date().toISOString(),
  };
}

function purgeStaleServerIdentity(previousServerId, currentServerId) {
  if (
    !previousServerId ||
    !currentServerId ||
    previousServerId === currentServerId
  ) {
    return 0;
  }

  let purged = 0;
  if (serverInfoRegistry.delete(previousServerId)) purged++;

  for (const [, instances] of shadowRegistry) {
    if (instances.delete(previousServerId)) purged++;
  }

  serverAliases.delete(previousServerId);
  for (const [alias, canonical] of Array.from(serverAliases.entries())) {
    if (canonical === previousServerId) serverAliases.delete(alias);
  }

  if (purged > 0) {
    console.log(
      `[ShadowDistributedRouter] purged stale server identity ${previousServerId} after remapping to ${currentServerId}`
    );
  }

  return purged;
}

function removeBlankAutoGeneratedDuplicateDevices(
  devices,
  keepDevice,
  serverId
) {
  if (!Array.isArray(devices) || !keepDevice || !serverId) return 0;

  let removed = 0;
  for (let i = devices.length - 1; i >= 0; i--) {
    const device = devices[i];
    if (device === keepDevice) continue;
    if (device.serverId !== serverId) continue;
    if (!isBlankAutoGeneratedDevice(device)) continue;

    devices.splice(i, 1);
    removed++;
  }

  if (removed > 0) {
    console.log(
      `[ShadowDistributedRouter] removed ${removed} blank duplicate device alias entr${
        removed === 1 ? "y" : "ies"
      } for serverId=${serverId}`
    );
  }

  return removed;
}

function isBlankAutoGeneratedDevice(device) {
  if (!device || typeof device !== "object") return false;
  const friendlyNames = Array.isArray(device.friendlyNames)
    ? device.friendlyNames.filter(Boolean)
    : [];
  const note = device.note ? String(device.note).trim() : "";
  const username = device.username ? String(device.username).trim() : "";

  return (
    device.autoGenerated !== false &&
    friendlyNames.length === 0 &&
    note === "" &&
    username === ""
  );
}

function hasOnlineServer(serverId) {
  if (!serverId) return false;
  if (serverInfoRegistry.has(serverId)) return true;
  for (const [, instances] of shadowRegistry) {
    if (instances.has(serverId)) return true;
  }
  return false;
}

function getOnlineDeviceServerId(device) {
  if (!device || device.enabled === false) return null;
  if (device.serverId && hasOnlineServer(device.serverId))
    return device.serverId;

  const match = findMatchingDeviceForSystemFields(
    onlineRuntimeDevices(),
    null,
    {
      hostName: device.hostName,
      serverName: device.serverName,
      lastKnownIPs: device.lastKnownIPs || [],
    }
  );
  if (!match || match === false || !match.serverId) return null;
  return match.serverId;
}

function onlineRuntimeDevices() {
  return collectKnownServerIds().map((serverId) =>
    createAutoGeneratedDevice(getSystemDeviceFields(serverId))
  );
}

function findDeviceByServerId(devices, serverId) {
  return (devices || []).find((device) => device.serverId === serverId) || null;
}

function getPrimaryDeviceAlias(device) {
  const friendlyNames = Array.isArray(device?.friendlyNames)
    ? device.friendlyNames.filter(Boolean)
    : [];
  return (
    friendlyNames[0] || device?.hostName || device?.serverName || "未知设备"
  );
}

function listOnlineDeviceAliases(devices) {
  const names = (devices || [])
    .filter((device) => device.enabled && getOnlineDeviceServerId(device))
    .map(getPrimaryDeviceAlias)
    .filter(Boolean);
  return names.length > 0 ? names.join("、") : "无";
}

function formatDeviceCandidate(device) {
  return `${getPrimaryDeviceAlias(device)}（主机名：${
    device.hostName || "未知"
  }，IP：${formatDeviceIps(device.lastKnownIPs)}）`;
}

function buildDisplayNames(devices) {
  const counts = new Map();
  const displayNames = new Map();
  for (const device of devices) {
    const base = getPrimaryDeviceAlias(device);
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    displayNames.set(device, count === 1 ? base : `${base}（${count}）`);
  }
  return displayNames;
}

function formatDeviceIps(ips) {
  const list = normalizeIpList(ips || []);
  return list.length > 0 ? list.join(" / ") : "未知";
}

function getDeviceOsSummary(device) {
  return device.os || device.platform || device.system || "未知";
}

function formatTimestamp(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resolveLocalhostTargetServerId(
  toolName,
  instances,
  originalServerId,
  requestIp
) {
  const localIps = getLocalNonInternalIPv4Addresses();
  if (localIps.size === 0) {
    console.log(
      `[ShadowDistributedRouter] fallback ${toolName}: localhost requestIp=${requestIp}, no local non-internal IPv4 addresses found`
    );
    return originalServerId;
  }

  const candidates = [];
  for (const [serverId] of instances) {
    const serverInfo = serverInfoRegistry.get(serverId);
    if (!serverInfo || !Array.isArray(serverInfo.localIPs)) continue;

    const matchedIps = serverInfo.localIPs.filter((ip) => localIps.has(ip));
    if (matchedIps.length > 0) {
      candidates.push({ serverId, matchedIps });
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    console.log(
      `[ShadowDistributedRouter] localhost route ${toolName}: requestIp=${requestIp} target=${
        candidate.serverId
      } matchedLocalIPs=${candidate.matchedIps.join(",")}`
    );
    return candidate.serverId;
  }

  if (candidates.length > 1) {
    console.log(
      `[ShadowDistributedRouter] fallback ${toolName}: localhost requestIp=${requestIp} matched multiple local candidates=${candidates
        .map((c) => c.serverId)
        .join(",")}`
    );
    return originalServerId;
  }

  console.log(
    `[ShadowDistributedRouter] fallback ${toolName}: localhost requestIp=${requestIp}, no local candidate has matching IPs`
  );
  return originalServerId;
}

function getLocalNonInternalIPv4Addresses() {
  const addresses = new Set();
  const networkInterfaces = os.networkInterfaces();

  for (const interfaces of Object.values(networkInterfaces)) {
    if (!Array.isArray(interfaces)) continue;

    for (const iface of interfaces) {
      if (
        iface &&
        iface.family === "IPv4" &&
        !iface.internal &&
        iface.address
      ) {
        addresses.add(normalizeIp(iface.address));
      }
    }
  }

  return addresses;
}

function isLocalhostAddress(ip) {
  const normalized = normalizeIp(ip);
  return LOCALHOST_ADDRESSES.has(normalized);
}
function normalizeIpList(ips) {
  const values = Array.isArray(ips) ? ips : [ips];
  return values.map(normalizeIp).filter(Boolean);
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter(Boolean);
}

function intersectIpLists(a, b) {
  const bSet = new Set(normalizeIpList(b));
  return normalizeIpList(a).filter((ip) => bSet.has(ip));
}

function normalizeIp(ip) {
  if (!ip) return null;
  const normalized = String(ip)
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");
  return normalized || null;
}

function parseToolNameWithAlias(toolName) {
  const text = String(toolName || "");
  const idx = text.lastIndexOf("#");
  if (idx === -1) {
    return { rawToolName: text.trim(), deviceAlias: null };
  }
  return {
    rawToolName: text.slice(0, idx).trim(),
    deviceAlias: text.slice(idx + 1).trim() || null,
  };
}

function normalizeAliasForExactMatch(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function mergeUniqueStrings(a, b) {
  return Array.from(
    new Set(
      [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
        .filter(Boolean)
        .map(String)
    )
  );
}

function registerServerAlias(alias, serverId) {
  if (!alias || !serverId) return;
  serverAliases.set(alias, serverId);
}

function resolveServerAlias(serverIdOrName) {
  return serverAliases.get(serverIdOrName) || serverIdOrName;
}

module.exports = new ShadowDistributedRouter();
