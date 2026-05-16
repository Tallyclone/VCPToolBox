"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const {
  getEmbeddingsBatch,
  cosineSimilarity,
} = require("../../EmbeddingUtils");

let requestContext = new AsyncLocalStorage();
const shadowRegistry = new Map(); // toolName -> Map<serverId, record>
const serverAliases = new Map(); // serverId/serverName -> canonical serverId
const serverInfoRegistry = new Map(); // serverId -> { serverName, localIPs, publicIP, reportedAt }

const PATCH_FLAG = Symbol.for("ShadowDistributedRouter.patched");
const ORIGINAL_FN = Symbol.for("ShadowDistributedRouter.original");
const INTERNAL_TOOLS = new Set(["internal_request_file"]);
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);
const DEVICE_ALIASES_PATH = path.join(__dirname, "device-aliases.json");
const DEFAULT_VECTOR_ROUTE_CONFIG = Object.freeze({
  enabled: true,
  threshold: 0.72,
  ambiguousMargin: 0.08,
  maxUserTextLength: 1000,
  preferRagCache: true,
  fallbackToEmbeddingUtils: true,
  debug: true,
});

let installed = false;

class ShadowDistributedRouter {
  constructor() {
    this.name = "ShadowDistributedRouter";
    this.patchRecords = [];
    this.pluginManager = null;
    this.deviceAliases = createDefaultDeviceAliases();
    this.vectorRouteConfig = { ...DEFAULT_VECTOR_ROUTE_CONFIG };
    this.aliasVectorIndex = [];
    this.aliasIndexBuildPromise = null;
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
    await this.syncDeviceAliasesAndRebuildIndex();

    const patchedHandle = this.patchHandleDistributedServerMessage(wss);
    const patchedProcess = this.patchProcessToolCall(this.pluginManager);
    const patchedDistributedExecute = this.patchExecuteDistributedTool(wss);
    const patchedToolExecutor = this.patchToolExecutorExecute();

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
      "[ShadowDistributedRouter] initialized. Session-affinity + vector intent routing active."
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
    this.pluginManager = null;
    this.aliasVectorIndex = [];
    this.aliasIndexBuildPromise = null;
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
      let routeContext = null;

      try {
        const userText = getLastRealUserText(contextMessages);
        if (userText) {
          const maxLength = getSafeMaxUserTextLength(
            self.vectorRouteConfig.maxUserTextLength
          );
          const clippedUserText = userText.slice(0, maxLength);
          routeContext = {
            userText: clippedUserText,
            userVector: null,
            createdAt: Date.now(),
          };

          try {
            const vectors = await self.embedTexts(
              [clippedUserText],
              this.pluginManager
            );
            routeContext.userVector = vectors?.[0] || null;
          } catch (err) {
            console.warn(
              "[ShadowDistributedRouter] build user vector failed:",
              err.message
            );
          }

          if (self.vectorRouteConfig.debug) {
            console.log(
              `[ShadowVectorRoute] userText: ${clippedUserText.slice(0, 120)}`
            );
          }
        }
      } catch (err) {
        console.warn(
          "[ShadowDistributedRouter] build routeContext failed:",
          err.message
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
          original.call(this, toolCall, clientIp, contextMessages, ...rest)
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

    const vectorTarget = this.resolveVectorRouteTarget(
      toolName,
      store?.routeContext
    );
    if (vectorTarget) {
      return vectorTarget;
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

  resolveVectorRouteTarget(toolName, routeContext) {
    const config = this.vectorRouteConfig;
    if (!config.enabled) return null;
    if (!routeContext?.userText) return null;

    const instances = shadowRegistry.get(toolName);
    if (!instances || instances.size === 0) return null;

    const exact = this.resolveExactAliasTarget(toolName, routeContext.userText);
    if (exact) return exact;

    if (!routeContext.userVector) {
      this.debugVectorRoute("rejected: no user vector");
      return null;
    }

    if (
      !Array.isArray(this.aliasVectorIndex) ||
      this.aliasVectorIndex.length === 0
    ) {
      this.debugVectorRoute("rejected: alias vector index empty");
      return null;
    }

    const scored = this.aliasVectorIndex
      .filter((item) => item.vector && instances.has(item.serverId))
      .map((item) => ({
        ...item,
        score: cosineSimilarity(routeContext.userVector, item.vector),
      }))
      .sort((a, b) => b.score - a.score);

    const top1 = scored[0];
    const top2 = scored[1];
    if (!top1) return null;

    this.debugVectorRoute(
      `vector top1: ${top1.serverId} score=${top1.score.toFixed(
        3
      )} aliasText=${top1.aliasText.slice(0, 80)}`
    );

    if (top1.score < config.threshold) {
      this.debugVectorRoute(
        `rejected: score below threshold ${top1.score.toFixed(3)} < ${
          config.threshold
        }`
      );
      return null;
    }

    if (top2 && top1.score - top2.score < config.ambiguousMargin) {
      this.debugVectorRoute(
        `rejected: ambiguous top1=${top1.score.toFixed(
          3
        )} top2=${top2.score.toFixed(3)} margin=${config.ambiguousMargin}`
      );
      return null;
    }

    if (!instances.has(top1.serverId)) {
      this.debugVectorRoute(
        `rejected: target device ${top1.serverId} has no tool ${toolName}`
      );
      return null;
    }

    this.debugVectorRoute(
      `vector route hit: ${top1.serverId} score=${top1.score.toFixed(3)}`
    );
    return top1.serverId;
  }

  resolveExactAliasTarget(toolName, userText) {
    const instances = shadowRegistry.get(toolName);
    if (!instances) return null;

    const normalizedUserText = normalizeText(userText);
    const matches = [];

    for (const device of this.deviceAliases.devices || []) {
      if (!device.enabled) continue;
      if (!instances.has(device.serverId)) continue;

      for (const alias of device.friendlyNames || []) {
        const normalizedAlias = normalizeText(alias);
        if (normalizedAlias && normalizedUserText.includes(normalizedAlias)) {
          matches.push({
            serverId: device.serverId,
            alias,
            normalizedAlias,
            length: normalizedAlias.length,
          });
        }
      }
    }

    if (matches.length === 0) return null;

    matches.sort((a, b) => b.length - a.length);
    const bestLength = matches[0].length;
    const bestMatches = matches.filter((match) => match.length === bestLength);
    const bestServerIds = new Set(bestMatches.map((match) => match.serverId));

    if (bestServerIds.size > 1) {
      this.debugVectorRoute(
        `rejected: exact alias ambiguous aliases=${bestMatches
          .map((match) => `${match.alias}->${match.serverId}`)
          .join(",")}`
      );
      return null;
    }

    const best = bestMatches[0];
    this.debugVectorRoute(`exact alias hit: ${best.alias} -> ${best.serverId}`);
    return best.serverId;
  }

  captureDistributedServerMessage(serverId, message) {
    if (!serverId || !message) return;

    registerServerAlias(serverId, serverId);

    if (message.type === "register_tools") {
      const serverName = message.data?.serverName;
      if (serverName) registerServerAlias(serverName, serverId);
      captureRegisterTools(serverId, message);
      this.syncDeviceAliasesAndRebuildIndex().catch((err) => {
        console.warn(
          "[ShadowDistributedRouter] device alias sync failed:",
          err.message
        );
      });
      return;
    }

    if (message.type === "report_ip") {
      captureReportIp(serverId, message);
      this.syncDeviceAliasesAndRebuildIndex().catch((err) => {
        console.warn(
          "[ShadowDistributedRouter] device alias sync failed:",
          err.message
        );
      });
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
      this.vectorRouteConfig = {
        ...DEFAULT_VECTOR_ROUTE_CONFIG,
        ...(this.deviceAliases.vectorRoute || {}),
      };
    } catch (err) {
      console.warn(
        "[ShadowDistributedRouter] failed to load device-aliases.json, using defaults:",
        err.message
      );
      this.deviceAliases = createDefaultDeviceAliases();
      this.vectorRouteConfig = { ...DEFAULT_VECTOR_ROUTE_CONFIG };
    }
  }

  saveDeviceAliases() {
    const latestOnDisk = loadDeviceAliasesFromDiskForMerge();
    this.deviceAliases = mergeUserOwnedDeviceFields(
      normalizeDeviceAliases(this.deviceAliases),
      latestOnDisk
    );
    this.deviceAliases.vectorRoute = {
      ...DEFAULT_VECTOR_ROUTE_CONFIG,
      ...(latestOnDisk.vectorRoute || {}),
      ...(this.deviceAliases.vectorRoute || {}),
    };
    fs.writeFileSync(
      DEVICE_ALIASES_PATH,
      `${JSON.stringify(this.deviceAliases, null, 2)}\n`,
      "utf8"
    );
  }

  async syncDeviceAliasesAndRebuildIndex() {
    this.syncDeviceAliasesFromRegistries();
    await this.buildAliasVectorIndex();
  }

  syncDeviceAliasesFromRegistries() {
    this.deviceAliases = normalizeDeviceAliases(this.deviceAliases);
    this.vectorRouteConfig = {
      ...DEFAULT_VECTOR_ROUTE_CONFIG,
      ...(this.deviceAliases.vectorRoute || {}),
    };

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
        autoGenerated: true,
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

  async buildAliasVectorIndex() {
    if (!this.vectorRouteConfig.enabled) {
      this.aliasVectorIndex = [];
      return [];
    }

    if (this.aliasIndexBuildPromise) {
      return this.aliasIndexBuildPromise;
    }

    this.aliasIndexBuildPromise = (async () => {
      const devices = (this.deviceAliases.devices || []).filter(
        (device) => device.enabled
      );
      const items = devices
        .map((device) => ({
          device,
          serverId: device.serverId,
          aliasText: buildDeviceAliasText(device),
        }))
        .filter((item) => item.serverId && item.aliasText);

      if (items.length === 0) {
        this.aliasVectorIndex = [];
        return [];
      }

      try {
        const vectors = await this.embedTexts(
          items.map((item) => item.aliasText),
          this.pluginManager
        );
        this.aliasVectorIndex = items.map((item, index) => ({
          ...item,
          vector: vectors?.[index] || null,
        }));
        this.debugVectorRoute(
          `alias vector index built: ${
            this.aliasVectorIndex.filter((item) => item.vector).length
          }/${items.length}`
        );
      } catch (err) {
        this.aliasVectorIndex = [];
        console.warn(
          "[ShadowDistributedRouter] build alias vector index failed, fallback to old routing:",
          err.message
        );
      }

      return this.aliasVectorIndex;
    })();

    try {
      return await this.aliasIndexBuildPromise;
    } finally {
      this.aliasIndexBuildPromise = null;
    }
  }

  async embedTexts(texts, pluginManager) {
    const maxLength =
      Number(this.vectorRouteConfig.maxUserTextLength) ||
      DEFAULT_VECTOR_ROUTE_CONFIG.maxUserTextLength;
    const cleanTexts = texts.map((text) =>
      String(text || "").slice(0, maxLength)
    );
    if (cleanTexts.length === 0) return [];

    const ragPlugin =
      pluginManager?.messagePreprocessors?.get?.("RAGDiaryPlugin");
    if (
      this.vectorRouteConfig.preferRagCache &&
      ragPlugin &&
      typeof ragPlugin.getBatchEmbeddingsCached === "function"
    ) {
      try {
        return await ragPlugin.getBatchEmbeddingsCached(cleanTexts);
      } catch (err) {
        console.warn(
          "[ShadowDistributedRouter] RAG embedding cache failed:",
          err.message
        );
      }
    }

    if (!this.vectorRouteConfig.fallbackToEmbeddingUtils) {
      return new Array(cleanTexts.length).fill(null);
    }

    const embeddingConfig = {
      apiKey: process.env.API_KEY,
      apiUrl: process.env.API_URL,
      model:
        process.env.WhitelistEmbeddingModel || "google/gemini-embedding-001",
    };
    return getEmbeddingsBatch(cleanTexts, embeddingConfig);
  }

  debugVectorRoute(message) {
    if (this.vectorRouteConfig.debug) {
      console.log(`[ShadowVectorRoute] ${message}`);
    }
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
    vectorRoute: { ...DEFAULT_VECTOR_ROUTE_CONFIG },
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
      { lastKnownIPs: device.lastKnownIPs || [] }
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
    value && typeof value === "object" ? value : createDefaultDeviceAliases();
  normalized.vectorRoute = {
    ...DEFAULT_VECTOR_ROUTE_CONFIG,
    ...(normalized.vectorRoute || {}),
  };
  normalized.devices = Array.isArray(normalized.devices)
    ? normalized.devices
    : [];
  normalized.devices = normalized.devices
    .filter((device) => device && typeof device === "object" && device.serverId)
    .map((device) => {
      const userFields = getUserOwnedDeviceFields(device);
      return {
        serverId: String(device.serverId),
        ...userFields,
        hostName: device.hostName
          ? String(device.hostName)
          : String(device.serverId),
        serverName: device.serverName
          ? String(device.serverName)
          : String(device.serverId),
        lastKnownIPs: normalizeIpList(device.lastKnownIPs || []),
        autoGenerated: device.autoGenerated !== false,
        updatedAt: device.updatedAt || new Date().toISOString(),
      };
    });
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
              `${device.serverId}:${normalizeIpList(
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

  const exact = devices.find((device) => device.serverId === serverId);
  if (exact) return exact;

  return null;
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

function buildDeviceAliasText(device) {
  const lines = [];
  const friendlyNames = Array.isArray(device.friendlyNames)
    ? device.friendlyNames.filter(Boolean)
    : [];
  if (friendlyNames.length > 0)
    lines.push(`设备别名：${friendlyNames.join("、")}。`);
  if (device.hostName) lines.push(`主机名：${device.hostName}。`);
  if (device.serverName) lines.push(`服务器名：${device.serverName}。`);
  if (Array.isArray(device.lastKnownIPs) && device.lastKnownIPs.length > 0)
    lines.push(`IP：${device.lastKnownIPs.join("、")}。`);
  if (device.username) lines.push(`用户名：${device.username}。`);
  if (device.note) lines.push(`说明：${device.note}。`);
  return lines.join("\n").trim();
}

function getMessageTextContent(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;

  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  return "";
}

function getLastRealUserText(contextMessages = []) {
  if (!Array.isArray(contextMessages)) return "";

  for (let i = contextMessages.length - 1; i >= 0; i--) {
    const msg = contextMessages[i];
    if (msg?.role !== "user") continue;

    const content = getMessageTextContent(msg).trim();
    if (!content) continue;
    if (content.startsWith("<!-- VCP_TOOL_PAYLOAD -->")) continue;
    if (content.startsWith("[系统提示:]")) continue;
    if (content.startsWith("[系统邀请指令:]")) continue;

    return content;
  }

  return "";
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

function getSafeMaxUserTextLength(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_VECTOR_ROUTE_CONFIG.maxUserTextLength;
}

function normalizeText(text) {
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
