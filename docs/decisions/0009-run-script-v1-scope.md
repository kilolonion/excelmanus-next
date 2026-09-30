# 0009 run_script v1 范围：读不叠加脚本写入、执行前审批、装配层落位

- 状态：已接受（2026-09-30 修订）
- 日期：2026-09-30

## 背景

M3 把 `run_script` 工具接入运行时。沙箱本体按 ADR 0001（QuickJS 同步变体 + worker_threads + 宿主 Promise 桥）落进 `packages/sandbox`；本 ADR 只决定三个范围的收口，覆盖 08 §4–§6 中与本批相关的可选项：

1. **脚本内 wb.read 是否叠加本脚本缓冲的 wb.edit 写入**：08 §4 推荐"脚本内再读应能看到自己刚写的内容"（overlay）。overlay 需要在活文档 actor 上应用再撤销未发布的 mutation，与文档广播、冲突检测、检查点写回耦合；活文档是逐字节保真红线（AGENTS §5）下最不允许做假的一条路径。
2. **审批时机**：08 §6 推荐发布时审批（脚本跑完、diff 出来再让用户确认）。这要求发布前可展示的内容（跨工作簿 mutation + 文本 diff）先全部物化，且审批通过前暂存不能清理；等待期里活文档可能被别的写入者推进，审批通过时的 baseRev 已经过期。
3. **工具落位**：`run_script` 要组合 workbook 与 files 两个模块的能力，而模块之间禁止互相依赖（AGENTS §12）；它只能落在装配层。

SDK 子集本批只做：`wb.read / wb.analyze / wb.edit / files.find / files.readText / files.writeText / console.log`。`wb.export`、`files.manage` 不在本批（导出与文件管理在工具层各有独立语义，脚本内由既有工具承担更安全）。

## 选项

### 选项 A：按 08 §4/§6 原文做 overlay 读取 + 发布时审批

- 优点：脚本内读写一致；用户在发布前能审 diff。
- 缺点：overlay 要在文档 actor 里做"应用-读-撤销"影子状态，rev 分配与广播语义都要为它开口子；发布时审批要在暂存上多维护一份 diff 视图并处理审批期间的外部修订。
- 风险：两条都碰到活文档唯一写入者与先落库后写回的约束，做错即破坏文件。

### 选项 B：v1 收口——读不叠加、执行前审批、装配层实现

- 做法：
  - `wb.read` 直接调 `workbook_read` 工具，读的是已发布修订；`wb.edit` 只缓冲 ChangeSet 不落库。脚本"先写后读同一工作簿"拿不到自己的写入——在工具 description 里明确声明，引导用户改用 `files.readText`（文本文件**有**暂存叠加）或分两次脚本。
  - 审批沿用既有 `effect: "write"` 判定：`confirm` 模式在**执行前**审批（审批卡片展示脚本源码本身，比事后 diff 更贴近"用户要批准的东西"）；`standard` 模式按写入自动备份（`svc.submit` 对 `source.kind==="script"` 与 `agent` 同路径走 `backups.ensureBackup`，文本覆盖前同样 `ensureBackup`/`markCreated`）。
  - 工具放 `packages/server/src/script.ts`（装配层），`server/index.ts` 注册；SDK host 在工具内用 `wb.read`/`wb.analyze`/`files.*` 既有工具的 execute 复用，不另起一套文件实现。
- 优点：不碰活文档内核；审批语义与所有其他写工具一致；发布一旦开始不响应取消、要么完成要么按逆序回滚（工作簿 `revert` + 丢弃新建 + 文本从暂存恢复 + 删除新建），回滚不完整显式报 `uncertain`。
- 缺点：脚本内自写自读不一致（缓解：文档说明 + 文本叠加保留 + 分次脚本）；用户在执行前看不到 diff 预览（缓解：confirm 模式展示完整源码，发布结果带 published 清单与 docRevs）。
- 风险：低——不引入新的文档状态机路径。

## 决定

选 B。明确推翻/修订 08 原文的两条【推荐】：

- 08 §4 "脚本内再读自己写的工作簿应看到缓冲内容" → v1 不实现 overlay；文本文件叠加保留。
- 08 §6 "发布时审批" → 改为执行前审批（`effect: write` 走既有 `needsApproval` 路径）。

SDK 范围限定为上面列出的子集；`wb.export`、`files.manage` 留待后续需要时以独立工具语义接入。

## 后果

- 正面：活文档写入路径零分支（`svc.submit` 对 script 来源与 agent 完全同构，自动备份天然生效）；发布失败按逆序回滚有实测（e2e 回滚用例验证 doc_ops 逆操作行、单元格复原、文本未替换）；`recover` 用 `committedByToolCall` 区分 uncertain/not_executed 并清暂存。
- 负面 / 代价：脚本作者不能在一次 run 里"写了马上读"；审批在跑代码之前而非 diff 之后。
- 需要跟进：overlay 读取、发布时审批、`wb.export`/`files.manage` 脚本入口、reader 角色的只读模式（本批 roles 只给 main/lead/worker）。

## 验收标准符合性

- **14 场景 16**（中途失败全部丢弃）：e2e 覆盖——第 3 个文件处 `throw`，5 文件 sha256 不变、doc_ops 无该 toolCallId、暂存目录清空；失败时发布未开始，overlay 缺位不影响该判据（判据要的是"失败全丢弃"，不是"自写自读"）。
- **14 场景 17**（死循环可终止且宿主健康）：`while(true){}` 1s 超时 TIMEOUT、期间 REST 仍 <200ms、池自动补位后正常脚本成功。
- **08 §2 威胁模型**：逃逸面由 `packages/sandbox` 51 例覆盖（全局隔离、宿主对象、原型污染、资源耗尽、SDK 边界、传输上限、取消/隔离）；路径面由 host 侧 `resolveWorkspacePath` + 暂存目录 + 原子 rename 覆盖（穿越/`.excelmanus`/悬空与外指符号链接各有 e2e）。
- **08 §6 审批**：执行前审批覆盖"用户批准运行这段代码"的安全诉求；发布时审批的优点（看 diff）用 confirm 模式展示源码 + `published`/`docRevs` 结果清单部分补偿。
- **回滚正确性**：e2e 覆盖 doc1 已提交被 `revert` 逆操作回退（doc_ops 多一条 source_kind=script 的回退修订）、doc2 失败返回原错误码、文本未替换；快照型 inverse（`needsSnapshot`）的 revert 走 `snapshotRestoreMutations` 重建。

## 修订（2026-09-30）

本修订恢复 08 §6 的发布时审批、并把写后读从"静默读已发布版本"收紧为明确报错。原决定（选项 B）保留为历史记录。

- **审批时机恢复为发布时**：02 §1 要求"先看见，再同意"——执行前审批只能展示源码，发布时审批能展示真实 diff。原担忧（等待期 baseRev 过期）由两道现成机制化解：其一，发布循环本身携带 `baseRev` + 读集做提交冲突检测，审批窗口内的外部修订会在提交时报 `VERSION_CONFLICT` 并触发逆序回滚；其二，`planHash`（对按路径排序的发布内容摘要做 sha256）随审批卡片入 args，崩溃恢复后的已批准重跑会重算比对，不一致即拒绝发布。实现：工具声明 `approval: "publish"`，运行时跳过执行前 `mustApprove`，改为向 `ctx` 注入 `requestApproval`；`script.ts` 在脚本 ok 之后用 `svc.submit(dryRun: true)` 预演每个工作簿（同时提前拦截 `BAD_OPERATION`/`VERSION_CONFLICT`——失败即按原错误返回，什么都不发布），文本项生成 `diffHead`（前 40 行），组装 `publishPlan` 进审批 args；拒绝 → `APPROVAL_DENIED`（带理由）、不发布、暂存照常清理；等待期 stop → `CANCELLED`。预演失败提前返回使"发布中失败"收窄为真实并发/窗口内变更（e2e 用审批窗口删目录触发真实回滚）。
- **写后读改为明确报错**：`wb.read`/`wb.analyze` 读到本脚本已缓冲 `wb.edit` 的文档 → `SdkError UNSUPPORTED_FEATURE`（提示先读后写或分两次运行）。理由：静默读到过期值会产生看似合理实则错误的结果，比报错更难排查。文本文件的暂存叠加读回保留不变。
- **前端**：审批卡片在 `args.publishPlan` 存在时渲染文件清单（路径、新建/修改徽标、工作簿 ops 数与区域摘要或文本字节数），preview/diffHead 折叠展示。
- **不变项**：overlay 读取（脚本内再读看到自己未发布的 mutation）仍列为后续；`wb.export`/`files.manage` 脚本入口、reader 只读模式不在本批。
