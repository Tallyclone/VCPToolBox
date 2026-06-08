# VChatSyncCenter 中文说明

`VChatSyncCenter` 是运行在 VCPToolBox 中的 VChat 多端同步中心服务插件。它在同步架构中充当中心真相源，负责保存消息、配置、附件、变更日志、设备信息、冲突记录和备份数据，并向桌面 Adapter 与其他客户端提供统一 REST API。

> 设计边界：中心插件不直接替代 VCPChat，也不让 DeepMemo 读取中心数据库。DeepMemo 仍读取各桌面端本地 `VCPChat/AppData`；桌面端通过 `VChatSyncAdapter` 把中心事件投影回本机 AppData。

## 角色定位

- 所属项目：`G:\VCP\VCPToolBox`
- 插件目录：`Plugin/VChatSyncCenter`
- 插件类型：`service`
- 挂载方式：`hasApiRoutes: true`，由 VCPToolBox 挂载到 `/api/plugins/VChatSyncCenter/*`
- 同步游标：中心库 `change_log.seq` 单调递增，是所有客户端可靠增量同步的依据
- 数据事实源：SQLite 中心库 + 附件对象存储

## 目录结构

```text
VChatSyncCenter/
├── plugin-manifest.json      # 插件声明、配置项与 service 能力描述
├── index.js                  # 插件初始化、API 路由注册、WebSocket 鉴权注册、关闭逻辑
├── core/                     # 数据库、配置、鉴权、operation、消息/配置/附件/冲突/备份
├── routes/syncRoutes.js      # 对外同步 REST API
├── transport/websocket.js    # WebSocket 相关传输层适配
├── utils/                    # 日志、校验、JSON 等工具
├── data/                     # 默认数据库、附件与备份存放目录
└── test/                     # smoke tests
```

## 核心能力

1. **中心数据库初始化与迁移**

   - `index.js` 通过 `buildRuntimeConfig()` 解析运行配置。
   - `ensureDatabase()` 初始化 SQLite 数据库并运行 migrations。
   - 默认数据库路径为 `./Plugin/VChatSyncCenter/data/vchat_data.db`。
   - 当前 `config_entities` 以 `(schema, entity_id, profile)` 为主键，确保 `bootstrap` 与 `runtime` 配置互不覆盖。

2. **统一 Operation 写入口**

   - 桌面端、移动端应通过 `POST /operations` 提交结构化 operation。
   - 聊天历史同步以 `message create/update/delete` 等 message-level/entity-level 事件为准。
   - 禁止把 `history.json` 当作文件镜像或 JSON Patch 同步对象。

3. **可靠增量拉取**

   - 客户端通过 `GET /changes?after_seq=...&limit=...` 拉取缺失事件。
   - 返回 `latest_seq`、`events`、`has_more` 和 `next_after_seq`。
   - WebSocket 只用于 latest_seq 通知，不能替代 REST 拉取。

4. **设备注册与鉴权**

   - `POST /devices/register` 注册客户端设备。
   - API 通过同步密钥鉴权。
   - 同步密钥由 `VCHAT_SYNC_KEY` 配置，默认 `change-me` 仅用于占位，实际部署必须修改。

5. **配置同步存储隔离**

   - Center 接收配置 operation 时校验 `profile`、`projection_fields`、`deleted_fields`、`safe_projection_json`。
   - Runtime 配置同步范围由客户端 Adapter 的 `sync_profile.json` 决定；Center 不再额外维护 agent/group runtime 字段黑名单。
   - Runtime 配置必须携带 `projection_fields`，且字段仍必须属于 Center 的 bootstrap allowlist。
   - Center 会递归校验 `safe_projection_json`，拒绝敏感 key，并拒绝未声明字段。
   - `deleted_fields` 用于表达显式字段删除：字段必须已声明在 `projection_fields` 中，并且同样必须属于 bootstrap allowlist，不能命中敏感 key。
   - Bootstrap 导出包含 `profile='bootstrap'` 与 `profile='runtime'` 的配置行，确保新设备加入后不会跳过历史 runtime 配置。

6. **附件同步**

   - `POST /attachments` 支持 base64 或 multipart 上传。
   - `GET /attachments/:hash` 按内容 hash 下载附件。
   - 附件事实源存放在 `VCHAT_ATTACHMENT_DIR` 指向的目录。

7. **备份、恢复与完整性检查**

   - `/backup/list`、`/backup/create`、`/backup/verify`、`/backup/restore` 提供中心库备份与恢复能力。
   - `/status` 返回数据库 WAL、完整性、迁移状态、表计数、备份状态和限制参数。

8. **Bootstrap 支持**

   - `/bootstrap/import` 用于初始导入本地基线。
   - `/bootstrap/export` 用于客户端加入或合并时导出中心基线。
   - Bootstrap 接口同样需要高权限鉴权。

9. **主题资源库同步**
   - `theme_package` 表示主题 manifest、变量、extra_css 与 asset 引用关系，同步的是“主题资源库”，不是当前应用状态。
   - `theme_package` 可以通过 `POST /operations` 或 `POST /themes` 提交，`upsert` 会作为 change_log action 原样保留。
   - `theme_asset` 是二进制图片资源，只通过 `POST /themes/assets` 上传；`POST /operations` 不接收 `theme_asset`。
   - 主题资源下载使用 `GET /themes/assets/:hash`，客户端必须校验 hash 后落盘。

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
/api/plugins/VChatSyncCenter/themes
/api/plugins/VChatSyncCenter/themes/:theme_id
/api/plugins/VChatSyncCenter/themes/assets
/api/plugins/VChatSyncCenter/themes/assets/:hash
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

| 配置项                              | 默认值                                            | 说明                               |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `VCHAT_SYNC_ENABLED`                | `false`                                           | 是否启用同步中心                   |
| `VCHAT_SYNC_HOST`                   | `127.0.0.1`                                       | 同步服务主机标识                   |
| `VCHAT_SYNC_KEY`                    | `change-me`                                       | 同步 API 鉴权密钥，部署时必须修改  |
| `VCHAT_SYNC_REQUIRE_DEVICE_BINDING` | `true`                                            | 是否要求设备绑定                   |
| `VCHAT_SYNC_WS_ENABLED`             | `false`                                           | 是否启用 latest_seq WebSocket 通知 |
| `VCHAT_DB_PATH`                     | `./Plugin/VChatSyncCenter/data/vchat_data.db`     | SQLite 中心库路径                  |
| `VCHAT_ATTACHMENT_DIR`              | `./Plugin/VChatSyncCenter/data/vchat_attachments` | 附件对象存储目录                   |
| `VCHAT_BACKUP_DIR`                  | `./Plugin/VChatSyncCenter/data/backups`           | 备份目录                           |
| `VCHAT_BACKUP_INTERVAL`             | `6h`                                              | 自动备份周期                       |
| `VCHAT_BACKUP_RETENTION_DAYS`       | `30`                                              | 备份保留天数                       |
| `VCHAT_RELEASE_MODE`                | `mvp-local-only`                                  | 发布/能力分层标记                  |
| `VCHAT_SYNC_MAX_LIMIT`              | `5000`                                            | changes/export 最大分页限制        |
| `VCHAT_SYNC_MAX_ATTACHMENT_MB`      | `512`                                             | 附件大小限制                       |
| `DebugMode`                         | `false`                                           | 调试日志开关                       |

## 数据库与 migration 说明

Center 启动时会自动运行 migrations。

当前重点：

- `config_entities` 当前主键为：

```sql
PRIMARY KEY (schema, entity_id, profile)
```

- `bootstrap` 与 `runtime` 同一个 `schema/entity_id` 会存成两行，不会互相覆盖。
- migration 会把旧格式 `runtime:xxx` / `manual:xxx` entity_id 转换成真实 `profile` 行。
- migration 执行时会容忍 `duplicate column name`，用于避免列已存在但 migration 记录不一致导致启动硬失败。

## 与 VChatSyncAdapter 的关系

`VChatSyncAdapter` 是桌面端 AppData 适配插件，负责：

1. 扫描和监听本机 `VCPChat/AppData`。
2. 推导 message/entity/config/attachment operation。
3. 通过离线队列向本中心提交 operation。
4. 拉取本中心 `change_log` 事件。
5. 将远端事件原子投影回本机 AppData，供 VChat 和 DeepMemo 继续读取。

中心插件只保存中心事实和变更日志，不负责直接写桌面端 AppData。

## 安全与数据原则

- 不同步 API Key、token、Cookie、密码、本机路径、端口等敏感或设备本地字段。
- 消息唯一身份必须包含 `item_type + item_id + topic_id + message_id`，不能只使用 `message.id`。
- Runtime 配置同步范围由客户端 Adapter 决定；Center 仅做协议底线校验，不对 agent/group runtime 字段设置额外 denylist。
- Runtime 配置 operation 必须携带 `projection_fields`，且 `projection_fields` 只能包含 Center bootstrap allowlist 内字段。
- Runtime 字段删除必须显式写入 `deleted_fields`；缺失字段本身不再作为可靠删除语义。
- `deleted_fields` 中的字段必须同时存在于 `projection_fields`，并通过 bootstrap allowlist 与敏感 key 校验。
- `safe_projection_json` 会递归校验，敏感 key 和未声明字段都会被拒绝。
- Bootstrap 导出包含 `bootstrap` 与 `runtime` profile 配置，防止新设备 join_existing 后跳过历史 runtime 配置。
- Bootstrap 的主题资源只导入/导出 asset metadata，不内嵌二进制；导入后如果 `binary_available=false`，客户端必须从源 Center 按 `/themes/assets/:hash` 拉取二进制，再上传到目标 Center 或写入本地主题库。
- WebSocket 只发 latest_seq 通知；客户端必须通过 REST 补拉事件。
- 所有高风险接口会记录审计日志。
- 备份和恢复接口会影响中心事实源，生产环境应严格控制访问权限。

## 快速联调建议

1. 在 VCPToolBox 中启用本插件，并将 `VCHAT_SYNC_KEY` 改为高强度随机字符串。
2. 确认 `/api/plugins/VChatSyncCenter/status` 返回 `ok: true`。
3. 在 VCPChat 的 `VChatSyncAdapter/config.env` 中配置相同的 `VCHAT_SYNC_KEY` 和正确的 `VCHAT_SYNC_CENTER_URL`。
4. 先通过 Adapter 的 bootstrap 流程初始化设备，再启用正常扫描、上传、拉取与投影。
5. 使用 `/changes?after_seq=0&limit=20` 查看中心是否收到变更。

## 维护注意点

- WebSocket 传输层主要依赖宿主广播，REST 轮询仍是可靠兜底。
- 高频写入场景下可继续优化 latest_seq 查询和内部缓存。
- 备份恢复前建议暂停所有 Adapter，恢复后再逐台检查状态。
- 不建议直接修改中心 SQLite 数据库；优先通过 API 与正常同步流程处理。
