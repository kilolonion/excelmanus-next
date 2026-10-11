# 0004 存储层使用 node:sqlite，中文检索用 FTS5 trigram + 短查询回退

- 状态：已接受
- 日期：2026-09-29

## 背景

10 §2 选定 SQLite 作为唯一持久化来源（WAL、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`），访问纪律要求单事务 < 5 ms、p99 > 20 ms 时移入 worker。10 §3.1 的 `memories` 需要 FTS5。附录 C T-8 要求验证 `node:sqlite` 在 Electron 44 中是否可用、是否含 FTS5。证据：`spikes/node-sqlite/REPORT.md` 与 `results/*.json`。

| 项 | Node 24.1 | Electron 44.4.3 run-as-node | Electron 44.4.3 主进程 |
| --- | --- | --- | --- |
| 免 flag 可用 | ✅（有 ExperimentalWarning） | ✅ 无警告 | ✅ |
| SQLite 版本 | 3.49.1 | 3.53.4 | 3.53.4 |
| 四项 PRAGMA 读回生效 | ✅ | ✅ | ✅ |
| FTS5 / JSON1 | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| 事务 p99（1 条日志 + 1 行投影） | 0.051 ms | 0.055 ms | 0.106 ms |
| SIGKILL 后已提交数据完整 | ✅ | ✅ | ✅ |

中文检索：默认 `unicode61` 分词器把整句中文当作一个 token，子串检索 0 命中；`trigram` 能正确命中 ≥ 3 字的子串，2 字查询 0 命中。

## 选项

### 中文检索

- A：FTS5 `tokenize='trigram'`，查询不足 3 字时回退为 `LIKE '%…%'`（本表数据量小，扫描可接受）。
- B：自带中文分词器（jieba 等）作为扩展。需要原生扩展或 WASM，违反"不引入原生二进制"的倾向，打包复杂。
- C：只用 `LIKE`。数据量大时退化，也无法按相关度排序。

## 决定

1. **存储层直接使用 `node:sqlite`**（`DatabaseSync`），不引入第三方 SQLite 绑定。参数按 10 §2 设置。存储层先在主线程运行：实测 p99 比 20 ms 门槛低约 200 倍，暂不需要"移入 worker"的预案，但接口保持可迁移。
2. **启动时抑制 Node 24 的 `ExperimentalWarning: SQLite`**：只过滤这一条警告，其他警告照常输出。Electron 44 内置的 Node 24.21 本身不报。
3. **中文检索选 A**：`memories_fts` 使用 `tokenize='trigram'`；查询词去空白后不足 3 个字符时，退化为对 `memories.content` 的 `LIKE` 查询（参数化、转义 `%`/`_`）。检索接口对调用方隐藏这一差别。
4. **版本差异**：Node 构建与 Electron 构建的 SQLite 版本不同（3.49 vs 3.53）。迁移 SQL 只用 3.49 已有的特性，CI 在两种运行时各跑一遍迁移测试。

## 后果

- 正面：零原生依赖；桌面版与本机 Web 版用同一套存储代码。
- 负面 / 代价：trigram 索引体积大约是原文的 3 倍；短查询走 LIKE 全表扫描，只适合记忆表这种小表。以后要检索会话全文时需重新评估。
- 需要跟进的事项：
  - **Electron 44 `utilityProcess` 未实测**：本机 shell 会话中 `app.whenReady()` 一直不触发，而 `utilityProcess.fork` 必须在 ready 之后才能调用。桌面版后端按 13 运行在 utilityProcess 里，必须在 M5 之前、在真实桌面会话或带显示环境的 CI 上补测。`node:sqlite` 在主进程中可用，是"utilityProcess 中也可用"的强旁证，但不能代替实测。
  - 附录 C T-8 以本 ADR 关闭（utilityProcess 一项转为 M5 的跟进任务）。

## 验收标准符合性

- 10 §2 访问纪律：单事务 < 5 ms 满足（实测 p99 ≤ 0.11 ms）。
- 01 §5.2 可靠性"进程崩溃不丢失已确认的数据"：SIGKILL 实验 500/500，`integrity_check=ok`。
- 14 §2"真实 SQLite 文件"：契约测试与投影重建测试将使用 `node:sqlite` 打开的真实文件库。

## 修订（2026-09-30）：迁移改为具名 + 旧库探测引导

**原因**：迁移原以 `meta.schema_version`（全局序号）记录已应用条数，且迁移列表是多来源拼接（`[...KERNEL_MIGRATIONS, ...各模块迁移]`）。M3 往 kernel 迁移末尾追加后模块迁移序号整体后移，旧库按旧序号续跑会重执行已应用过的模块建表（`table documents already exists`），阻断启动。

**决定**：

- 迁移改为具名：`Migration { id: string; sql: string }`（如 `kernel/001-base`、`workbook/documents`），`KERNEL_MIGRATIONS`、各 `*_MIGRATION` 常量与 `CapabilityModule.migrations` 统一为该类型。
- `openDb` 维护 `schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`，按声明顺序执行未应用迁移（每条一个事务），执行前照旧备份 `.bak-<n>`（n 为已应用条数）。
- 库含程序不认识的已应用 id → `SchemaVersionError` 并列出未知 id（保留"库比程序新拒绝启动"）。
- 旧库引导（存在 `meta.schema_version`、无 `schema_migrations`）：对每条迁移从其 SQL 自动推导对象——`CREATE TABLE/INDEX x` 查 `sqlite_master`、`ALTER TABLE t ADD COLUMN c` 查 `pragma_table_info(t)`；全部已存在 → 记为已应用，全部不存在 → 待执行，部分存在 → 抛错提示数据库不一致（不自动修）。引导完成后删除 `meta.schema_version`。

**后果**：各来源迁移可独立追加、互不挤占序号；引导规则只适配线性追加的迁移历史，不为人工改乱的数据库兜底（部分存在即拒绝）。
