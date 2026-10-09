# 工作簿观察与格式修复冲突验收

- 日期：2026-10-01，Asia/Shanghai。
- 环境：macOS arm64，Node v24.1.0，pnpm 10.11.0，Univer 1.0.2。
- 依据：[ADR 0018](../decisions/0018-workbook-observations-and-derived-mutations.md)、03 §6、06 §4、07 §3/§10、11 同步通道。
- 范围：本次用户提供的“填充内容和样式 → 截图 → 格式修复反复冲突”链路；不改写原文档历史，不更改安全/许可证/依赖门禁配置，保留并行工作树改动。

## 根因证据

只读检查用户提供文档 id 的修订元数据，未输出文件值、公式正文或提示词内容。修订 3 实际为 `user` 来源，携带四条没有用户命令 `trigger` 的派生 mutation：公式状态、数组公式状态、计算值与公式索引回填。其写集含两个整表范围，另两个范围是稀疏值的包围矩形。元数据证据：[incident-metadata.json](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/incident-metadata.json)。

截图工具返回修订 3，却未更新代理读集。局部重读 A15:I19 后，旧读集在其他区域上的依赖仍受这条虚假用户修订影响；显式 `baseRev:3` 不会清除这些保护。原记录最终通过整块 A1:I19 重读后提交了修订 4，因此问题并非版本号永远无法前进。

## 修复

1. 前端与文档 actor 共用 `core/isDerivedWorkbookMutation`：工作台不发送公式内部状态和无用户命令 trigger 的计算结果；服务端也整批拒绝这些客户端提交。真实用户的值、公式、样式修改仍可提交。
2. 成功截图按实际渲染范围及快照修订记入读集；上下文重建识别 `workbook_render` 结果的 `range/docRevs`。失败或被裁掉的区域不作为截图观察。
3. 稀疏矩阵写集覆盖实际格；同行列段和相邻行相同列段合并。空矩阵不再扩大到整表；未知/缺失范围仍保守处理。
4. 冲突检查从交集扣除精确重读区域的并集；只报告尚未确认部分。粗粒度读集、被删区域和未重读空洞仍受保护，显式 baseRev 不绕过旧依赖。

## 门禁

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm check:all` | 通过，退出码 0；52 files / 330 tests | [完整输出](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/check-all.log)，22:28 开始，测试 59.07 秒 |
| TypeScript、Biome、依赖方向、许可证、Web 生产构建 | 通过（Biome 原有警告保留）；461 modules / 1272 dependencies，494 个依赖，沿用原构建期许可例外 | 同上 |
| 聚焦核心区域与工作簿并发测试 | 2 files / 29 tests 通过 | [focused.log](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/focused.log) |
| `git diff --check` | 通过 | 本轮执行退出码 0、无输出 |

首次完整门禁及一次依赖扫描重试遇到 `packages/web/dist/assets/index-*.js` 的 ENOENT；后续稳定重跑依赖检查与完整门禁通过。保留[首次失败输出](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/check-all-before-retry.log)，没有改变检查规则。

## 场景与验证边界

| 场景 | 结果 | 可复跑证据 |
| --- | --- | --- |
| 真实 Univer 命令产生的值/公式、样式 mutation 保留 trigger；公式状态与无 trigger 计算结果被分类为派生事件 | 通过 | `packages/modules/workbook/test/concurrency.test.ts` 真实引擎事件用例 |
| 成功截图记录实际范围、修订；从真实 SQLite agent_context 重建后仍有截图读集 | 通过 | 同用例 |
| 稀疏写集不覆盖矩阵中间未改格；精确重读后继续写入 | 通过 | 同文件稀疏写集用例 |
| 多次重读合并覆盖旧读集，未读空洞仍冲突；不同表和 Excel 边界正确 | 通过 | 同文件分块重读用例、`packages/core/test/doc-range.test.ts` 区域扣除用例 |
| 四类真实故障形状的派生回传经 HTTP/WS/SQLite 边界拒绝，不生成 user 修订 | 通过 | `packages/server/test/e2e-doc.test.ts` 公式派生回传用例 |
| 填充报表 → 成功截图 → 真正用户改 C17 → 格式提交冲突 → 重读 A15:I19 → 显式 baseRev 提交格式成功 | 通过 | 同用例；真实模型替身只输出指定工具调用，运行时/工具/引擎/日志/网络均为产品代码 |
| 格式结果保留用户值；千分位、百分比、填充与公式缓存进入截图布局和 xlsx 检查点 | 通过 | 同用例；验证布局数据与文件回读，非浏览器像素验收 |

全量门禁后，追加对合计行百分比的精确文本 `616.9%`、公式缓存及数字格式回读断言，22:32 定向复查 1 file / 3 tests 通过，耗时 9.91 秒，见 [e2e-final.log](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/e2e-final.log)。[服务端类型复查](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/server-typecheck-final.log)及[目标文件 Biome 检查](../../.agents/tasks/workbook-reread-conflicts-2026-10-01/lint-final.log)通过。

## 已知边界

- 本轮没有修改真实用户文件。原运行中的后端需重启、页面需刷新，才能同时加载服务端守卫和前端过滤。
- WS 渲染客户端是协议/布局验证端，返回固定有效 PNG；没有把该图片当成报表截图正确性的证据。未做浏览器 canvas 像素、Windows/Electron 打包或真实模型自主行为验收。
- 原有历史中的错误 user 修订保留，不作清洗或自动重放。真实用户修改仍需重读实际冲突区域。
- 全量测试仍打印此前已知的 QuickJS `JS_FreeRuntime` 清理断言；Vitest 330 条全部通过、总命令退出码 0。本轮没有修复该清理告警，也不宣称 M6 全部完成。
