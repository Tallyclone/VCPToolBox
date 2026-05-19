# VCP 分布式插件意图路由系统实现方案 (V1.0)

## 1. 核心设计目标
实现 Agent 自主、显式地调用指定终端的分布式插件，而不破坏现有的 VCP 插件加载协议（不修改 Plugin.js 等核心源码）。

## 2. 核心架构逻辑
### A. 动态感知层 (Dynamic Awareness)
- **占位符机制**：在 `ShadowDistributedRouter` 插件的工具描述中注入 `{{SHADOW_DEVICES_LIST}}`。
- **动态替换**：通过插件内部的定时任务或 `getToolDefinitions` 钩子，实时查询 `WebSocketServer` 中处于 `connected` 状态的 Client。
- **信息维度**：列表包含：`别名(Alias)`、`操作系统`、`局域网IP`、`当前会话ID`。
- **自定义别名**：在 `vcp_config.json` 或插件专用配置文件中维护 `Client_UID -> Custom_Alias` 的映射关系。

### B. 指令协议层 (Interaction Protocol)
- **语法规范**：`tool_name@device_alias`。
- **路由逻辑**：
    1. **解析**：拦截所有工具请求，检测 `tool_name` 是否包含 `@` 符号。
    2. **剥离**：若包含，则拆分为 `target_tool` 和 `target_alias`。
    3. **判断**：
        - 若 `target_tool` 为分布式插件：根据 `target_alias` 寻找对应 Client ID，进行强指向路由。
        - 若 `target_tool` 为服务器本地插件：丢弃后缀，直接在本地执行。
    4. **兜底**：若别名不存在或设备离线，返回“设备未就绪”错误，触发 Agent 的重试/备选逻辑。

### C. 运行时注入技术 (Runtime Patching)
- **免改源码方案**：
    - 在 `ShadowDistributedRouter` 的 `init()` 阶段，利用 JS 原型链或对象劫持技术，为 `PluginManager.executeTool` 增加一层拦截装饰器。
    - 该装饰器优先处理 `@` 路由逻辑，处理完毕后再交还给原生执行链。
- **优势**：确保了 `Plugin.js` 和 `chatCompletionHandler.js` 的文件纯净性，升级 VCP 核心时不产生冲突。

## 3. 功能演进说明
- **移除过往逻辑**：彻底剔除基于“用户对话内容向量化”的显式调用猜测，改为由 Agent 根据注入的设备列表进行逻辑决策。
- **统一入口**：不论是本地还是分布式，对 Agent 而言只需关注 `tool@device` 这一种显式表达方式，复杂度由 `ShadowDistributedRouter` 内部消化。

## 4. 后续协作计划
1. **开发者**：完成 `ShadowDistributedRouter.js` 的别名映射管理逻辑。
2. **VCO 适配**：确保 VCP-Core-Orchestrator 在编排插件时，能正确传递拦截后的回调上下文。
3. **前端适配**：在 VChat 的控制台增加 `set_alias` 指令，用于动态修改设备别名。

---
*整理人：鹿小满*
*日期：2026-05-17*