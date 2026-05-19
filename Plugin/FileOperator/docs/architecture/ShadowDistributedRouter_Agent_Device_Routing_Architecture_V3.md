# ShadowDistributedRouter Agent 自主设备路由架构实现文档 V3

日期：2026-05-17  
状态：讨论定稿 / 分隔符修正版  
范围：仅整理架构与实现方案，不修改代码。  
约束：不修改 `Plugin.js`、不修改 `chatCompletionHandler.js`、不修改其他插件实现。所有新增能力应尽量收束在 `ShadowDistributedRouter` 插件内部。

---

## 0. V3 相对 V2 的关键变更

V2 中曾暂定使用：

```text
tool_name@设备别名
```

后续讨论确认：VCP 体系中已经存在 `@` 相关语法与解析语义，例如 Agent mention、上下文引用、联想锚点或其他协议层用途。为避免 `tool_name` 字段在进入工具执行链路前被其他解析层误识别、截断、转义或抢占，本版将显式设备寻址分隔符改为：

```text
tool_name#设备别名
```

示例：

```text
FileOperator#盛世国际电脑
PowerShellExecutor#家里主机
LocalSearchController#卧室笔记本
```

选择 `#` 的原因：

1. `#` 在 `tool_name` 字段内冲突风险低；
2. 比 `::`、`=>` 更短，模型更容易稳定输出；
3. 解析简单，可使用 `lastIndexOf('#')` 右切；
4. 避开 VCP 已有 `@` 语义；
5. 保留“工具名 + 设备别名”的直观表达。

---

## 1. 背景与目标

当前 VCP 分布式插件体系已经具备以下能力：

1. 分布式客户端通过 WebSocket 注册远端工具；
2. `ShadowDistributedRouter` 已经维护分布式工具实例、设备别名、设备信息、会话亲和等路由相关数据；
3. VCP 插件说明可通过占位符进入模型上下文；
4. 源码讨论确认，VCP 的消息变量替换在每轮对话中执行，可用于动态注入更新后的占位符内容。

本次架构目标：

> 让 Agent 能在看到在线设备列表后，主动通过 `tool_name#设备别名` 语法，显式指定某台客户端执行分布式插件。

同时要求：

- 不修改核心源码；
- 不修改其他插件；
- 去掉“用户对话向量化显式调用设备”的旧逻辑；
- 保留并强化自定义设备别名匹配；
- 服务器本地插件与分布式插件对模型使用同一套 `#设备别名` 语法；
- 对模型隐藏底层 `clientId`、`serverId`、WebSocket 连接等内部细节。

---

## 2. 已确认源码事实

### 2.1 消息变量 / 占位符替换机制

讨论中确认的源码路径：

- `chatCompletionHandler.js` 每轮构造消息后，会调用：

```js
messageProcessor.replaceAgentVariables(
  newMessage.content,
  originalBody.model,
  msg.role,
  processingContext
);
```

- `messageProcessor.replaceAgentVariables()` 中，会读取：

```js
pluginManager.getAllPlaceholderValues()
```

- `Plugin.js` 中存在：

```js
pluginManager.getAllPlaceholderValues = function () { ... }
```

用于从 `staticPlaceholderValues` 中取出占位符值。

- `messageProcessor` 替换逻辑支持每轮检查文本中是否包含对应占位符。因此，只要 `staticPlaceholderValues` 中对应占位符的值被更新，下一轮模型上下文即可获得新内容。

### 2.2 分布式静态占位符更新入口

讨论中确认 `Plugin.js` 存在：

```js
updateDistributedStaticPlaceholders(serverId, serverName, placeholders)
```

其用途是更新分布式侧提供的静态占位符内容，并写入 `staticPlaceholderValues`。

本方案利用该现有机制。  
不修改 `Plugin.js`。

### 2.3 分布式插件识别依据

`ShadowDistributedRouter` 内部已有或应维护类似结构：

```js
shadowRegistry: Map<toolName, Map<serverId, record>>
```

可据此判断一个工具是否为分布式工具：

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

最终方案收束为三层：

```text
感知层：ShadowDistributedRouter 动态更新自己的占位符说明
    ↓
表达层：模型使用 tool_name#设备别名 显式寻址
    ↓
路由层：ShadowDistributedRouter 解析 # 后缀，并根据 shadowRegistry 路由
```

### 3.1 核心原则

> 只有 ShadowDistributedRouter 理解“设备”。  
> 核心系统不理解设备。  
> 其他插件不理解设备。  
> 模型只看到设备别名与调用规则。

---

## 4. 动态占位符说明机制

### 4.1 占位符名称

建议使用：

```text
{{ShadowDistributedRouter}}
```

若 VCO / VCP 现有规范要求占位符名带固定前缀，则按实际规范调整。  
但逻辑上它代表 `ShadowDistributedRouter` 的动态使用说明。

### 4.2 更新方式

当以下事件发生时，`ShadowDistributedRouter` 重新生成设备说明文本，并调用现有占位符更新入口：

- 设备上线；
- 设备下线；
- 分布式工具注册变化；
- 设备别名配置变更；
- 服务启动初始化；
- 定时兜底刷新。

伪流程：

```text
设备状态变化
    ↓
ShadowDistributedRouter.collectOnlineDevices()
    ↓
ShadowDistributedRouter.generateDynamicUsageText()
    ↓
pluginManager.updateDistributedStaticPlaceholders(
    serverId,
    serverName,
    { ShadowDistributedRouter: usageText }
)
    ↓
messageProcessor 下一轮替换 {{ShadowDistributedRouter}}
```

说明：

- 这是使用 VCP 已有占位符更新能力；
- 不需要改 `Plugin.js`；
- 不需要改 `chatCompletionHandler.js`；
- 不需要改其他插件。

### 4.3 注入内容模板

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
  可用分布式插件：FileOperator, PowerShellExecutor, LocalSearchController

- 家里主机
  系统：Windows 10
  主机名：DESKTOP-I299K8H
  IP：192.168.x.x
  可用分布式插件：FileOperator, PowerShellExecutor
```

### 4.4 不应暴露的信息

占位符中不应暴露：

- `clientId`
- `serverId`
- WebSocket 连接对象
- session id
- token
- 内部路由表完整结构

模型只需要知道：

- 设备别名；
- 系统信息；
- 主机名；
- IP 的可读摘要；
- 可用分布式插件。

---

## 5. 自定义设备别名

### 5.1 配置文件

建议由 `ShadowDistributedRouter` 自己维护：

```text
Plugin/ShadowDistributedRouter/device-aliases.json
```

示例结构：

```json
{
  "aliases": {
    "DESKTOP-P23SB1E": {
      "alias": "盛世国际电脑",
      "description": "主力工作站"
    },
    "DESKTOP-I299K8H": {
      "alias": "家里主机",
      "description": "本地开发机"
    },
    "192.168.1.34": {
      "alias": "卧室笔记本"
    }
  }
}
```

### 5.2 匹配优先级

别名解析建议顺序：

```text
1. serverId / clientId 精确匹配
2. hostName 精确匹配
3. IP / localIP 精确匹配
4. 设备注册名 / serverName 匹配
5. 自动生成别名
```

自动生成规则：

```text
有 hostName：hostName
无 hostName 但有 IP：设备-192.168.x.x
都没有：设备-xxxxxxxx
```

其中 `xxxxxxxx` 可取 `clientId` 或 `serverId` 的短前缀，但只用于内部兜底展示，不建议作为用户长期使用别名。

### 5.3 别名冲突处理

如果多个设备映射出同一个别名：

```text
盛世国际电脑
盛世国际电脑
```

展示给模型前必须生成唯一 `displayAlias`：

```text
盛世国际电脑
盛世国际电脑-2
```

内部维护：

```text
displayAlias -> targetServerId / clientId
```

模型只看 `displayAlias`。

### 5.4 保留自定义别名匹配逻辑

保留：

- 精确别名匹配；
- hostName / IP 到别名的映射；
- 别名冲突消解；
- 别名配置文件热加载或定时刷新。

删除：

- 基于用户自然语言对话内容向量化推断“显式目标设备”的逻辑。

---

## 6. 删除旧逻辑：用户对话向量化显式调用

本次定稿要求移除：

```text
用户文本中出现某些设备描述
    ↓
向量化匹配设备别名
    ↓
自动推断本轮显式调用目标设备
```

原因：

1. 该逻辑不够确定；
2. 容易误把讨论内容当成调用意图；
3. 与 `tool_name#设备别名` 的显式协议重复；
4. 会制造多入口优先级混乱。

保留的路由优先级应为：

```text
1. tool_name#设备别名
   - Agent 显式寻址
   - 最高优先级

2. 无 #
   - 走原有来源亲和 / 默认分布式路由逻辑
```

自定义设备别名仍保留，但只服务于：

- 占位符设备列表展示；
- `#设备别名` 的解析；
- 来源亲和或默认路由中的可读管理。

---

## 7. tool_name#设备别名 协议

### 7.1 语法

```text
工具名#设备别名
```

示例：

```text
FileOperator#盛世国际电脑
PowerShellExecutor#家里主机
LocalSearchController#卧室笔记本
```

### 7.2 为什么不用 @

不采用 `@` 的原因：

1. VCP 现有语境中已经存在 `@` 相关语法；
2. `@` 容易与 Agent mention、上下文引用、联想锚点、其他协议层解析冲突；
3. 如果全局 parser 在工具执行前扫描 `@`，可能导致工具名字段被提前处理；
4. `#` 在 `tool_name` 私有协议域内更安全。

### 7.3 解析方式

建议使用右切，避免未来工具名或命名空间中出现 `#`：

```js
function parseToolNameWithAlias(toolName) {
  const idx = toolName.lastIndexOf('#');

  if (idx === -1) {
    return {
      rawToolName: toolName.trim(),
      deviceAlias: null
    };
  }

  return {
    rawToolName: toolName.slice(0, idx).trim(),
    deviceAlias: toolName.slice(idx + 1).trim()
  };
}
```

### 7.4 解析位置

应在 `ShadowDistributedRouter` 已有的工具调用拦截/补丁入口中处理。  
讨论中提到的候选位置：

- `patchProcessToolCall`
- 或 `ShadowDistributedRouter` 已经用于给工具调用注入 `requestIp` / 路由上下文的最早入口。

目标：

```text
收到 tool_name
    ↓
解析 #
    ↓
将 tool_name 改回 rawToolName
    ↓
将 deviceAlias 写入上下文
    ↓
后续分布式路由阶段读取 deviceAlias
```

不推荐新增全局 Monkey Patch 作为主方案。  
若现有 `ShadowDistributedRouter` 已经 patch 了必要入口，应在已有 patch 内扩展，不新增更重的拦截层。

---

## 8. 本地插件与分布式插件统一语法

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

## 9. 分布式路由决策

### 9.1 显式寻址

如果存在：

```text
deviceAlias != null
```

则：

```text
1. 用 displayAlias 精确匹配目标设备；
2. 找到 targetServerId / clientId；
3. 检查 rawToolName 在该设备是否有实例；
4. 有实例：定向路由；
5. 无实例：返回设备不支持该工具，或回退策略按配置决定。
```

建议显式寻址失败时不要静默随机路由。  
应返回可读错误：

```text
设备“盛世国际电脑”在线，但未注册 FileOperator。
当前支持 FileOperator 的设备：家里主机、卧室笔记本。
```

### 9.2 无 # 的默认路由

无 `#` 时保留原有：

- 来源亲和；
- 默认设备选择；
- 现有分布式路由策略。

但删除“用户对话向量化显式调用设备”逻辑。

---

## 10. 在线设备信息采集

`ShadowDistributedRouter` 应从已有数据源收集：

```text
shadowRegistry
serverInfoRegistry
分布式工具注册包
WebSocket 元数据
已有心跳/注册信息
```

可展示字段：

```text
displayAlias
hostName
os / platform
ip / localIPs
在线状态
可用分布式插件列表
description
lastSeen / 更新时间
```

缺失字段显示“未知”。  
不为补充系统信息而修改客户端或其他插件。

---

## 11. 错误处理与兜底

### 11.1 设备别名不存在

```text
设备别名“xxx”不存在。
当前在线设备：A、B、C。
```

### 11.2 设备离线

```text
设备“xxx”当前离线。
当前在线设备：A、B、C。
```

### 11.3 设备不支持目标工具

```text
设备“xxx”在线，但未注册工具“FileOperator”。
支持该工具的在线设备：A、B。
```

### 11.4 本地插件带 #

静默剥离别名并执行本地插件。  
可在 debug 日志记录：

```text
[ShadowDistributedRouter] Ignored device alias "xxx" for local tool "VSearch".
```

---

## 12. 实现任务清单

### 12.1 保留 / 强化

- 设备别名配置文件；
- 设备信息采集；
- shadowRegistry 分布式工具注册表；
- 来源亲和 / 默认路由；
- 分布式工具实例查询；
- 占位符更新机制。

### 12.2 新增

1. `generateDynamicUsageText()`
   - 生成 `{{ShadowDistributedRouter}}` 展开文本。

2. `refreshShadowDistributedRouterPlaceholder()`
   - 调用现有占位符更新接口；
   - 在设备上下线、别名变更、启动初始化时触发。

3. `parseToolNameWithAlias(toolName)`
   - 解析 `tool_name#设备别名`。

4. `resolveDisplayAlias(alias)`
   - 将模型看到的 `displayAlias` 解析为目标设备。

5. `isDistributedTool(rawToolName)`
   - 基于 `shadowRegistry` 判断。

6. `routeWithExplicitAlias(rawToolName, deviceAlias, args)`
   - 显式路由到目标设备。

### 12.3 删除 / 禁用

- 用户对话向量化显式设备调用逻辑；
- 从用户自然语言中自动推断本轮显式设备目标的逻辑；
- 与 `tool_name#设备别名` 重复的旧入口。

---

## 13. 测试用例

### 13.1 动态占位符

1. 启动一台客户端；
2. 查看 `{{ShadowDistributedRouter}}` 展开内容；
3. 确认出现设备别名、系统信息、可用插件；
4. 关闭客户端；
5. 下一轮对话确认设备列表移除或标记离线。

### 13.2 自定义别名

1. 在 `device-aliases.json` 中配置：
   ```json
   {
     "aliases": {
       "DESKTOP-P23SB1E": {
         "alias": "盛世国际电脑"
       }
     }
   }
   ```
2. 重载或刷新别名；
3. 确认占位符中显示“盛世国际电脑”。

### 13.3 分布式插件显式路由

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

### 13.4 本地插件带 #

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

### 13.5 别名不存在

模型调用：

```text
tool_name:「始」FileOperator#不存在的设备「末」
```

期望：

```text
返回可读错误，并列出当前在线设备。
```

---

## 14. 最终结论

最终方案：

```text
ShadowDistributedRouter 负责：
1. 动态更新自己的占位符说明；
2. 维护设备别名；
3. 展示在线设备与可用分布式插件；
4. 解析 tool_name#设备别名；
5. 基于 shadowRegistry 区分本地插件与分布式插件；
6. 对分布式插件按别名定向路由；
7. 对本地插件剥离 # 后缀并正常执行。
```

不修改核心源码。  
不修改其他插件。  
不再依赖用户自然语言向量化显式调用。  
模型心智统一。  
路由边界清晰。  
规避 VCP 现有 `@` 语法冲突。  

这是当前讨论后最稳的实现路径。

---
整理：银染  
版本：V3  
说明：由 V2 修正设备寻址分隔符，从 `@` 改为 `#`。