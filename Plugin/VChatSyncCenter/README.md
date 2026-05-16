# VChatSyncCenter 中文说明

`VChatSyncCenter` 是部署在 `VCPToolBox/Plugin/VChatSyncCenter` 下的 VChat 多端同步中心服务插件。它在同步架构中充当中心真相源，负责保存消息、配置、附件、变更日志、设备信息、冲突记录和备份数据，并向桌面 Adapter 与手机端提供统一 REST API。

> 设计边界：中心插件不直接替代 VCPChat，也不让 DeepMemo 读取中心数据库。DeepMemo 仍读取各桌面端本地 `VCPChat/AppData`；桌面端通过 `VChatSyncAdapter` 把中心事件投影回本机 AppData。

## 角色定位

- 所属项目：`G:\VCP\VCPToolBox`
- 插件目录：`Plugin/VChatSyncCenter`
- 插件类型：`service`
- 挂载方式：`hasApiRoutes: true`，由 VCPToolBox 挂载到 `/api/plugins/VChatSyncCenter/*`
- 同步游标：中心库 `change_log.seq` 单调递增，是所有客户端可靠增量同步的依据
- 数据事实源：SQLite 中心库 + 附件对象存储

## 当前代码结构

```text
VChatSyncCenter/
├── plugin-manifest.json      # 插件声明、配置项与 service 能力描述
├── index.js                  # 插件初始化、API 路由注册、WebSocket 鉴权注册、关闭逻辑
├── core/                     # 数据库、配置、鉴权、operation 处理、消息/配置/附件/冲突/备份等核心逻辑
├── routes/syncRoutes.js      # 对外同步 REST API
├── transport/websocket.js    # WebSocket 相关传输层占位/适配
├── utils/                    # 日志、校验、JSON 等工具
├── data/                     # 默认数据库、附件与备份存放目录
└── test/                     # 插件测试
```

## 核心能力

1. **中心数据库初始化与迁移**
   - `index.js` 通过 `buildRuntimeConfig()` 解析运行配置。
   - `ensureDatabase()` 初始化 SQLite 数据库并保证 schema 可用。
   - 默认数据库路径为 `./Plugin/VChatSyncCenter/data/vchat_data.db`。

2. **统一 Operation 写入口**
   - 桌面端、手机端应通过 `POST /operations` 提交结构化 operation。
   - 聊天历史同步以 `message create/update/delete` 等 message-level/entity-level 事件为准。
   - 禁止把 `history.json` 当作文件镜像或 JSON Patch 同步对象。

3. **可靠增量拉取**
   - 客户端通过 `GET /changes?after_seq=...&limit=...` 拉取缺失事件。
   - 返回 `latest_seq`、`events`、`has_more` 和 `next_after_seq`。
   - WebSocket 只用于 latest_seq 通知，不能替代 REST 拉取。

4. **设备注册与鉴权**
   - `POST /devices/register` 注册客户端设备。
   - API 通过 `requireSyncAuth()` / `validateSyncAuth()` 校验同步密钥。
   - 同步密钥由 `VCHAT_SYNC_KEY` 配置，默认 `change-me` 仅用于占位，实际部署必须修改。

5. **附件同步**
   - `POST /attachments` 支持 base64 或 multipart 上传。
   - `GET /attachments/:hash` 按内容 hash 下载附件。
   - 附件事实源存放在 `VCHAT_ATTACHMENT_DIR` 指向的目录。

6. **备份、恢复与完整性检查**
   - `/backup/list`、`/backup/create`、`/backup/verify`、`/backup/restore` 提供中心库备份与恢复能力。
   - `/status` 会返回数据库 WAL、完整性、迁移状态、表计数、备份状态和限制参数。

7. **Bootstrap 支持**
   - `/bootstrap/import` 用于初始导入本地基线。
   - `/bootstrap/export` 用于客户端加入或合并时导出中心基线。
   - Bootstrap 接口同样需要高权限鉴权。

## 主要 API

所有路径均以 VCPToolBox 挂载前缀为基础：

```text
/api/plugins/VChatSyncCenter/status
/api/plugins/VChatSyncCenter/devices/register
/api/plugins/VChatSyncCenter/operations
/api/plugins/VChatSyncCenter/changes
/api/plugins/VChatSyncCenter/conflicts
/api/plugins/VChatSyncCenter/attachments
/api/plugins/VChatSyncCenter/attachments/:hash
/api/plugins/VChatSyncCenter/bootstrap/import
/api/plugins/VChatSyncCenter/bootstrap/export
/api/plugins/VChatSyncCenter/backup/list
/api/plugins/VChatSyncCenter/backup/create
/api/plugins/VChatSyncCenter/backup/verify
/api/plugins/VChatSyncCenter/backup/restore
```

鉴权请求头示例：

```http
Authorization: Bearer <VCHAT_SYNC_KEY>
```

## 关键配置

配置项来自 `plugin-manifest.json` 的 `configSchema`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `VCHAT_SYNC_ENABLED` | `false` | 是否启用同步中心 |
| `VCHAT_SYNC_HOST` | `127.0.0.1` | 同步服务主机标识 |
| `VCHAT_SYNC_KEY` | `change-me` | 同步 API 鉴权密钥，部署时必须修改 |
| `VCHAT_SYNC_REQUIRE_DEVICE_BINDING` | `true` | 是否要求设备绑定 |
| `VCHAT_SYNC_WS_ENABLED` | `false` | 是否启用 latest_seq WebSocket 通知 |
| `VCHAT_DB_PATH` | `./Plugin/VChatSyncCenter/data/vchat_data.db` | SQLite 中心库路径 |
| `VCHAT_ATTACHMENT_DIR` | `./Plugin/VChatSyncCenter/data/vchat_attachments` | 附件对象存储目录 |
| `VCHAT_BACKUP_DIR` | `./Plugin/VChatSyncCenter/data/backups` | 备份目录 |
| `VCHAT_BACKUP_INTERVAL` | `6h` | 自动备份周期 |
| `VCHAT_BACKUP_RETENTION_DAYS` | `30` | 备份保留天数 |
| `VCHAT_SYNC_MAX_LIMIT` | `5000` | changes/export 最大分页限制 |
| `VCHAT_SYNC_MAX_JSON_BODY_MB` | `20` | JSON 请求体大小限制 |
| `VCHAT_SYNC_MAX_ATTACHMENT_MB` | `512` | 附件大小限制 |
| `DebugMode` | `false` | 调试日志开关 |

## 与 VChatSyncAdapter 的关系

`VChatSyncAdapter` 是桌面端 AppData 适配插件，负责：

1. 扫描和监听本机 `VCPChat/AppData`。
2. 推导 message/entity operation。
3. 通过离线队列向本中心提交 operation。
4. 拉取本中心 `change_log` 事件。
5. 将远端事件原子投影回本机 AppData，供 VChat 和 DeepMemo 继续读取。

中心插件只保存中心事实和变更日志，不负责直接写桌面端 AppData。

## 安全与数据原则

- 不同步 API Key、token、Cookie、密码、本机路径、端口等敏感或设备本地字段。
- 消息唯一身份必须包含 `item_type + item_id + topic_id + message_id`，不能只使用 `message.id`。
- WebSocket 只发 latest_seq 通知；客户端必须通过 REST 补拉事件。
- 所有高风险接口会记录审计日志。
- 备份和恢复接口会影响中心事实源，生产环境应严格控制访问权限。

## 快速联调建议

1. 在 VCPToolBox 中启用本插件，并将 `VCHAT_SYNC_KEY` 改为高强度随机字符串。
2. 确认 `/api/plugins/VChatSyncCenter/status` 返回 `ok: true`。
3. 在 VCPChat 的 `VChatSyncAdapter/config.env` 中配置相同的 `VCHAT_SYNC_KEY` 和正确的 `VCHAT_SYNC_CENTER_URL`。
4. 先通过 Adapter 的 bootstrap 流程初始化设备，再启用正常扫描、上传、拉取与投影。

## 已知工程注意点

根据同步功能 Review，当前总体架构与协议实现正确，复合主键、幂等、事务边界、防回环、原子写入等关键约束已落实。后续维护时需重点关注：

- WebSocket 传输层主要依赖宿主广播，REST 轮询仍是可靠兜底。
- 冲突记录可能随无 `base_version` 的 update 增长，后续可考虑归档/清理策略。
- 高频写入场景下可继续优化 latest_seq 查询和内部缓存。
