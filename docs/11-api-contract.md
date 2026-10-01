# 11 接口契约

客户端与后端之间只有两种通道：**REST**（命令与查询）和**同步通道**（WebSocket：订阅、实时记录、流式增量、文档操作、在线状态）。桌面窗口、浏览器标签、将来的手机与 CLI 使用完全相同的协议（[03 §4.1](03-architecture.md#41-接入层gateway)）。

## 1. 契约包【硬性】

- `packages/protocol` 用 Zod 定义全部 REST 请求/响应、会话日志记录类型、同步通道消息、工具结果、错误码。
- 服务端用它校验输入（开发/测试模式下也校验输出）；前端从它导入类型与解析器。
- **字段一律 camelCase**，前后端不做任何命名转换。
- 协议版本 `protocolVersion`（整数），在 `/api/v1/bootstrap` 与同步通道握手中返回；客户端不兼容时提示刷新/升级，不带着不兼容的协议继续运行。
- 由契约生成接口文档（OpenAPI），开发模式下可在 `/api/docs` 查看。
- 模块（[03 §4.3](03-architecture.md#43-能力模块)）可以向契约注册自己的记录类型、主题与端点，但都在 `protocol` 包内定义，保证前端可见。

## 2. REST 约定

| 项 | 约定 |
| --- | --- |
| 前缀 | `/api/v1` |
| 鉴权 | `Authorization: Bearer <设备令牌>`；只有 `GET /api/v1/health` 免鉴权 |
| 请求 ID | 服务端生成 `X-Request-Id` 并写入日志与追踪；客户端可传入 |
| 错误 | HTTP 状态码 + `{ error: { code, message, details?, requestId } }`，`code` 来自统一词表 |
| 幂等 | 创建类请求接受 `Idempotency-Key`；发送消息使用 `clientMessageId`（[04 §4.3](04-agent-runtime.md#43-派发记录与幂等硬性)） |
| 分页 | 游标分页：`?cursor=&limit=`，响应 `{ items, nextCursor }` |
| 时间 | ISO 8601 UTC 字符串 |
| 大小限制 | JSON 请求体 10 MB；上传单文件 200 MB（可配置） |
| 不支持的功能 | 不提供对应端点，不返回伪造的成功 |

本机 HTTP 请求校验 Host；请求携带 Origin 时也必须属于允许来源，拒绝返回 `forbidden_origin`。无 Origin 的 CLI 仍需设备令牌。静态资源只允许读取构建目录内的实际文件。

上传只创建新文件。同名目标返回 HTTP 409 `conflict`，不覆盖；替换已有文件须走具备备份与版本检查的文件管理路径。上传文件上限为 200 MiB，multipart 请求额外允许 64 KiB 包装开销；其他请求上限为 10 MiB。没有 Content-Length 的请求同样受实际读取大小限制。

消息的 `clientMessageId` 幂等性包括正文、派发模式和选区上下文；相同 ID 携带不同选区不能当作同一次消息。选区入队前校验文档归属、工作表、区域和修订号，过期修订返回 HTTP 409，不进入日志和队列。

## 3. 同步通道

### 3.1 建立连接

1. 客户端 `POST /api/v1/sync/ticket`（带设备令牌）换取一次性票据（30 秒有效，只能使用一次）。
2. 以 `GET /api/v1/sync?ticket=<票据>` 升级为 WebSocket。服务端在升级阶段校验票据、`Origin` 与 `Host`，不通过则拒绝升级。（浏览器 WebSocket 不能自定义请求头，因此不把长期令牌放进 URL，只用一次性票据。）
3. 握手完成后服务端发送 `hello`：`protocolVersion`、服务端时间、连接 ID。
4. 心跳：双方每 20 秒一次 `ping`/`pong`；40 秒无消息视为断开。
5. 一个客户端通常只保持一条连接，在其上订阅多个主题。

### 3.2 主题

| 主题 | 游标 | 内容 |
| --- | --- | --- |
| `session:<id>` | 会话日志序号 `seq` | 该会话所有代理的日志记录 + 流式增量 |
| `doc:<id>` | 文档修订号 `rev` | 文档操作、提交确认/拒绝、在线状态 |
| `app` | 无（只推送最新状态） | 会话列表变化、设置变化、工作区文件变化、后台任务进度、MCP 状态、设备变化 |

### 3.3 消息格式

客户端 → 服务端：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `sub` | `topic`、`cursor?` | 订阅；带游标则从游标之后续传 |
| `unsub` | `topic` | |
| `doc.submit` | `docId`、`clientOpId`、`baseRev`、`mutations` | 用户在工作台中的编辑 |
| `presence` | `docId`、`sheet`、`selection`、`viewport` | 当前查看与选区（节流：每 200 ms 最多一次） |
| `ping` | | |

服务端 → 客户端：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `protocolVersion`、`connectionId` | |
| `sub.ok` / `sub.error` | `topic`、`headCursor` / `error` | |
| `rec` | `topic`、`seq`、`record` | 一条会话日志记录（持久，可重放） |
| `delta` | `topic`、`agentId`、`stepId`、`part`、`kind`、`payload` | 流式增量（瞬时，不重放） |
| `snapshot` | `topic`、`agentId`、`stepId`、`text`、`reasoning`、`toolArgs` | 续传完成时当前正在进行的流式状态 |
| `doc.op` | `docId`、`rev`、`source`、`mutations`、`chunk?`（`{index, total}`，大批量分片） | 已应用的文档修订 |
| `doc.ack` / `doc.reject` | `clientOpId`、`rev` / `conflict`（被改的单元格、修改者、修订号） | 对 `doc.submit` 的答复 |
| `doc.reload` | `docId`、`rev`、`reason` | 游标早于保留的文档日志或外部重新加载，客户端需重新取快照 |
| `presence` | `docId`、参与者列表（客户端与代理，含颜色、选区/活动区域） | 协作光标与代理活动叠加层 |
| `app.event` | `type`、`data` | 应用级变化 |
| `pong` | | |

### 3.4 续传【硬性】

- **会话主题**：客户端记住已处理的最大 `seq`。重新订阅时带 `cursor=seq`，服务端从数据库读出之后的全部记录按序发送，然后切换为实时。数据来自数据库，**不存在缓冲区溢出**。若有代理正在流式输出，补发完后发送一条 `snapshot`，之后的 `delta` 照常到达。
- **文档主题**：客户端带 `cursor=rev`。服务端若仍保留该修订之后的文档日志，按序补发 `doc.op`；否则发送 `doc.reload`，客户端通过 REST 重新获取快照后再以新的 `rev` 订阅。
- 客户端处理 `rec` 与 `doc.op` 必须幂等：游标之前的直接丢弃。
- 客户端未确认的 `doc.submit` 在断线时视为未提交；重连后若收到的 `doc.op` 中没有该 `clientOpId`，客户端撤销本地变更并提示用户重试（不自动重发，避免基于过期修订的修改）。

### 3.5 会话日志记录类型【推荐：清单；硬性：持久/瞬时的划分】

持久记录（`rec`，即 [10 §3.2](10-data.md#32-会话日志事实源) 中的 `session_log` 行）：

| 类型 | 说明 |
| --- | --- |
| `session.updated` | 标题、权限模式等变化 |
| `user.message` | 用户消息（含附件、上下文引用、派发 ID） |
| `dispatch.updated` | 派发状态：accepted / queued / applied / cancelled / failed |
| `turn.started` / `turn.completed` / `turn.failed` / `turn.interrupted` | 轮的边界；完成时附用量与结束原因 |
| `step.started` | 一步开始（模型、请求前缀哈希，用于诊断缓存） |
| `model.output` | 一步中模型的完整输出：文本、思考、工具调用 |
| `attempt.discarded` | 本次模型尝试作废（流中断将重试），客户端清除对应的临时显示 |
| `tool.intent` | 即将执行某工具调用（参数、目标、`replay` 声明） |
| `tool.result` | 状态 `ok` / `error` / `partial` / `not_executed` / `uncertain`；结果摘要；产生的文档修订 |
| `approval.requested` / `approval.decided` | |
| `question.asked` / `question.answered` | |
| `inbox.sent` / `inbox.delivered` | 代理间消息、完成报告、运行时通知（[05 §4](05-multi-agent.md#4-收件箱与消息)） |
| `agent.spawned` / `agent.status` | 多代理（[05 §12](05-multi-agent.md#12-事件)） |
| `todo.updated` | |
| `compaction` | 压缩前后 token 数、摘要 |
| `retry.scheduled` | 第几次、等待秒数、原因 |
| `error.guidance` | 错误分类与建议操作 |
| `context.notice` | 追加给代理的环境变化或文档变化通知（[03 §6.2](03-architecture.md#62-文档与会话之间)） |
| `change.summary` | 一轮结束时的变更摘要（由文档日志生成） |
| `ui.present` | `present` 工具：高亮区域、提供文件 |
| `memory.saved` | 代理保存了一条记忆（界面可撤销） |
| `usage.updated` | 上下文占用、累计 token 与估算费用 |

瞬时（`delta`，`kind` 取值）：`text`、`reasoning`、`tool_args`、`tool_progress`（如 `run_script` 输出行）、`workbook_activity`（代理正在读取/计划修改的区域）、`agent_budget`。

会话被删除时，`app` 主题推送 `session.deleted`，服务端结束该会话主题的订阅。

### 3.6 客户端状态【硬性】

- 会话界面状态由纯函数 `reduceSession(state, message) → state` 维护；文档客户端状态（已确认修订、待确认的本地提交）由 `reduceDoc` 维护。处理函数内不发起请求、不读写存储。
- 两个函数都用**真实服务端录制的消息流**做测试（[14 §3](14-quality.md#3-测试分层)）。
- 未知的记录类型或消息类型记录警告并忽略，不抛错（向前兼容新增的模块记录）。

## 4. REST 资源（概要）

字段细节以契约包为准，【推荐】。

| 资源 | 端点 | 动作 |
| --- | --- | --- |
| 健康 | `GET /health` | 免鉴权，只返回 `ok` 与版本 |
| 启动信息 | `GET /bootstrap` | 协议版本、应用版本、形态、是否已配置模型、已启用模块、功能开关、本机数据目录 `dataDir`（需鉴权，仅供设置页展示） |
| 同步票据 | `POST /sync/ticket` | 见 §3.1 |
| 设置 | `GET/PATCH /settings` | 只提交修改的键；响应附"需要重启"的键 |
| 模型档案 | `/model-profiles` | CRUD、设为默认；`POST /{id}/test`；`POST /{id}/probe`（进度在 `app` 主题） |
| 提供商 | `GET /providers`；`POST /providers/{id}/models` | 预设列表；拉取远端模型列表 |
| 订阅账号 | `/accounts` | 列表；`POST /accounts/{provider}/login`（授权 URL 或设备码）；`POST /accounts/{provider}/login/poll`；`POST /{id}/refresh`；`DELETE /{id}` |
| 工作区 | `/workspaces` | 列表、添加、改名、删除登记、排序 |
| 文件 | `/workspaces/{id}/files` | `GET ?path=` 列目录；`POST /upload`；`GET /download?path=`；`POST /manage`（批量 mkdir/copy/move/delete，与 `files` 工具同一实现） |
| 文档 | `/workspaces/{id}/docs` | `POST /open`（返回 `docId`、`rev`）；`GET /{docId}/snapshot?rev=&window=`（快照，大文件按窗口）；`POST /{docId}/render`（截图）；`GET /{docId}/revs/{rev}/before`（该修订改动单元格的修改前的值，来自逆操作，07 §7.4）。编辑只经同步通道的 `doc.submit` |
| 备份与回收站 | `/workspaces/{id}/backups`、`/trash` | 列表、下载、替换回原文件、删除 |
| 会话 | `/sessions` | 列表（搜索、分页）、创建、改名、删除、导出 Markdown；`GET /{id}`（摘要、代理、待处理交互、`headSeq`） |
| 会话日志 | `GET /sessions/{id}/log?before=&limit=` | 向前分页读取历史（打开旧会话时按需加载，之后靠同步通道） |
| 发送消息 | `POST /sessions/{id}/agents/{agentId}/messages` | `clientMessageId`、内容、附件、上下文引用（含文档修订）、`mode`；返回派发记录 |
| 撤回排队消息 | `DELETE /sessions/{id}/dispatches/{dispatchId}` | 仅未应用的 |
| 停止 / 继续 | `POST /sessions/{id}/agents/{agentId}/stop`、`/resume`；`POST /sessions/{id}/stop-all` | |
| 审批 | `POST /approvals/{id}` | `decision`、`reason?`、`remember?` |
| 提问 | `POST /questions/{id}` | 回答（区域题型含文档、工作表、区域、修订号） |
| 代理控制 | `POST /sessions/{id}/agents/{agentId}/control` | pause / resume / close |
| 压缩 | `POST /sessions/{id}/agents/{agentId}/compact` | |
| 附件 | `POST /attachments`；`GET /attachments/{sha256}` | multipart `file`，返回附件引用 `{sha256, mediaType, name, size}`（内容寻址去重，存 `blobs/`）；v1 只接受 PNG/JPEG/GIF/WebP 图片、≤ 10 MB，类型按文件内容判定。消息体 `attachments` 最多 8 个，受理前校验已上传；表格等文件走工作区上传并以 `@路径` 引用（02 §3.3） |
| 技能 | `/skills` | 列表、详情、启用/禁用、导入、删除用户技能 |
| 记忆 | `/memories` | 列表、搜索、编辑、删除 |
| 规则 | `/rules` | CRUD |
| MCP | `/mcp-servers` | CRUD、`POST /{id}/test`、`POST /reload` |
| 设备 | `/devices` | 列表、吊销（配对端点 P2） |
| 诊断 | `GET /diagnostics/traces?sessionId=`；`POST /diagnostics/export` | 本地追踪查看、导出脱敏诊断包（[03 §9](03-architecture.md#9-可观测性)） |
| 桌面专用 | Electron IPC，不走 HTTP | 选择目录、更新、打开外部链接、通知 |

## 5. 契约测试【硬性】

- 每个 REST 端点至少一个"真实 HTTP 服务 + 真实数据库文件"的测试，响应经契约校验。
- 同步通道：真实 WebSocket 连接的测试覆盖订阅、续传、`doc.submit` 确认与冲突拒绝、`doc.reload`、断线重连。
- 前端只能通过契约生成的客户端发请求（由类型系统保证每个调用点对应契约中的端点）。
- E2E 测试录制完整的同步通道消息流，喂给 `reduceSession` / `reduceDoc`，断言最终界面状态。
