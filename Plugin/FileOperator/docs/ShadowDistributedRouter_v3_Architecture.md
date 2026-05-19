# ShadowDistributedRouter v3 架构实现文档

## 1. 核心目标
实现 Agent 自主识别并显式调用分布式环境下的特定设备工具，同时保持 VCP 核心源码（Plugin.js）的零侵入性。

## 2. 关键变更说明
- **语法定义**：使用 `#` 作为工具名与设备别名的分隔符。示例：`get_screen_shot#LivingRoom_PC`。
- **去向量化逻辑**：移除原有基于用户对话向量匹配进行显式调用的逻辑，改为完全由 Agent 根据提示词注入的设备列表自主决策。
- **路由策略**：
    - 若 `tool_name` 包含 `#`：
        - 匹配到分布式设备：转发 Payload 至对应 Client。
        - 匹配到服务器本地：剥离 `#` 后缀，执行本地插件。
    - 若不包含 `#`：按原有的会话亲和性逻辑执行。

## 3. 技术实现路径

### 3.1 动态占位符注入 (Dynamic Placeholder)
- **占位符**：`{{ShadowDistributedRouter}}`
- **实现逻辑**：SDR 插件监听 WebSocket 的 `connection` 与 `close` 事件。在 `getPrompt` 或动态注入阶段，构造如下格式的 Markdown 列表：
  > **当前在线分布式设备清单：**
  > - **设备名 (Alias/ID)** | 系统 | IP | 状态
  > - **盛世国际电脑** | Windows 10 | 192.168.1.5 | 在线
- **注入时机**：随 VCP 插件说明文档动态注入，确保 Agent 永远感知最新的在线设备。

### 3.2 运行时劫持 (Monkey Patching)
- **劫持对象**：`PluginManager.prototype.execute`
- **操作方式**：在 SDR 插件加载时，保存原始 `execute` 引用，并重写该方法。
- **伪代码逻辑**：
  ```javascript
  const originalExecute = PluginManager.prototype.execute;
  PluginManager.prototype.execute = function(tool_name, args, context) {
      if (tool_name.includes('#')) {
          const [realName, alias] = tool_name.split('#');
          const targetClient = this.findClientByAlias(alias); // 复用 device-aliases.json 逻辑
          if (targetClient) {
              return this.routeToDistributed(targetClient, realName, args);
          }
          return originalExecute.call(this, realName, args, context);
      }
      return originalExecute.call(this, tool_name, args, context);
  };
  ```

### 3.3 设备别名与系统信息
- **别名配置**：复用 `device-aliases.json`。支持 `friendlyName` 与 `aliases` 数组匹配。
- **系统信息获取**：通过 WebSocket 握手阶段，客户端上报 `os.platform()`、`os.release()` 及内网 IP，存储于 Server 端的 Client 元数据中。

## 4. 兼容性评估
- **# 语法冲突**：经确认为 VCP 当前无 `#` 开头的保留语法，兼容性良好。
- **本地/分布式共存**：通过“剥离后缀”逻辑，确保同一套提示词可以同时适配本地和远程调用，降低了 Agent 的感知成本。

## 5. 后续计划
1. 在 SDR 插件中实现 `getPrompt` 的占位符替换逻辑。
2. 封装 `PluginManager` 劫持函数。
3. 移除旧版的显式向量化匹配代码。

---
**核准人**：李墨行
**整理人**：鹿小满
**时间**：2026-05-17