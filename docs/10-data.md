# 10 数据与持久化

## 1. 原则【硬性】

- 产品状态只有**一个**持久化来源：数据目录下的 SQLite 数据库。设置、模型档案、会话、审批、文档操作全部在库里，不散落在多个 JSON 文件中。
- **会话日志是会话状态的唯一事实源**；其他会话相关的表都是日志的投影，可删除后重建（[03 §3.1](03-architecture.md#31-会话日志是唯一事实源其余都是投影)）。
- **文档日志是活文档修改的唯一事实源**；xlsx 文件是它的检查点（[07 §5](07-workbook-engine.md#5-文档日志与检查点)）。
- 写日志与更新投影在同一事务内；事务提交后才推送给客户端。
- 用户文件就是工作区里的普通文件；产品在工作区内只写 `.excelmanus/` 目录（备份、回收站、临时文件）。
- 不与旧版共用数据目录，不读取旧版数据。

## 2. 数据目录

| 形态 | 默认位置 |
| --- | --- |
| 桌面 | Electron `userData` 目录 |
| 本机 Web | `~/.excelmanus-next`（【开放】最终命名见 [附录 C](appendix-c-open-questions.md)） |

可用环境变量 `EXCELMANUS_HOME` 或启动参数 `--data-dir` 覆盖。

```text
<数据目录>/
  excelmanus.db              # 主库（WAL 模式）
  master.key[.enc]           # 主密钥（§4）
  instance.lock              # 单实例锁
  blobs/<ab>/<sha256>        # 内容寻址存储：附件、截图、文档快照
  skills/<名称>/SKILL.md      # 用户技能
  cache/                     # 模型目录更新、渲染缓存等可删除内容
  logs/                      # 结构化日志，按天滚动，保留 14 天
  workspace/                 # 默认工作区

<工作区>/.excelmanus/
  backups/…                  # 修改前备份（[07 §7](07-workbook-engine.md#7-修改前备份)）
  trash/…                    # 回收站
  tmp/…                      # 检查点与脚本暂存的临时文件（与工作区同卷，保证原子改名）
```

- **单实例**：同一数据目录只允许一个后端进程；第二个实例启动时，桌面版激活已有窗口，Web 版报错并提示已运行的地址。
- 数据库参数：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- **访问纪律**：`node:sqlite` 只有同步 API（2026-09 实测），写入在主线程串行执行。每个事务目标 < 5 ms；读取历史一律分页；文档快照等大对象放内容寻址存储而不是数据库行。若测得事务 p99 超过 20 ms，把存储层移入专用 worker（接口不变）。

## 3. 数据库结构【推荐：表的划分与关键约束；列名可调整】

### 3.1 配置

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `meta` | `schema_version` | 迁移版本 |
| `settings` | `key` PK、`value`（JSON）、`updated_at` | 键与取值范围由各模块的设置 schema 定义 |
| `credentials` | `id`、`kind`（api_key/oauth）、`provider`、`ciphertext`、`nonce`、`meta`（账号名、过期时间等非敏感信息） | 密钥只以密文存储 |
| `model_profiles` | 见 [09 §3](09-models.md#3-模型档案) | `credential_id` 外键 |
| `capability_cache` | `key`、`result`、`updated_at` | 能力探测结果 |
| `mcp_servers` | `id`、`name` 唯一、`transport`、`config`（敏感字段加密）、`enabled`、`auto_approve` | |
| `skills_state` | `name`、`source`、`enabled` | 技能正文在磁盘 |
| `rules` | `id`、`scope`（global/session）、`session_id`、`content`、`enabled` | |
| `memories` | `id`、`content`、`category`、`workspace_id`（空=全局）、`source_session_id`、`created_at`、`updated_at`；FTS5 索引 | 2026-09 实测 `node:sqlite` 含 FTS5 |
| `devices` | `id`、`name`、`kind`（local/paired）、`token_hash`、`created_at`、`last_seen_at`、`revoked_at` | 客户端设备与令牌（只存哈希）。v1 只有本机设备；手机配对（P2）复用 |
| `workspaces` | `id`、`name`、`path` 唯一、`is_default`、`sort`、`last_opened_at` | |

### 3.2 会话日志（事实源）

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `session_log` | (`session_id`, `seq`) PK、`agent_id`、`type`、`data`（JSON）、`trace_id`、`created_at` | 只追加。记录类型由契约包定义（[11 §3](11-api-contract.md#3-同步通道)），各模块可注册自己的类型 |

主要记录类型（完整清单见契约包）：`user.message`、`dispatch.*`、`turn.*`、`step.started`、`model.output`、`tool.intent`、`tool.result`、`approval.requested/decided`、`question.asked/answered`、`inbox.sent/delivered`、`agent.spawned/status`、`todo.set/updated`、`compaction`、`context.notice`（环境变化、文档变化通知）、`change.summary`、`memory.saved`。

### 3.3 会话投影（可重建）

| 表 | 关键列 | 由哪些日志记录维护 |
| --- | --- | --- |
| `sessions` | `id`、`workspace_id`、`title`、`permission_mode`、`created_at`、`updated_at`、`last_seq` | 会话创建、标题、权限变化 |
| `agents` | `id`、`session_id`、`parent_id`、`name`、`role`、`status`、`model_profile_id`、`budget`、`usage`、`closed_at` | `agent.*`、用量 |
| `agent_context` | `agent_id`、`idx`、`item`（产品中立的消息格式，含思考内容的提供商附加数据）、`from_seq` | 模型上下文：用户消息、模型输出、工具结果、收件箱投递、压缩摘要、环境说明。压缩时标记被摘要取代的条目 |
| `dispatches` | `id`、`session_id`、`agent_id`、`client_message_id`、`mode`、`status`；唯一约束 (`session_id`,`agent_id`,`client_message_id`) | `dispatch.*` |
| `inbox_pending` | `message_id`、`agent_id`、`kind`、`from_agent_id`、`priority`、`body` | `inbox.sent` 增、`inbox.delivered` 删 |
| `pending_interactions` | `id`、`session_id`、`agent_id`、`kind`（approval/question）、`tool_call_id`、`spec`、`status` | `approval.*`、`question.*` |
| `open_intents` | `agent_id`、`tool_call_id`、`tool_name`、`targets`、`replay` | `tool.intent` 增、`tool.result` 删；启动恢复时读取（[04 §8](04-agent-runtime.md#8-中断与恢复)） |
| `auto_approve_rules` | `id`、`session_id`、`tool_name`、`path_pattern` | `approval.decided`（remember=true） |
| `todos` | `agent_id`、`items` | `todo.*` |
| `change_summaries` | `session_id`、`turn_seq`、`summary` | `change.summary` |
| `attachment_refs` | `session_id`、`blob_sha256` | 带附件的用户消息 |

**重建测试【硬性】**：CI 中对随机生成的会话，比较"删除全部投影后从日志重建"与"增量维护"的结果，必须完全一致。

会话工作区归属只来自 `session.created.workspaceId` 及其投影。客户端可在本机保存导航偏好（当前工作区 ID、各区最后打开的会话 ID），刷新时仍须通过服务端登记与会话详情验证；这些偏好不是会话事实，也不允许用它们改绑工作区。自动空白落点从既有日志判断是否可复用，不增加独立 blank 状态源（02 §2.3、11 §4.1）。

### 3.4 文档

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `documents` | `id`、`workspace_id`、`path`（工作区内唯一）、`kind`（xlsx/csv）、`head_rev`、`checkpoint_rev`、`checkpoint_hash`、`engine_version`（Univer 版本）、`last_opened_at` | 活文档登记 |
| `doc_ops` | (`doc_id`, `rev`) PK、`base_rev`、`source_kind`（user/agent/script/external）、`source_id`、`session_id`、`tool_call_id`、`write_set`、`mutations`、`inverse`、`created_at` | 文档日志；保留策略见 [07 §5](07-workbook-engine.md#5-文档日志与检查点) |
| `doc_snapshots` | `doc_id`、`rev`、`blob_sha256` | 可选：大文档定期快照，加速打开与重放 |
| `leases` | `doc_id` 或 `path`、`agent_id`、`scope`（整文件或区域） | 写租约 |
| `backups` | `id`、`workspace_id`、`original_path`、`backup_path`、`sha256`、`session_id`、`agent_id`、`size`、`created_at` | 修改前备份 |
| `blobs` | `sha256` PK、`media_type`、`size`、`ref_count`、`created_at` | 内容寻址存储的索引 |

代理读集（`agent_id`、`doc_id`、区域、`rev`）保存在内存中，会话卸下时丢弃；恢复后从 `agent_context` 中的读取类工具结果重建（只需近似，最坏情况是多一次冲突后重读）。

## 4. 密钥【硬性】

- 主密钥：32 字节随机数，首次启动生成。
  - 桌面：`safeStorage` 加密后存为 `master.key.enc`（macOS Keychain / Windows DPAPI）。
  - 本机 Web：`master.key`，仅当前用户可读（macOS/Linux `0600`；Windows 仅当前用户的 ACL）。
  - 服务器（P2）：环境变量或挂载的密钥文件。
- API Key、OAuth 令牌、MCP 敏感字段用主密钥 AES-256-GCM 加密，每条记录独立随机 nonce。
- 读取接口只返回掩码；更新时未修改的密钥字段不回传明文。
- 日志与错误信息脱敏；会话日志中不得出现密钥（写入前过滤）。
- 丢失主密钥 = 已存凭据不可恢复，界面提示重新输入。

## 5. 迁移与备份

- 迁移为顺序编号的 SQL 文件，由各模块提供，只向前；数据库版本高于程序版本则拒绝启动。
- 迁移前复制数据库为 `excelmanus.db.bak-<版本>`（保留最近 3 份）。
- 会话日志记录类型的格式演进：新增字段可选；不兼容变化使用新的记录类型名，旧类型的读取代码保留（日志是永久数据）。
- 设置中提供"导出设置"（模型档案、MCP、规则、技能状态；**不含密钥**）与"导入设置"。

## 6. 清理

| 数据 | 策略 |
| --- | --- |
| 删除会话 | 删除其会话日志与全部投影；不删除工作区文件、备份与文档日志 |
| 文档日志 | 见 [07 §5](07-workbook-engine.md#5-文档日志与检查点) |
| 内容寻址存储 | 引用计数为 0 后 7 天清理 |
| 备份、回收站 | 见 [07 §7.3](07-workbook-engine.md#73-保留策略推荐) |
| 缓存 | 可随时删除 |
| 日志 | 保留 14 天 |
| 数据库 | 每周空闲时 `VACUUM`（可关闭） |
