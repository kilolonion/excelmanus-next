# M3 可靠性首段验收记录

日期：2026-09-30（Asia/Shanghai）

本轮开始推进 M3，先交付不改变 M2 主路径的基础纵切：

- 文件租约：SQLite `leases` 表、整批 acquire、文件/区域重叠检测、写工具执行前检查、代理关闭释放。
- 预算：子代理默认步数 60、主代理默认步数 200；超限写 `budget` 指引并安全结束当前轮。
- 收件箱：`inbox_pending` 投影、`inbox.sent/inbox.delivered` 日志，代理步骤边界注入 `<inbox>` 消息。
- 子代理工具：`agent_spawn`、`agent_send`、`agent_wait`、`agent_status`、`agent_control`；角色和派生深度限制已接入窄纵切。
- 多代理共享会话日志与恢复所需的 agent 投影保持不变。

证据：

- `packages/kernel/test/leases.test.ts`：区域租约冲突/释放、预算解析与超限判断，3 项通过。
- `packages/kernel/test/agents.test.ts`：子代理角色/深度/消息与投影，7 项通过。
- M2 回归测试继续通过。
- 本阶段完整门禁以 M3 代码收口后再跑一次；当前不重复运行大规模模糊测试。

未完成：团队视图 UI、跨进程完整多代理恢复 e2e、消息乒乓检测、全体等待检测和会话级累计 token 上限。这些继续作为 M3 后续小步。

## 收口证据

- `pnpm check:all`：18 个测试文件、78 个测试通过。
- 租约冲突与释放、预算限制、子代理派生/消息投影、M2 审批/提问/工作簿回归均通过。
- 当前 M3 仍是首段纵切：团队视图、跨进程多代理恢复 e2e、消息乒乓/全体等待检测和累计 token 预算继续后续推进。

## M3 第二段可靠性收口（2026-09-30）

- 跨进程恢复：服务重启后 `running/waiting` 代理变为 `interrupted`，未决副作用调用不自动重放。
- 失控检测：代理互发消息超过阈值会暂停并通知 main；`all_idle` 等待在全体 waiting 且无 pending inbox 时提前结束。
- 累计预算：步骤、工具调用和 token 用量持久化；跨轮/重启继续受 `maxTokens`、`maxToolCalls` 限制。
- 真实 server/SQLite 重启 e2e 和代理恢复测试已加入。
- 最终 `pnpm check:all`：18 个测试文件、81 个测试通过。

## 团队视图首段（2026-09-30）

- 侧栏显示当前会话代理名册和状态，团队信息从真实 session detail 加载。
- 子代理恢复、等待、消息投递和预算/租约状态仍以服务端日志与 SQLite 为事实源。
- 当前完整门禁：18 个测试文件、81 个测试通过。

## 消息派发三策略（2026-09-30）

实现范围（04 §4.1–4.3、§8.3；02 §3.2；11 契约）：

- `agent_context` 投影改为在 `dispatch.updated` 且 `status=applied` 时才把对应 `user.message` 写入上下文（根因修复：排队/撤回消息不再进入当前轮视野）。
- `AgentActor` 内存队列条目化为 `{ dispatchId, mode } | { inbox: true }`：steer 在步骤边界一次性写 applied 注入本轮、轮末残留并入下一轮；interrupt 中止当前模型请求/工具/审批等待并立即开新轮；queue 在轮结束后按到达序各自开轮。取队列前按 `dispatches` 表丢弃已撤回/已应用条目。
- 停止挂起（04 §4.2）：stop 清空内存队列但不消费，DB 保持 `queued`；`POST .../agents/{id}/resume` 从持久化表按消息 seq 重新入队，无挂起且代理 interrupted 时开一轮继续轮。进程重启后 queued 派发保持挂起不自动运行。
- `DELETE /sessions/{id}/dispatches/{dispatchId}`：accepted/queued → cancelled（幂等重放 200）；applied/failed → 409；不存在 → 404。
- 发送消息默认 `mode=steer`；幂等比较的缺省 mode 同步为 steer。blocked 且非运行（重启待审批）代理：steer/queue 持久化 queued 挂起，interrupt 以「用户发送了新指令」拒绝待审批后开新轮；待回答提问仍 409。
- 审批/提问决定的 resume 路径结束后调 pump，等待期间排队的消息继续运行。
- Web：消息下方派发状态文案（引导 · 等待下一步 / 打断 · 正在停止当前任务 / 排队 · 前面还有 N 条 / 排队 · 下一条 / 已生效 / 已撤回 / 失败，accepted 不显示）、未应用消息「撤回」按钮（成功后原文回输入框）、composer 分段模式选择（默认引导，aria-label）、运行中同时显示发送与停止、非运行且有排队时显示「有 N 条排队消息 + 继续发送」、interrupted 无排队显示「继续」。状态经 `dispatch.updated` 回放恢复，刷新一致。

测试证据（真实 HTTP/WebSocket/SQLite 文件 + MockLanguageModelV4 可控 gate，记录每次调用 prompt）：

- `packages/server/test/e2e-dispatch.test.ts`（9 用例，对应 04 §4.1 三策略、§4.2 停止挂起、§4.3 撤回幂等、§8.3 继续、14 场景 8）：
  - steer 步骤边界注入同轮（仅 1 个 turn.started，第二次调用 prompt 含引导文本）；
  - steer 残留轮末进下一轮；queue 两条不进当前轮、轮后按序各开一轮；
  - interrupt 模型请求中：turn.interrupted → 新 turn.started，新 prompt 含打断文本；
  - interrupt 等待审批（confirm 模式）：approval.decided denied 理由「用户发送了新指令」、tool.result APPROVAL_DENIED、新一轮开始；
  - 撤回：DELETE queued → cancelled 且未进任何 prompt，重复 DELETE 幂等 200，applied 派发 DELETE 409；
  - 停止挂起：stop 后 turn.interrupted、无新轮、派发保持 queued，resume 后运行并 applied；
  - 跨进程：不清理直接关服务、同 SQLite 重启后派发仍 queued 不自动运行，resume 后执行；
  - 空闲代理三种策略均 accepted 直接开轮。
- `packages/kernel/test/rebuild.test.ts` 新增用例：applied 才进 `agent_context`，queued/cancelled 不进；清投影重建与增量一致（10 §3.3）。
- `packages/web/test/reduce.test.ts` 新增 2 用例：dispatch.updated 驱动 dispatchStatus/撤回幂等；queueAhead/queuedCount 排队位置口径。

实际执行命令与结果：

- `pnpm typecheck`：15 个包全部 Done，无错误。
- `pnpm check:deps`：通过（22 个包，220 模块 / 466 依赖无违规）。
- `pnpm exec vitest run --project kernel --project web`：5 文件 18 测试通过。
- `pnpm exec vitest run --project server`：6 文件 16 测试通过。
- `pnpm test`（全量）：19 个测试文件、93 个测试全部通过。
- `pnpm lint`：本批改动文件全部干净；仓库级 `biome check .` 仍有 8 个历史/并行 `spikes/*` 文件告警与错误（未触碰，按约定保留并行未提交内容）。

已知限制：

- `resumePersistedApproval` 批准后只收口本轮（写 tool.result + turn.completed），不继续执行该轮剩余工具调用，属场景 9（重启恢复纵深）后续工作。
- 未做浏览器实机验证（UI 由 reduce 测试与状态回放覆盖）。
- 契约中列出的 `POST /sessions/{id}/stop-all` 不在本批范围，仍未实现。

## 上下文压缩（2026-09-30）

实现范围（04 §6/§6.1/§6.3、10 §3.3、11 §4、14 场景 12 与场景 22 的超限部分）：

- 契约：`ResolvedModel.contextWindow`（服务端由 `model_profiles.context_window` 填充）；新日志记录 `compaction { trigger, summary, keepFromSeq, beforeTokens, afterTokens, estimated }`；`usage.updated` 增加可选 `context { tokens, window, estimated }`；`CompactResponse` + `client.compactAgent`；`POST /sessions/{id}/agents/{agentId}/compact`（会话/代理 404、closed 409、摘要失败 502 `compaction_failed`）。
- `kernel/compaction.ts` 纯函数：`estimateTokens`（JSON 字符数 /4 向上取整）、`keepBudgetTokens`（窗口已知取 20%，否则取当前估算 20%）、`planCompaction`（尾部预算切点，切点不落在孤立 toolResult 上，old 少于 2 条返回 null）、`transcriptForSummary`（`【用户】/【助手】/【调用工具 x】/【工具结果 x】` 纯文本转录，单条 4000 字符截断）、`COMPACTION_SYSTEM`/`COMPACTION_PROMPT` 按 handoff 原文。
- `agent_context` 投影处理 `compaction`：全部现条目置 `superseded=1`（不删行），追加 `<summary>` 摘要条目，再按 `tailFrom` **按位置**取尾——在按 idx 排序的活跃条目中找到第一条 `from_seq === keepFromSeq`，复制它及之后全部条目（item 与 from_seq 原样）；找不到则不保留尾部。删除旧行不删数据；删表重建与增量一致。
- 运行时：每步成功后记 `lastContextTokens`（提供商 input+output，无报告回退字符估算）；步骤边界（steer 注入、inbox 投递之后、读 history 之前）占用 ≥80% 窗口时 auto 压缩并继续同一轮；模型调用分类为 `context_overflow` 时以 trigger `overflow` 压缩后重试该步一次，再次超限走 `turn.failed` + context_overflow 指引；`runtime.compact` 空闲时占用 actor 立即执行（不写 turn.*、消息照常入队、结束 pump），运行中排期到下一步边界（trigger manual）。摘要调用用同一 ResolvedModel，不传 tools、不发 delta、不写 model.output；auto 触发下摘要失败只发 `compaction.failed` 诊断事件并跳过，不阻塞本步。
- Web：`compaction` 记录渲染为可展开块「已压缩上下文 · 约 N → M tokens」，摘要经现有 Markdown 消毒路径渲染；`usage.updated.context` 驱动输入框旁「上下文 约 N%」占用显示（window 为 null 不显示）；`/compact` 与 `/resume` 斜杠命令（不走消息派发），/compact 按结果提示「将在下一步前压缩」/「暂无可压缩的内容」。文案均在 strings.ts。

测试证据（真实 HTTP/WebSocket/SQLite + MockLanguageModelV4，profile `contextWindow=400`，可控 usage/超时错误构造）：

- `packages/kernel/test/compaction.test.ts`（12 用例）：估算、空/过短历史返回 null、零预算全摘要、切点不落在 toolResult、assistant toolCalls 与 toolResult 同侧、转录格式与截断、提示词六节标题、`tailFrom` 按位置取尾（非单调 from_seq 下不误复制旧摘要）。
- `packages/server/test/e2e-compaction.test.ts`（7 用例）：
  - 场景 12 auto：上轮 usage=390/窗口 400 → 下一轮步骤边界 compaction(trigger auto)，同轮继续（无第二个 turn.started）；之后主调用 prompt 含 `<summary>` 与「表头口径：B 列为含税金额」、含保留尾部、不含被摘要的最早用户消息；`usage.updated.context` 上报窗口 400。
  - 工具历史：保留尾部第一条不是 toolResult，主调用 prompt 中每个 tool 结果都有对应 assistant tool-call 部件（AI SDK 转换通过）。
  - 场景 22 overflow：`APICallError(400, "prompt is too long")` → compaction(trigger overflow) → 同轮重试成功完成；连续两次超限 → `turn.failed` + `error.guidance(context_overflow)`，仅重试一次。
  - manual：空闲 POST `/compact` → `compacted:true` 且无 turn.*；运行中 POST → `scheduled:true`，manual 压缩落在下一步 step.started 之前；空历史 → `compacted:false`。
  - auto 摘要调用抛错：本步照常执行完成，日志无 compaction 记录。
- `packages/kernel/test/rebuild.test.ts`：随机会话生成器以 ~30% 概率夹带 `keepFromSeq=null` 压缩记录；专项用例断言 superseded 标记、摘要+尾部复制（from_seq 保留原值）与重建一致；连续两次压缩用例断言第二次切点落在首次保留尾部时活跃上下文恰好一个 `<summary>`、无重复、顺序正确且重建一致。
- `packages/web/test/reduce.test.ts` 新增 2 用例：compaction 块与占用更新、无 context 字段的 usage.updated 不改占用。

实际执行命令与结果：

- `pnpm typecheck`：全部包 Done，无错误。
- `pnpm exec biome check`（本批 19 个改动文件）：干净（曾自动修复格式与两处 noUnsafeOptionalChaining）。
- `pnpm check:deps`：通过（22 个包，223 模块 / 480 依赖无违规）。
- `pnpm exec vitest run --project kernel --project web`：6 文件 34 测试通过。
- `pnpm exec vitest run --project server test/e2e-compaction.test.ts`：7 测试通过。
- `pnpm exec vitest run --project kernel --project server`：12 文件 47 测试通过。
- `pnpm test`（全量）：21 个测试文件、116 个测试全部通过。

已知限制：

- 摘要调用复用本代理的 ResolvedModel；09 的「压缩摘要专用模型」用途分配尚无配置基础设施。
- 自动压缩开关设置 UI 未实现（`AgentRuntimeDeps.autoCompact` 已支持关闭，默认开）。
- 无提供商用量时按字符数 /4 估算 token；压缩记录 `estimated` 标记该口径。
- 未做浏览器实机验证。

## run_script（2026-09-30）

实现范围（08 全章、06 §4.6、03 §6.3、04 §8.2、14 场景 16/17；ADR 0001 全部设计点 + ADR 0009 范围收口）：

- `packages/sandbox`（依赖仅 protocol/core + `quickjs-emscripten@0.32.0` / `@jitl/quickjs-wasmfile-release-sync@0.32.0` 精确锁定）：`SandboxPool` / `SandboxHost` / `SdkCallError` / `RunOutcome`。worker_threads + RELEASE_SYNC 变体 + 宿主 Promise 桥；每次运行新建 runtime+context；预热池=并发上限=2、其余排队；参数与返回值在 VM 内 `JSON.stringify`；墙钟看门狗 `timeoutMs + 250ms` 到点 `worker.terminate()` 并 abort 在途宿主调用；`setMaxStackSize(1MB)`；删除 `SharedArrayBuffer`；memory/output 终止的 worker 回收补位、意外退出归 `crash`（对外仍 SANDBOX_ERROR）；stdout 尾部 200 行 / 64KB、返回值 1MB、单次 SDK 传输 32MB、SDK 在途上限 64；脚本支持顶层 `await`/`return`（外包 async IIFE，`line` 校正回用户源码行号）。
- `packages/server/src/script.ts`（装配层工具，`effect:"write"`、`targets:[]`、`replay:"unsafe"`、`timeoutMs:310s`、roles main/lead/worker）：SDK host = `wb.read`/`wb.analyze`（拒 saveTo）/`wb.edit`（缓冲 ChangeSet，同文档按序拼 ops，拒 dryRun/baseRev）/`files.find`/`files.readText`（暂存叠加优先）/`files.writeText`（写 `.excelmanus/tmp/script-<toolCallId>/` 暂存并记首见哈希）。发布：租约 `assertAvailable(mainBypass)` → 工作簿按首触顺序 `svc.submit`（`source.kind:"script"`，走与 agent 同一条路径自动备份；create 走 create→submit→checkpoint，失败 discardCreated）→ 文本按 expectedVersions/首见哈希校验（不符 VERSION_CONFLICT）→ `ensureBackup` + 原子 rename + `markCreated`；任一步失败按逆序回滚（已提交工作簿 `svc.revert`、新建丢弃、已替换文本从暂存恢复、新建文本删除），回滚不完整返回 `uncertain` + `unrecovered`；结尾恒清暂存目录。`recover`：`committedByToolCall` 有提交 → `uncertain`（"脚本发布可能部分完成"），无 → `not_executed`，两者均清暂存。结果映射：ok → `{value, stdout, published, docRevs}`；scriptError → SANDBOX_ERROR 带「第 N 行」；timeout → TIMEOUT；memory/output → LIMIT_EXCEEDED；cancelled → CANCELLED；crash → SANDBOX_ERROR(detail=crash)。
- `packages/modules/workbook/src/service.ts` 新增 `committedByToolCall/committedByToolCallAll` 与 `revert(docId, root, rev, source, sessionId, toolCallId)`：普通 inverse 直接按存储的还原 mutation 提交为新修订；`needsSnapshot` 型用存入 `doc_ops.inverse` 的 preSnap 经 `snapshotRestoreMutations` 重建还原 mutation，走同一 `doSubmit` 路径（写 doc_ops、广播）。
- `server/index.ts`：创建 `SandboxPool`（size 2）、注册 `run_script`、close 时 `pool.close()`。

测试证据（真实 HTTP/WebSocket/SQLite + MockLanguageModelV4；工作簿用 samples/sales.xlsx 实体复制）：

- `packages/sandbox/test/escape.test.ts`：51/51 逃逸用例全拦截（判据文件自 spike 复制为 `test/fixtures/escape-cases.json`；路径穿越类用例的 host 用与 server 相同的 `resolveWorkspacePath` 等价替身——见下方归属说明）。覆盖全局隔离、宿主对象、原型污染、返回值滥用（R01/R03/R05）、资源耗尽（X01–X11：死循环/深递归/大分配/灾难性正则）、SDK 边界（S08 32MB 传输、S09 并发、S10 接口面精确）、终止与隔离（T01/T04）。
- `packages/sandbox/test/pool.test.ts`（7 用例）：三类终止后池仍可用（宿主存活 + worker 补位）、并发上限 2、>32MB SDK 传输受限、signal abort → cancelled、TS 与 JS 输入的行号各自正确、crash 归类。
- `packages/server/test/e2e-script.test.ts`（7 用例）：
  - 场景 16：脚本处理到第 3 个文件后 `throw` → `tool.result` SANDBOX_ERROR 且 message 含「第 4 行」、5 文件 sha256 不变、`doc_ops` 无该 toolCallId、`.excelmanus/tmp` 无 script-* 残留。
  - 成功批量：5 文档各 +1 rev（doc_ops 恰 1 行/doc、rev 与 `docRevs` 一致）、B2 读回「脚本写入」、checkpoint 写回后文件哈希变化、文本落盘、脚本内 `files.readText` 读到暂存叠加内容、`published` 恰 6 条。
  - 发布失败回滚：doc1 合法提交 + doc2 指向不存在工作表 → BAD_OPERATION、doc1 被 `revert` 逆操作回退（单元格复原、doc_ops 两条）、`rolledBack` 含 doc1、文本未替换。
  - 场景 17：`while(true){}` + `timeoutSeconds:1` → 约 1.1s 内 TIMEOUT；期间 `GET /api/v1/sessions` <200ms；随后正常脚本成功（池补位）。
  - 取消：运行中 `stop` → CANCELLED + `turn.interrupted`，无发布（文件哈希不变）。
  - 路径安全：`files.writeText` 写 `../x` → SdkError(OUT_OF_WORKSPACE)；写 `.excelmanus/…` → NOT_FOUND；经外指符号链接写与读、悬空符号链接写均被拒，无发布。
  - recover：无提交 → `not_executed` 且暂存目录删除；有提交 → `uncertain` 且暂存目录删除。

实际执行命令与结果：

- `pnpm typecheck`：全部包 Done，无错误。
- `pnpm exec biome check`（本批改动文件，含 ADR）：0 错误（`--write` 修过 format/organizeImports；`noNonNullAssertion` 等为仓库既有告警级）。
- `pnpm check:deps`：通过（22 个包，237 模块 / 525 依赖无违规；sandbox 只依赖 protocol/core）。
- `pnpm check:licenses`：通过（345 个依赖）。
- `pnpm exec vitest run --project sandbox`：2 文件 58 测试通过（escape 51 + pool 7）。
- `pnpm exec vitest run --project kernel --project server`：13 文件 54 测试通过。
- `pnpm test`（全量）：24 个测试文件、181 个测试全部通过。

已知限制：

- 三平台只在 macOS arm64 验证；x64/Windows x64 未测（沿用 ADR 0001 跟进项）。
- reader 角色的只读模式未做，`roles` 只声明 main/lead/worker。
- 脚本内 `wb.read`/`wb.analyze` 对本脚本已缓冲 `wb.edit` 的文档报 `UNSUPPORTED_FEATURE`（原"不叠加、静默读已发布"已收紧为报错，ADR 0009 修订）；文本文件有暂存叠加。
- 审批为发布时：`ToolDefinition.approval: "publish"` 跳过执行前审批，脚本跑完后以 `publishPlan`+`planHash` 走 `ctx.requestApproval`（confirm 模式批准才发布；standard 不审批）；重启已批准重跑核 `planHash`（ADR 0009 修订）。
- `wb.export`、`files.manage` 不在本批 SDK 范围。
- 逃逸用例中的路径穿越/符号链接类归属说明：判据保留在 `packages/sandbox` 套件（host 替身复用 `resolveWorkspacePath` 同一函数），server e2e 里另有一组真实 `files.writeText`/`readText` 穿越用例兜底真实路径。

## 迁移修复、场景 9 继续执行、stop-all（2026-09-30）

- **具名迁移**（`packages/kernel/src/migrations.ts` + `db.ts`）：`Migration { id, sql }` 替代全局序号；`openDb` 维护 `schema_migrations` 表按声明顺序补执行（迁移前 `.bak-<n>` 备份）；未知已应用 id → `SchemaVersionError` 列名；旧库（`meta.schema_version`、无 `schema_migrations`）一次性探测引导——迁移 SQL 中的 `CREATE TABLE/INDEX`、`ALTER TABLE … ADD COLUMN` 全部已存在 → 记已应用，全部不存在 → 待执行，部分存在 → 抛不一致错误；引导后删除 `meta.schema_version`。LEASES 建表已去重。
- **场景 9（04 §5.2）**：`runtime.ts` 的 `runTurn` 拆出 `continueTurn(turnId, startStep)` 共享步骤循环；`resumePersistedApproval`/`resumePersistedQuestion` 写 `tool.result` 后执行原 `model.output` 中排在其后、尚无 `tool.result` 的剩余调用（`executeCalls`，逐个重走审批），再以同一 `turnId` 续步骤循环至 Completed/Interrupted/Failed；预算步数从日志中该 turn 已有 `step.started` 条数续算；恢复期间 `_running = true`，结束照常 `pump`。
- **`POST /api/v1/sessions/:id/stop-all`（11 §147）**：`StopAllResponse = { ok: true, stopped: string[] }`（protocol/rest.ts + `ApiClient.stopAll`）；app.ts 逐个 `runtime.stop` 会话内代理，返回实际停止的 agentId。

测试证据：

- `packages/kernel/test/migrations.test.ts`（2 用例）：旧式序号库（按 HEAD 旧顺序应用部分迁移 + `meta.schema_version=3`）经新列表 `openDb` → 缺的表补齐、已有数据保留；库内未知迁移 id → `SchemaVersionError`。
- `packages/server/test/e2e-approval.test.ts`（1 用例，真实 HTTP/SQLite 两次启动）：confirm 模式写工具 → `approval.requested` → 关闭服务 → 同数据目录重启 → POST 批准 → 工具执行（文件落盘）、第二次模型调用 prompt 含 `write-1` 结果、`turn.completed`，全程仅一条 `turn.started`；对同一审批重复 POST 仍 200（幂等）。
- `packages/server/test/e2e-dispatch.test.ts` 新增 1 用例：main `agent_spawn` 派生 reader 子代理（完成后 idle），第二轮 `ask_user` 挂起 → `stop-all` 返回 `stopped: ["main"]`，出现 `turn.interrupted`，空闲子代理不在列表中。
- 真实数据副本验证：`cp -R ~/.excelmanus-next /tmp/emx-copy` 后以 `node packages/server/src/main.ts --data-dir /tmp/emx-copy` 启动，旧库探测引导 + 迁移补执行完成后正常监听；进程结束后删除副本，原数据目录未动。

实际执行命令与结果：

- `pnpm typecheck`：全部包 Done，无错误。
- `pnpm exec biome check`（本批改动文件）：0 错误（`--write` 修过 format；`noNonNullAssertion` 为仓库既有告警级）。
- `pnpm exec vitest run --project server test/e2e-approval.test.ts`：1/1 通过。
- `pnpm exec vitest run --project server e2e-dispatch -t stop-all`：1/1 通过。
- `pnpm test`（全量）：25 个测试文件、184 个测试全部通过。
