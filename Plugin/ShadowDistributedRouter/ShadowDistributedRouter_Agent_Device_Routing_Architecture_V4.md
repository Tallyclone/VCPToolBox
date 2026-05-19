# ShadowDistributedRouter Agent 自主设备路由架构实现文档 V4

日期：2026-05-17  
状态：讨论定稿 / 源码事实修正版  
范围：仅整理架构与实现方案，不修改代码。  
约束：不修改 `Plugin.js`、不修改 `chatCompletionHandler.js`、不修改其他插件实现。所有新增能力尽量收束在 `ShadowDistributedRouter` 插件内部。

---

## 0. V4 最终修正点

1. 动态占位符采用项目既有模式：`plugin-manifest.json` 声明 `systemPromptPlaceholders`，运行时由插件写入 `pluginManager.staticPlaceholderValues`，不动态修改 manifest。
2. 主占位符建议使用 `{{VCPShadowDistributedRouter}}`。如需迁移，可临时兼容 `{{ShadowDistributedRouter}}`。
3. 设备别名直接复用 `device-aliases.json` 的 `devices[*].friendlyNames`，不新增顶层 `aliases`，不维护 `displayAlias -> targetServerId/clientId` 持久映射。
4. 设备别名配置变更刷新采用 `chokidar` 监听 `Plugin/ShadowDistributedRouter/device-aliases.json`。
5. 明确删除用户自然语言向量化设备路由，清理或禁用 `vectorRoute`、`aliasVectorIndex`、`buildAliasVectorIndex()`、`resolveVectorRouteTarget()`、`routeContext.userVector` 等路径。
6. 占位符系统提示词只展示设备别名与系统摘要，不包含可用分布式插件清单。
7. `tool_name#设备别名` 必须在足够早的位置解析。当前 `ToolExecutor.execute()` 会先做 `getPlugin(name)` 校验，因此应优先在 `ShadowDistributedRouter` 已 patch 的 `ToolExecutor.prototype.execute` 链路中拆分，避免带 `#` 的工具名提前失败。

---

## 1. 背景与目标

当前 VCP 分布式插件体系已经具备：

1. 分布式客户端通过 WebSocket 注册远端工具；
2. `ShadowDistributedRouter` 维护分布式工具实例、设备别名、设备信息、来源亲和等路由数据；
3. VCP 插件说明可通过占位符进入模型上下文；
4. VCP 消息变量替换每轮执行，可动态注入更新后的占位符内容；
5. `device-aliases.json` 已包含设备配置与别名匹配基础，应复用。

目标：

> 让 Agent 能在看到在线设备列表后，通过 `tool_name#设备别名` 显式指定某台客户端执行分布式插件。

同时要求：

- 不修改核心源码；
- 不修改其他插件；
- 删除用户自然语言向量化设备路由；
- 保留并复用 `friendlyNames` 设备别名体系；
- 服务器本地插件与分布式插件对模型使用同一套 `#设备别名` 语法；
- 对模型隐藏 `clientId`、`serverId`、WebSocket 连接等内部细节；
- 占位符不展示可用分布式插件清单。

---

## 2. 已确认源码事实

### 2.1 消息变量 / 占位符替换机制

`chatCompletionHandler.js` 每轮构造消息后会调用：

```js
messageProcessor.replaceAgentVariables(
  newMessage.content,
  originalBody.model,
  msg.role,
  processingContext
);
```

`messageProcessor.replaceAgentVariables()` 会读取：

```js
pluginManager.getAllPlaceholderValues();
```

`Plugin.js` 中存在：

```js
pluginManager.getAllPlaceholderValues = function () { ... }
```

其值来源是 `staticPlaceholderValues`。因此只要 `staticPlaceholderValues` 中对应占位符的值被更新，下一轮模型上下文即可获得新内容。

### 2.2 动态占位符的项目惯例

项目中已有同类参考：`ChromeBridge`。

`ChromeBridge` 是 `hybridservice` + `direct` 插件，manifest 声明：

```json
"systemPromptPlaceholders": [
  {
    "placeholder": "{{VCPChromePageInfo}}",
    "description": "...",
    "isDynamic": true
  }
]
```

运行时直接更新：

```js
pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", markdown);
```

因此 `ShadowDistributedRouter` 也应采用：manifest 声明 + 运行时写 `pluginManager.staticPlaceholderValues`。不应动态修改 manifest，也不需要改成 static 插件。

### 2.3 `updateDistributedStaticPlaceholders()` 的适用边界

当前源码存在：

```js
PluginManager.updateDistributedStaticPlaceholders(
  serverId,
  serverName,
  placeholders
);
```

并由 `WebSocketServer` 的 `update_static_placeholders` 消息调用。

但 `ShadowDistributedRouter` 是本地 `hybridservice` 插件，其自身动态占位符不需要走该分布式上报接口，可直接写：

```js
pluginManager.staticPlaceholderValues.set(
  "{{VCPShadowDistributedRouter}}",
  usageText
);
```

或对象形式：

```js
pluginManager.staticPlaceholderValues.set("{{VCPShadowDistributedRouter}}", {
  value: usageText,
  serverId: "local",
});
```

具体格式与项目现有动态插件保持一致即可。

### 2.4 分布式插件识别依据

`ShadowDistributedRouter` 内部已有：

```js
shadowRegistry: Map<toolName, Map<serverId, record>>
serverInfoRegistry: Map<serverId, serverInfo>
```

可据此判断工具是否为分布式工具：

```js
function isDistributedTool(rawToolName) {
  const instances = shadowRegistry.get(rawToolName);
  return instances && instances.size > 0;
}
```

原则：

- `rawToolName` 在 `shadowRegistry` 中存在在线实例：视为分布式插件；
- 不存在：视为服务器本地插件；
- 不另建静态白名单，避免注册表漂移。

---

## 3. 总体架构

```text
感知层：ShadowDistributedRouter 动态更新自己的设备路由说明占位符
    ↓
表达层：模型使用 tool_name#设备别名 显式寻址
    ↓
路由层：ShadowDistributedRouter 解析 # 后缀，并根据 shadowRegistry + friendlyNames 路由
```

核心原则：

> 只有 ShadowDistributedRouter 理解“设备”。  
> 核心系统不理解设备。  
> 其他插件不理解设备。  
> 模型只看到设备别名与调用规则。

---

## 4. 为什么使用 `#` 而不是 `@`

曾讨论使用：

```text
tool_name@设备别名
```

但 VCP 体系中已有 `@` 相关语法与解析语义，例如 Agent mention、上下文引用、联想锚点或其他协议层用途。为避免 `tool_name` 字段在进入工具执行链路前被其他解析层误识别、截断、转义或抢占，最终改为：

```text
tool_name#设备别名
```

示例：

```text
FileOperator#盛世国际电脑
PowerShellExecutor#家里主机
LocalSearchController#卧室笔记本
```

---

## 5. 动态占位符说明机制

### 5.1 占位符名称

主占位符：

```text
{{VCPShadowDistributedRouter}}
```

过渡兼容占位符可选：

```text
{{ShadowDistributedRouter}}
```

新文档、新实现、新测试均以 `{{VCPShadowDistributedRouter}}` 为准。

### 5.2 manifest 声明

`ShadowDistributedRouter/plugin-manifest.json` 建议声明：

```json
"capabilities": {
  "systemPromptPlaceholders": [
    {
      "placeholder": "{{VCPShadowDistributedRouter}}",
      "description": "动态提供当前在线分布式设备、设备别名与 tool_name#设备别名 路由规则。",
      "isDynamic": true
    }
  ],
  "invocationCommands": []
}
```

manifest 只声明占位符能力，不存储在线设备状态。

### 5.3 运行时更新方式

当以下事件发生时，`ShadowDistributedRouter` 重新生成设备说明文本，并写入 `pluginManager.staticPlaceholderValues`：

- 服务启动初始化；
- 设备上线；
- 设备下线；
- 分布式工具注册变化；
- `device-aliases.json` 变更。

伪流程：

```text
设备状态变化 / 工具注册变化 / 别名配置变化 / 服务启动
    ↓
ShadowDistributedRouter.collectOnlineDevices()
    ↓
ShadowDistributedRouter.generateDynamicUsageText()
    ↓
pluginManager.staticPlaceholderValues.set("{{VCPShadowDistributedRouter}}", usageText)
    ↓
messageProcessor 下一轮替换 {{VCPShadowDistributedRouter}}
```

### 5.4 设备别名配置刷新

当前源码尚未实现对 `device-aliases.json` 的 `chokidar` 监听；V4 实现应新增该监听：

```text
Plugin/ShadowDistributedRouter/device-aliases.json
```

触发后应：

1. 重新读取并 normalize `device-aliases.json`；
2. 刷新设备说明占位符；
3. 刷新必要的非向量缓存；
4. 不触发定时兜底刷新。

### 5.5 注入内容模板

建议生成内容如下：

```text
【ShadowDistributedRouter：分布式设备寻址规则】

你可以在 tool_name 后追加 #设备别名，指定某台在线设备执行分布式插件。

格式：
tool_name:「始」插件名#设备别名「末」

示例：
tool_name:「始」FileOperator#盛世国际电脑「末」
tool_name:「始」PowerShellExecutor#家里主机「末」

规则：
1. # 后必须使用下方在线设备列表中的“设备别名”。
2. 如果目标工具是分布式插件，系统会路由到对应设备。
3. 如果目标工具是服务器本地插件，系统会忽略 #设备别名，并正常执行本地工具。
4. 如果不需要指定设备，直接使用原工具名。
5. 不要使用 clientId、serverId、连接 ID 等内部字段作为设备名。

当前在线设备：
- 盛世国际电脑
  系统：Windows 10
  主机名：DESKTOP-P23SB1E
  IP：192.168.x.x
  说明：主力工作站
  状态：在线
  更新时间：2026-05-17 12:00

- 家里主机
  系统：未知
  主机名：VCP-Desktop-Client-Distributed-Server
  IP：100.100.50.x / 192.168.x.x
  状态：在线
  更新时间：2026-05-17 12:00
```

### 5.6 不应暴露的信息

占位符中不应暴露：

- `clientId`；
- `serverId`；
- WebSocket 连接对象；
- session id；
- token；
- 内部路由表完整结构；
- 可用分布式插件清单。

模型只需要知道：

- 设备别名；
- 系统信息；
- 主机名；
- IP 的可读摘要；
- 在线状态；
- 更新时间。

---

## 6. 自定义设备别名配置

### 6.1 配置文件复用

复用现有配置文件：

```text
Plugin/ShadowDistributedRouter/device-aliases.json
```

复用其中：

```text
devices
```

不新增顶层：

```text
aliases
```

### 6.2 现有字段：friendlyNames

现状主字段为：

```text
friendlyNames
```

占位符展示与 `#设备别名` 解析应优先使用 `friendlyNames`。

示意结构：

```json
{
  "devices": [
    {
      "serverId": "xxx",
      "hostName": "DESKTOP-P23SB1E",
      "serverName": "VCP-Desktop-Client-Distributed-Server",
      "friendlyNames": ["盛世国际电脑"],
      "note": "主力工作站"
    }
  ]
}
```

### 6.3 兼容字段

`friendlyName` / `aliases` / `alias` 可作为向后兼容读取字段，但不是当前主路径。归一化后仍以 `friendlyNames` 作为唯一展示与匹配来源。

### 6.4 不维护 displayAlias 映射

V4 明确：

- 不新增独立 aliasMap；
- 不维护 `displayAlias -> targetServerId/clientId` 持久映射；
- 不改变 `device-aliases.json` 主结构；
- `friendlyNames` 是设备别名展示与解析的唯一主来源。

如果多个设备拥有相同 `friendlyNames` 主显示名：

```text
盛世国际电脑
盛世国际电脑
```

可在提示词展示层临时消歧，例如：

```text
盛世国际电脑
盛世国际电脑（2）
```

但这只是展示层临时标签，不写入配置，也不作为独立路由映射。解析 `#设备别名` 时仍回到 `friendlyNames` 精确匹配；如歧义无法消除，应返回可读错误并列出候选设备。

---

## 7. 系统信息获取

目标是在 `{{VCPShadowDistributedRouter}}` 的设备列表中尽量展示：

```text
系统 / platform / OS
主机名
IP / localIPs
在线状态
更新时间
```

不为系统信息修改其他插件。优先读取：

```text
shadowRegistry
serverInfoRegistry
分布式工具注册包
WebSocket 元数据
已有心跳 / 注册信息
device-aliases.json 的 devices 字段
```

缺失字段显示“未知”，不阻塞主功能。

原则：

> 系统信息是提示词增强，不是路由正确性的前置条件。

---

## 8. 删除旧逻辑：用户对话向量化显式调用

当前源码仍存在并启用自然语言向量化路由；V4 实现目标是删除或禁用：

```text
用户文本中出现某些设备描述
    ↓
向量化匹配设备别名
    ↓
自动推断本轮显式调用目标设备
```

同时删除 / 禁用相关实现路径：

- `vectorRoute` 配置；
- `aliasVectorIndex`；
- `buildAliasVectorIndex()`；
- `resolveVectorRouteTarget()`；
- `routeContext.userVector`；
- 任何用于设备显式寻址的向量检索缓存或分类结果。

原因：

1. 不够确定；
2. 容易误把讨论内容当成调用意图；
3. 与 `tool_name#设备别名` 显式协议重复；
4. 会制造多入口优先级混乱；
5. 与“只保留 friendlyNames 作为别名源”的目标冲突。

保留路由优先级：

```text
1. tool_name#设备别名
   - Agent 显式寻址
   - 最高优先级

2. 无 #
   - 走原有来源亲和 / 默认分布式路由逻辑
   - 不再走向量化设备推断
```

---

## 9. `tool_name#设备别名` 协议

### 9.1 语法

```text
tool_name#设备别名
```

示例：

```text
FileOperator#盛世国际电脑
PowerShellExecutor#家里主机
LocalSearchController#卧室笔记本
```

### 9.2 解析方式

```js
function parseToolNameWithAlias(toolName) {
  const idx = toolName.lastIndexOf("#");

  if (idx === -1) {
    return {
      rawToolName: toolName.trim(),
      deviceAlias: null,
    };
  }

  return {
    rawToolName: toolName.slice(0, idx).trim(),
    deviceAlias: toolName.slice(idx + 1).trim(),
  };
}
```

### 9.3 解析位置

应优先在 `ToolExecutor.prototype.execute` 的 patch 内解析。原因：当前 `ToolExecutor.execute()` 会先执行 `pluginManager.getPlugin(name)` 校验，带 `#` 的工具名若不先拆分，会在进入 `PluginManager.processToolCall()` 前失败。

推荐流程：

```text
收到 tool_name
    ↓
解析 #
    ↓
将 tool_name 改回 rawToolName
    ↓
将 deviceAlias 写入上下文 / routeContext
    ↓
后续分布式路由阶段读取 deviceAlias
```

不推荐新增全局 Monkey Patch。若现有 `ShadowDistributedRouter` 已 patch 必要入口，应在已有 patch 内扩展。

### 9.4 本地 / 远端同名工具处理

需要明确处理本地插件与远端分布式工具同名的情况：

- `rawToolName#alias` 如果 `alias` 指向远端设备，且 `shadowRegistry` 有该工具实例，则直接调用远端执行；
- 不应因本地同名插件存在就落到本地执行；
- 如果 `alias` 不存在或目标设备没有该工具，应返回可读错误；
- 只有当 `rawToolName` 不在 `shadowRegistry` 中或未带 `alias` 时，才按本地插件逻辑剥离 `alias` 后执行。

---

## 10. 本地插件与分布式插件统一语法

对模型统一说明：

```text
所有工具都可以写 tool_name#设备别名。
如果该工具不是分布式插件，系统会自动忽略 #设备别名。
```

内部执行逻辑：

```text
解析 rawToolName + deviceAlias
    ↓
判断 rawToolName 是否为分布式插件
    ↓
如果是分布式插件：
    根据 deviceAlias 定向路由
如果是服务器本地插件：
    丢弃 deviceAlias
    执行 rawToolName
```

示例：

```text
VSearch#盛世国际电脑
```

若 `VSearch` 是服务器本地插件：

```text
实际执行：VSearch
忽略设备别名：盛世国际电脑
```

该策略减少模型心智负担，避免模型必须判断工具类别。

---

## 11. 分布式路由决策

### 11.1 分布式插件判断

```js
function isDistributedTool(rawToolName) {
  const instances = shadowRegistry.get(rawToolName);
  return instances && instances.size > 0;
}
```

原则：

- `rawToolName` 在 `shadowRegistry` 中有在线实例：分布式插件；
- 否则：服务器本地插件；
- 不另建名单。

### 11.2 显式寻址

如果存在：

```text
deviceAlias != null
```

则：

```text
1. 仅用 friendlyNames / 现有别名匹配逻辑解析目标设备；
2. 找到 targetServerId / clientId；
3. 检查 rawToolName 在该设备是否有实例；
4. 有实例：定向路由；
5. 无实例：返回设备不支持该工具，或按配置决定回退。
```

注意：这里不使用 displayAlias，也不使用向量路由。显式寻址失败时不要静默随机路由，应返回可读错误。

### 11.3 无 `#` 的默认路由

无 `#` 时保留原有：

- 来源亲和；
- 默认设备选择；
- 现有分布式路由策略。

但删除用户对话向量化设备推断。

---

## 12. 错误处理与兜底

### 12.1 设备别名不存在

```text
设备别名“xxx”不存在。
当前在线设备：A、B、C。
```

### 12.2 设备离线

```text
设备“xxx”当前离线。
当前在线设备：A、B、C。
```

### 12.3 设备不支持目标工具

```text
设备“xxx”在线，但未注册工具“FileOperator”。
```

注意：占位符不展示可用分布式插件清单；错误信息可以在失败时按需生成支持该工具的候选设备，但不常驻注入提示词。

### 12.4 本地插件带 `#`

静默剥离别名并执行本地插件，可记录 debug 日志：

```text
[ShadowDistributedRouter] Ignored device alias "xxx" for local tool "VSearch".
```

---

## 13. 实现任务清单

### 13.1 保留 / 复用

- 现有 `device-aliases.json`；
- 现有 `devices` 字段；
- 现有 `friendlyNames` 字段；
- 现有自动匹配设备别名逻辑；
- 设备信息采集相关已有结构；
- `shadowRegistry`；
- 来源亲和 / 默认路由；
- 分布式工具实例查询；
- VCP 现有占位符更新机制；
- `chokidar` 文件监听能力。

### 13.2 新增 / 调整

1. `generateDynamicUsageText()`

   - 生成 `{{VCPShadowDistributedRouter}}` 展开文本；
   - 使用 `devices` / `friendlyNames`；
   - 不写入可用分布式插件清单。

2. `refreshShadowDistributedRouterPlaceholder()`

   - 直接写入 `pluginManager.staticPlaceholderValues`；
   - 在设备上下线、工具注册变化、别名配置变更、启动初始化时触发；
   - 不做定时兜底刷新。

3. `parseToolNameWithAlias(toolName)`

   - 解析 `tool_name#设备别名`。

4. `isDistributedTool(rawToolName)`

   - 基于 `shadowRegistry` 判断。

5. `routeWithExplicitAlias(rawToolName, deviceAlias, args)`

   - 显式路由到目标设备；
   - 只使用 `friendlyNames` 与现有系统字段；
   - 不维护 displayAlias 映射。

6. `watchDeviceAliasesWithChokidar()`
   - 监听 `device-aliases.json`；
   - 文件变更后刷新别名与提示词。

### 13.3 删除 / 禁用

- 用户对话向量化显式设备调用逻辑；
- 从用户自然语言中自动推断本轮显式设备目标的逻辑；
- `vectorRoute` 配置；
- `aliasVectorIndex`；
- `buildAliasVectorIndex()`；
- `resolveVectorRouteTarget()`；
- `routeContext.userVector`；
- `displayAlias -> targetServerId/clientId` 持久映射；
- 定时兜底刷新占位符说明。

---

## 14. 测试用例

### 14.1 动态占位符

1. 启动一台客户端；
2. 触发设备上线 / 工具注册事件；
3. 查看 `{{VCPShadowDistributedRouter}}` 展开内容；
4. 确认出现设备别名、系统摘要、在线状态；
5. 确认没有可用分布式插件清单；
6. 关闭客户端；
7. 触发设备下线事件；
8. 下一轮对话确认设备列表移除或标记离线。

### 14.2 自定义别名复用

1. 在 `device-aliases.json` 的 `devices` 字段中配置或确认：

   ```json
   {
     "devices": [
       {
         "hostName": "DESKTOP-P23SB1E",
         "friendlyNames": ["盛世国际电脑"]
       }
     ]
   }
   ```

2. 触发别名配置刷新；
3. 确认占位符中显示“盛世国际电脑”；
4. 确认 `FileOperator#盛世国际电脑` 可被解析；
5. 确认不存在 displayAlias 持久映射。

### 14.3 分布式插件显式路由

模型调用：

```text
tool_name:「始」FileOperator#盛世国际电脑「末」
```

期望：

```text
rawToolName = FileOperator
deviceAlias = 盛世国际电脑
路由到对应设备的 FileOperator
```

### 14.4 本地插件带 `#`

模型调用：

```text
tool_name:「始」VSearch#盛世国际电脑「末」
```

若 `VSearch` 是本地插件，期望：

```text
实际执行 VSearch
设备别名被忽略
不报错
```

### 14.5 别名不存在

```text
tool_name:「始」FileOperator#不存在的设备「末」
```

期望：返回可读错误，并列出当前在线设备。

### 14.6 系统信息缺失

如果设备缺少系统信息字段，期望：

```text
系统：未知
```

主路由功能不受影响。

### 14.7 向量化路由已删除

1. 确认不再保留向量路由为主方案；
2. 确认 `vectorRoute`、`aliasVectorIndex`、`resolveVectorRouteTarget()` 等均删除或禁用；
3. 确认无 `#` 时仍能走原有默认路由，但不触发设备语义向量推断。

---

## 15. 最终结论

最终方案：

```text
ShadowDistributedRouter 负责：
1. 动态更新自己的占位符说明；
2. 复用现有 device-aliases.json 的 devices 字段与 friendlyNames；
3. 复用现有自动匹配设备别名逻辑；
4. 占位符只展示设备别名、系统摘要、在线状态，不展示可用分布式插件清单；
5. 解析 tool_name#设备别名；
6. 基于 shadowRegistry 区分本地插件与分布式插件；
7. 对分布式插件按 friendlyNames 定向路由；
8. 对本地插件剥离 # 后缀并正常执行；
9. 通过 chokidar 监听 device-aliases.json 变更并刷新占位符。
```

不修改核心源码。  
不修改其他插件。  
明确删除用户自然语言向量化显式调用。  
明确删除向量化路由及相关配置。  
不维护 `displayAlias -> targetServerId/clientId` 持久映射。  
不做占位符定时兜底刷新。  
模型心智统一。  
路由边界清晰。  
复用现有 `friendlyNames` 体系。

这是当前讨论后最稳的实现路径。

---

整理：银染  
版本：V4  
说明：由前序版本修正占位符刷新策略、设备别名配置复用方式、向量路由删除策略与提示词暴露范围。
