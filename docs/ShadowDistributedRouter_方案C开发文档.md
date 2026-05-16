# ShadowDistributedRouter 方案 C 开发文档

> 文档状态：方案定稿 / 待实现  
> 适用项目：VCPToolBox  
> 目标插件：ShadowDistributedRouter  
> 方案类型：本地服务端插件 / 运行时轻量包装 / 分布式工具会话亲和路由  
> 编写日期：2026-05-14  
> 参与讨论：墨行、银染、Nova、小满、飞白

---

## 1. 背景

VCP 当前采用分布式插件系统。

当多台 VChat 同时连接同一个 VCPToolBox 服务端时，不同 VChat 会注册同名分布式工具，例如：

- `FileOperator`
- `PowerShellExecutor`
- `LocalSearchController`

现有 VCPToolBox 的主插件注册表以 `tool_name` 作为全局唯一 key。

因此，多台设备注册同名工具时，会出现以下问题：

1. 第一台设备注册成功；
2. 后续设备注册同名工具时，被核心注册逻辑跳过；
3. 模型提示词中仍然只看到一个工具；
4. 用户在 B 设备的 VChat 中发起工具调用时，实际可能调用到 A 设备的分布式插件；
5. 典型表现是：文件路径、磁盘、PowerShell 命令被路由到错误主机。

此前已出现过类似现象：

- 当前机器存在 `G:\`；
- 但 `FileOperator` 被路由到了另一台没有 `G:\` 的机器；
- 返回 `ENOENT`；
- 根因不是文件不存在，而是分布式工具路由到了错误设备。

---

## 2. 已确认源码事实

以下事实基于对 VCPToolBox 源码的阅读与讨论确认。

### 2.1 启动时序安全

`server.js` 中启动流程为：

```js
async function startServer() {
    await initialize();

    server = app.listen(port, () => {
        webSocketServer.initialize(server, ...);
    });
}
```

关键点：

1. `initialize()` 会先完成本地插件加载与初始化；
2. `app.listen(port)` 在本地插件初始化完成后才执行；
3. WebSocket 服务在 HTTP server listen 后才初始化；
4. 因此，即使 VChat 未关闭，在 VCPToolBox 重启后自动重连，也只能在本地插件初始化完成之后连接成功。

结论：

> 本地 `hybridservice` 插件在 `initialize()` 中安装 hook，时序上早于任何分布式 VChat 的 `register_tools` 消息。

---

### 2.2 分布式注册入口

`WebSocketServer.js` 中存在分布式消息处理函数：

```js
handleDistributedServerMessage(serverId, message)
```

当收到：

```js
message.type === "register_tools"
```

时，会调用：

```js
pluginManager.registerDistributedTools(serverId, externalTools)
```

---

### 2.3 主注册表同名处理

`PluginManager.registerDistributedTools(serverId, tools)` 中，主注册表以 `tool.name` 为唯一 key。

当发现同名工具已经存在时，后续同名工具不会进入主注册表，而是被跳过。

简化逻辑：

```js
if (this.plugins.has(toolManifest.name)) {
    continue;
}
```

结论：

> 不能依赖 VCP 主注册表保存多个同名分布式工具实例。

---

### 2.4 分布式执行出口

`WebSocketServer.js` 中存在分布式执行函数：

```js
executeDistributedTool(serverIdOrName, toolName, toolArgs, timeout)
```

其核心职责：

1. 根据 `serverIdOrName` 找到目标分布式连接；
2. 向对应 VChat 发送 `execute_tool` 消息；
3. 让目标 VChat 执行本地同名工具；
4. 等待并返回结果。

关键结论：

> 只要在执行出口把 `serverId` 替换为正确设备，即可让同名工具在正确 VChat 上执行。

---

### 2.5 请求来源 IP

`PluginManager.processToolCall` 签名已确认：

```js
async processToolCall(toolName, toolArgs, requestIp = null, sourceNode = null)
```

因此，可以通过轻包装 `processToolCall`，将当前请求的 `requestIp` 放入 `AsyncLocalStorage` 上下文中。

---

### 2.6 设备 IP 到 serverId 的映射

`WebSocketServer.js` 中已有类似能力：

```js
findServerByIp(ip)
```

该函数可用于根据请求来源 IP 找到对应分布式 VChat 的 `serverId`。

此外，VChat 连接后会通过 `report_ip` 上报设备信息，包括：

- `serverName`
- `localIPs`
- `publicIP`

这些信息可用于辅助定位设备。

---

## 3. 方案选择

经过讨论，否定以下路线：

### 3.1 方案 A：代理工具族

例如新增：

- `DeviceFileOperator`
- `DevicePowerShellExecutor`
- `DeviceSearchController`

缺点：

1. 需要修改提示词；
2. 需要调整每台 VChat 的工具暴露方式；
3. 初始工程量较大；
4. 与当前“不改提示词、不改客户端”的目标不完全一致。

结论：暂不采用。

---

### 3.2 原方案 B：重写核心注册与调用

即：

1. monkey patch `registerDistributedTools`
2. monkey patch `processToolCall`
3. 让主注册表支持多实例

缺点：

1. 侵入核心注册逻辑；
2. 与 VCP 内部实现耦合较深；
3. 一旦 VCP 主注册逻辑变化，维护成本较高。

结论：不作为首选。

---

### 3.3 最终方案 C：影子注册表 + 分布式执行跳板

采用。

核心思想：

1. 不改变 VCP 主注册表的一维唯一逻辑；
2. 不阻止同名工具被主注册表跳过；
3. 通过旁路监听 `register_tools`，在插件内部维护完整的多设备影子注册表；
4. 在最终分布式执行出口 `executeDistributedTool` 处，根据当前请求来源 IP 找到当前 VChat 所属 `serverId`；
5. 如果该设备注册过目标同名工具，则把执行目标改为当前设备；
6. 否则退回 VCP 原始逻辑。

---

## 4. 第一版目标

第一版只实现最小闭环。

### 4.1 目标

在多台 VChat 同时在线时：

- 从电脑 A 的 VChat 发起 `FileOperator` 调用，执行电脑 A 的 `FileOperator`；
- 从电脑 B 的 VChat 发起 `FileOperator` 调用，执行电脑 B 的 `FileOperator`；
- 对 `PowerShellExecutor` 等其他同名分布式工具同理；
- 不修改提示词；
- 不修改 VChat 客户端；
- 不修改 VCPToolBox 源码；
- 只新增一个本地服务端插件。

### 4.2 非目标

第一版不做以下内容：

1. 不做盘符能力匹配；
2. 不做复杂设备选择；
3. 不做最近活跃路由；
4. 不做用户显式设备选择；
5. 不做 canonical healing；
6. 不改变 VCP 主注册表结构；
7. 不让模型看到多个同名工具实例。

---

## 5. 插件名称与目录建议

插件名：

```txt
ShadowDistributedRouter
```

建议目录：

```txt
VCPToolBox/
└─ Plugin/
   └─ ShadowDistributedRouter/
      ├─ plugin.json
      └─ ShadowDistributedRouter.js
```

---

## 6. 插件类型

建议使用：

```json
{
  "name": "ShadowDistributedRouter",
  "type": "hybridservice",
  "protocol": "direct"
}
```

原因：

1. 需要常驻内存；
2. 需要在服务端启动期间安装 hook；
3. 需要早于 VChat 分布式注册消息执行；
4. 不需要直接暴露给模型调用。

---

## 7. 核心数据结构

### 7.1 影子注册表

```js
const shadowRegistry = new Map();
```

结构：

```txt
toolName -> Map<serverId, record>
```

示例：

```js
shadowRegistry = {
  "FileOperator": {
    "server_A": {
      serverId: "server_A",
      manifest: { name: "FileOperator", ... },
      registeredAt: 1778750000000
    },
    "server_B": {
      serverId: "server_B",
      manifest: { name: "FileOperator", ... },
      registeredAt: 1778750005000
    }
  }
}
```

用途：

- 保存所有设备上报的同名工具；
- 即使主注册表跳过后来的工具，影子表仍保留它；
- 执行时判断当前来源设备是否拥有该工具。

---

### 7.2 请求上下文

使用 Node.js `AsyncLocalStorage`：

```js
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();
```

上下文结构：

```js
{
  requestIp: "192.168.1.23",
  sourceNode: null
}
```

用途：

- 在 `processToolCall` 调用周期中保存请求来源 IP；
- 让后续 `executeDistributedTool` 包装层可以读取本次请求来源。

---

## 8. Hook 点设计

第一版只包装三处。

---

### 8.1 包装 `handleDistributedServerMessage`

目标：

- 捕获所有 `register_tools`；
- 写入 `shadowRegistry`；
- 原始消息继续交给 VCP 原逻辑处理。

伪代码：

```js
const wss = require('../../WebSocketServer');

const originalHandleDistributedServerMessage = wss.handleDistributedServerMessage;

wss.handleDistributedServerMessage = async function patchedHandleDistributedServerMessage(serverId, message) {
  try {
    if (message && message.type === 'register_tools') {
      const tools = message.data?.tools || message.tools || [];

      for (const tool of tools) {
        const toolName = tool.name;
        if (!toolName) continue;

        if (!shadowRegistry.has(toolName)) {
          shadowRegistry.set(toolName, new Map());
        }

        shadowRegistry.get(toolName).set(serverId, {
          serverId,
          manifest: tool,
          registeredAt: Date.now()
        });
      }
    }
  } catch (err) {
    console.warn('[ShadowDistributedRouter] failed to record register_tools:', err);
  }

  return originalHandleDistributedServerMessage.call(this, serverId, message);
};
```

注意：

- 不阻止原始逻辑；
- 不改变原始 message；
- 不影响 VCP 原有注册行为。

---

### 8.2 包装 `processToolCall`

目标：

- 捕获第三参数 `requestIp`；
- 将其写入 `AsyncLocalStorage`；
- 不修改 `processToolCall` 业务逻辑。

伪代码：

```js
const pluginManager = require('../../Plugin');

const originalProcessToolCall = pluginManager.processToolCall;

pluginManager.processToolCall = async function patchedProcessToolCall(
  toolName,
  toolArgs,
  requestIp = null,
  sourceNode = null
) {
  return requestContext.run({ requestIp, sourceNode }, async () => {
    return originalProcessToolCall.call(
      this,
      toolName,
      toolArgs,
      requestIp,
      sourceNode
    );
  });
};
```

注意：

- 必须保持原函数参数完整透传；
- 不改变返回值；
- 不吞掉异常；
- 只注入上下文。

---

### 8.3 包装 `executeDistributedTool`

目标：

- 在真正下发到分布式 VChat 前，根据请求来源 IP 找到当前 VChat 的 `serverId`；
- 如果当前 VChat 注册过该工具，则改发给当前 VChat；
- 否则退回原始 `serverIdOrName`。

伪代码：

```js
const originalExecuteDistributedTool = wss.executeDistributedTool;

wss.executeDistributedTool = async function patchedExecuteDistributedTool(
  serverIdOrName,
  toolName,
  toolArgs,
  timeout
) {
  try {
    const targetServerId = resolveTargetServerId(
      serverIdOrName,
      toolName
    );

    if (targetServerId && targetServerId !== serverIdOrName) {
      console.log(
        `[ShadowDistributedRouter] route ${toolName}: ${serverIdOrName} -> ${targetServerId}`
      );

      return originalExecuteDistributedTool.call(
        this,
        targetServerId,
        toolName,
        toolArgs,
        timeout
      );
    }
  } catch (err) {
    console.warn('[ShadowDistributedRouter] routing failed, fallback to original:', err);
  }

  return originalExecuteDistributedTool.call(
    this,
    serverIdOrName,
    toolName,
    toolArgs,
    timeout
  );
};
```

---

## 9. 路由规则

第一版只保留一条核心规则：

> 哪台 VChat 发起请求，就调用哪台 VChat 上注册的同名分布式工具。

### 9.1 路由函数

```js
function resolveTargetServerId(originalServerId, toolName) {
  const store = requestContext.getStore();
  const requestIp = store?.requestIp;

  if (!requestIp) {
    return originalServerId;
  }

  if (!shadowRegistry.has(toolName)) {
    return originalServerId;
  }

  const sourceServerId = wss.findServerByIp?.(requestIp);

  if (!sourceServerId) {
    return originalServerId;
  }

  const instances = shadowRegistry.get(toolName);

  if (instances.has(sourceServerId)) {
    return sourceServerId;
  }

  return originalServerId;
}
```

### 9.2 兜底原则

任何不确定情况，全部退回原逻辑：

1. 没有 `requestIp`：退回原始 `serverIdOrName`；
2. `findServerByIp(requestIp)` 找不到设备：退回原始 `serverIdOrName`；
3. 当前来源设备没有注册该 `toolName`：退回原始 `serverIdOrName`；
4. 影子注册表不存在该工具：退回原始 `serverIdOrName`；
5. 路由插件自身异常：记录日志，退回原始逻辑。

原则：

> 路由插件只能修正路由，不能破坏原有工具调用。

---

## 10. IP 匹配注意事项

### 10.1 潜在问题

`requestIp` 和 VChat 上报的 `localIPs` 未必完全一致。

例如：

- 同机访问时可能是 `127.0.0.1` 或 `::1`；
- 局域网访问时可能是 `192.168.x.x`；
- 反向代理或远程部署时可能是公网 IP；
- IPv6 mapped IPv4 可能表现为 `::ffff:192.168.x.x`。

### 10.2 第一版处理

第一版优先使用 VCP 现有：

```js
wss.findServerByIp(requestIp)
```

同时在日志中记录匹配失败：

```js
console.log('[ShadowDistributedRouter] no server matched requestIp:', requestIp);
```

### 10.3 后续增强

如果 `findServerByIp` 在实际部署中匹配失败，再增加辅助表：

```txt
remoteAddress -> serverId
```

来源可以是 WebSocket 连接对象的：

```js
ws._socket.remoteAddress
```

但第一版不主动加入，避免扩大 hook 面。

---

## 11. 日志设计

### 11.1 插件启动

```txt
[ShadowDistributedRouter] initialized
[ShadowDistributedRouter] patched handleDistributedServerMessage
[ShadowDistributedRouter] patched processToolCall
[ShadowDistributedRouter] patched executeDistributedTool
```

### 11.2 捕获注册

```txt
[ShadowDistributedRouter] captured tool FileOperator from server DESKTOP-A
```

### 11.3 路由生效

```txt
[ShadowDistributedRouter] route FileOperator: original=DESKTOP-A target=DESKTOP-B requestIp=192.168.1.23
```

### 11.4 路由失败并兜底

```txt
[ShadowDistributedRouter] fallback FileOperator: reason=no_source_server requestIp=192.168.1.23
```

---

## 12. 完整实现骨架

```js
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();
const shadowRegistry = new Map();

let installed = false;

class ShadowDistributedRouter {
  constructor() {
    this.name = 'ShadowDistributedRouter';
  }

  async initialize(config = {}, dependencies = {}) {
    if (installed) {
      console.log('[ShadowDistributedRouter] already installed, skip');
      return;
    }

    installed = true;

    const wss = require('../../WebSocketServer');
    const pluginManager = require('../../Plugin');

    patchHandleDistributedServerMessage(wss);
    patchProcessToolCall(pluginManager);
    patchExecuteDistributedTool(wss);

    console.log('[ShadowDistributedRouter] initialized');
  }
}

function patchHandleDistributedServerMessage(wss) {
  if (!wss || typeof wss.handleDistributedServerMessage !== 'function') {
    throw new Error('WebSocketServer.handleDistributedServerMessage not found');
  }

  const original = wss.handleDistributedServerMessage;

  wss.handleDistributedServerMessage = async function patchedHandleDistributedServerMessage(serverId, message) {
    try {
      captureRegisterTools(serverId, message);
    } catch (err) {
      console.warn('[ShadowDistributedRouter] capture register_tools failed:', err);
    }

    return original.call(this, serverId, message);
  };

  console.log('[ShadowDistributedRouter] patched handleDistributedServerMessage');
}

function captureRegisterTools(serverId, message) {
  if (!message || message.type !== 'register_tools') return;

  const tools = message.data?.tools || message.tools || [];

  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const toolName = tool?.name;
    if (!toolName) continue;

    if (!shadowRegistry.has(toolName)) {
      shadowRegistry.set(toolName, new Map());
    }

    shadowRegistry.get(toolName).set(serverId, {
      serverId,
      manifest: tool,
      registeredAt: Date.now()
    });

    console.log(`[ShadowDistributedRouter] captured tool ${toolName} from ${serverId}`);
  }
}

function patchProcessToolCall(pluginManager) {
  if (!pluginManager || typeof pluginManager.processToolCall !== 'function') {
    throw new Error('PluginManager.processToolCall not found');
  }

  const original = pluginManager.processToolCall;

  pluginManager.processToolCall = async function patchedProcessToolCall(
    toolName,
    toolArgs,
    requestIp = null,
    sourceNode = null
  ) {
    return requestContext.run({ requestIp, sourceNode }, async () => {
      return original.call(
        this,
        toolName,
        toolArgs,
        requestIp,
        sourceNode
      );
    });
  };

  console.log('[ShadowDistributedRouter] patched processToolCall');
}

function patchExecuteDistributedTool(wss) {
  if (!wss || typeof wss.executeDistributedTool !== 'function') {
    throw new Error('WebSocketServer.executeDistributedTool not found');
  }

  const original = wss.executeDistributedTool;

  wss.executeDistributedTool = async function patchedExecuteDistributedTool(
    serverIdOrName,
    toolName,
    toolArgs,
    timeout
  ) {
    try {
      const targetServerId = resolveTargetServerId(wss, serverIdOrName, toolName);

      if (targetServerId && targetServerId !== serverIdOrName) {
        const store = requestContext.getStore();

        console.log(
          `[ShadowDistributedRouter] route ${toolName}: original=${serverIdOrName} target=${targetServerId} requestIp=${store?.requestIp || 'null'}`
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
      console.warn('[ShadowDistributedRouter] route failed, fallback:', err);
    }

    return original.call(
      this,
      serverIdOrName,
      toolName,
      toolArgs,
      timeout
    );
  };

  console.log('[ShadowDistributedRouter] patched executeDistributedTool');
}

function resolveTargetServerId(wss, originalServerId, toolName) {
  const store = requestContext.getStore();
  const requestIp = store?.requestIp;

  if (!requestIp) {
    return originalServerId;
  }

  const instances = shadowRegistry.get(toolName);
  if (!instances) {
    return originalServerId;
  }

  if (!wss || typeof wss.findServerByIp !== 'function') {
    return originalServerId;
  }

  const sourceServerId = wss.findServerByIp(requestIp);

  if (!sourceServerId) {
    console.log(
      `[ShadowDistributedRouter] fallback ${toolName}: no server matched requestIp=${requestIp}`
    );
    return originalServerId;
  }

  if (instances.has(sourceServerId)) {
    return sourceServerId;
  }

  console.log(
    `[ShadowDistributedRouter] fallback ${toolName}: source server ${sourceServerId} has no tool instance`
  );

  return originalServerId;
}

module.exports = ShadowDistributedRouter;
```

---

## 13. plugin.json 示例

具体字段需与 VCPToolBox 当前插件规范保持一致。建议形式如下：

```json
{
  "name": "ShadowDistributedRouter",
  "displayName": "Shadow Distributed Router",
  "version": "0.1.0",
  "description": "Routes distributed tools to the VChat device that initiated the request, using a shadow registry and session affinity.",
  "type": "hybridservice",
  "protocol": "direct",
  "main": "ShadowDistributedRouter.js",
  "enabled": true
}
```

如当前 VCP 插件规范字段不同，以现有插件的 `plugin.json` 为准调整。

---

## 14. 验收流程

### 14.1 环境

准备两台 VChat：

- 设备 A：`DESKTOP-A`
- 设备 B：`DESKTOP-B`

两台设备都启用同名分布式工具：

- `FileOperator`
- `PowerShellExecutor`

VCPToolBox 服务端安装并启用：

- `ShadowDistributedRouter`

---

### 14.2 启动顺序

1. 启动 VCPToolBox；
2. 启动或保持两台 VChat 在线；
3. 确认日志出现：

```txt
[ShadowDistributedRouter] initialized
[ShadowDistributedRouter] captured tool FileOperator from ...
```

---

### 14.3 测试一：设备 A 发起文件读取

在设备 A 的 VChat 中调用：

```txt
读取当前设备上一个只有 A 存在的文件
```

预期：

1. 日志显示 `requestIp` 匹配到设备 A；
2. `FileOperator` 路由到设备 A；
3. 文件读取成功；
4. 不会调用设备 B 的 `FileOperator`。

---

### 14.4 测试二：设备 B 发起文件读取

在设备 B 的 VChat 中调用同名工具：

```txt
读取当前设备上一个只有 B 存在的文件
```

预期：

1. 日志显示 `requestIp` 匹配到设备 B；
2. `FileOperator` 路由到设备 B；
3. 文件读取成功；
4. 不会调用设备 A 的 `FileOperator`。

---

### 14.5 测试三：PowerShellExecutor

分别在 A、B 两台 VChat 中执行：

```powershell
hostname
```

预期：

- A 的 VChat 返回 A 的主机名；
- B 的 VChat 返回 B 的主机名。

这是最直接的验收项。

---

### 14.6 测试四：兜底

制造一个无法匹配 `requestIp` 的场景。

预期：

1. 插件不报致命错误；
2. 工具调用退回 VCP 原始逻辑；
3. 日志出现 fallback；
4. 不影响系统正常运行。

---

## 15. 风险与边界

### 15.1 仍属于 Monkey Patch

虽然方案 C 不重写主注册逻辑，但仍然包装了运行时函数：

- `handleDistributedServerMessage`
- `processToolCall`
- `executeDistributedTool`

因此 VCPToolBox 后续升级时，需要检查这些函数签名是否变化。

---

### 15.2 IP 匹配可能有部署边界

如果 `requestIp` 与 VChat 上报 IP 不一致，`findServerByIp` 可能匹配失败。

表现：

- 插件捕获了影子注册；
- 但执行时无法找到来源 `serverId`；
- 于是退回原逻辑。

解决方向：

1. 增加 remoteAddress 反查表；
2. 增强 VChat 的 `report_ip` 上报；
3. 在 VChat 请求头或 WebSocket 会话中显式携带 client/server 标识。

第一版暂不做。

---

### 15.3 首个注册者离线时入口可能消失

如果主注册表中的 canonical owner 离线，VCP 原逻辑可能移除该工具。

即使影子表里还有其他设备，该工具也可能暂时不再出现在模型工具列表中。

第一版不处理。

后续 v1.1 可增加 canonical healing：

1. 包装 `unregisterAllDistributedTools(serverId)`；
2. 从影子表中移除离线 serverId；
3. 如果仍有其他在线实例，重新调用 `registerDistributedTools(newServerId, [manifest])` 扶正新实例；
4. 触发工具列表刷新。

---

## 16. 分阶段计划

### v0.1：最小可行版本

实现：

- 影子注册表；
- `register_tools` 捕获；
- `processToolCall` 请求上下文；
- `executeDistributedTool` 会话亲和路由；
- 日志；
- 全量 fallback。

不实现：

- canonical healing；
- 盘符能力匹配；
- 设备选择 UI；
- 远程地址反查增强。

---

### v0.2：IP 匹配增强

实现：

- requestIp 规范化；
- IPv6 mapped IPv4 处理；
- `127.0.0.1` / `::1` 同机映射；
- remoteAddress -> serverId 辅助表。

---

### v0.3：离线自愈

实现：

- 监听或包装分布式工具注销；
- canonical owner 离线后自动扶正其他在线实例；
- 刷新工具列表。

---

## 17. 最终结论

本方案以最小侵入方式解决 VCP 分布式同名插件路由错乱问题。

核心原则：

> VCP 主注册表继续保持一维唯一；  
> ShadowDistributedRouter 在影子表中保存所有同名实例；  
> 执行时根据请求来源 IP 找到当前 VChat 所属 serverId；  
> 哪台 VChat 发起请求，就调用哪台 VChat 的同名分布式工具。

第一版只解决“当前设备亲和执行”。

不追求复杂智能路由。

这使方案保持：

- 可实现；
- 可验证；
- 可回滚；
- 不污染提示词；
- 不修改客户端；
- 不修改 VCPToolBox 源码。