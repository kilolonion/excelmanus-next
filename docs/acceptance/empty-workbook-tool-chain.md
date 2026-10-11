# 空工作簿工具链修复验收

- 日期：2026-10-01（Asia/Shanghai）
- 环境：macOS arm64，Node v24.1.0，pnpm 10.11.0；本机真实 HTTP、WebSocket、SQLite 文件与 xlsx 文件。
- 依据：[06 §4.3](../06-tools.md#43-workbook_editwrite)、[07](../07-workbook-engine.md)、[08](../08-sandbox.md)、[ADR 0014](../decisions/0014-empty-workbook-tool-chain.md)。
- 范围：用户提供的“创建默认表冲突 → 空操作拒绝 → 新增再删除绕行 → 171 亿格错误摘要”链路。保留已有并行工作树改动，不据本记录宣称 M6 全部完成。

## 修复

1. 工具与脚本共用 `WorkbookEditInput`；创建允许空 `ops`，修改已有文件仍要求至少一个操作。工具说明提供可执行的空工作簿示例、默认 `Sheet1` 与改名语义；重复创建默认表错误附纠正指引。
2. 创建预览与实际创建使用相同路径预检和默认快照；空创建提交修订与默认表新增结构，恢复钩子能认出已提交调用。创建回执直接使用提交快照的表清单，避免后续读取与该修订错位。
3. 文档提交结果、脚本发布预览及轮次摘要共用 `summarizeWriteSet`；冲突哨兵仍保留，结构变化单独报告，有限区域按并集计数，Excel 边界上的单格仍计数。
4. `workbook_read overview` 对当前快照统计非空格与公式；写入、清空、改名后不再返回导入时计数。
5. 编译器在删除表后更新模拟工作表清单，防止同批删除最后一张表；合并结构变化时不重复记录声明与引擎事件。摘要用删除前像的表名；卡片展示“已创建工作簿”或结构修改，空创建仍进入变更导航。

## 门禁与证据

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm check:all` | 通过，退出码 0 | [完整输出](../../.agents/tasks/empty-workbook-tool-chain-2026-10-01/check-all.log)；最终运行 21:09，测试耗时 55.19 秒 |
| TypeScript strict 全栈检查 | 通过 | 同上 |
| Biome lint/格式 | 通过，无错误；仓库已有警告仍保留 | 同上 |
| 依赖方向 | 通过，449 modules / 1225 dependencies | 同上 |
| 许可证 | 通过，494 个依赖，沿用原构建期例外清单 | 同上 |
| Web 生产构建 | 通过 | 同上 |
| 全量测试（含既有投影重建门禁） | 49 files / 322 tests 通过 | 同上 |
| `git diff --check` | 通过 | 本轮命令无输出、退出码 0 |

## 场景

| 场景 | 结果 | 可复跑证据 |
| --- | --- | --- |
| 重复 `sheet.add Sheet1` 失败后，同路径改用 `create:true, ops:[]` 成功，默认仅一张空表，无修改前备份 | 通过 | `packages/server/test/e2e-doc.test.ts` 空工作簿用例；真实 HTTP/WS/SQLite 与 xlsx |
| 新建后的即时总览、改名/值/公式写入、重复区域计数、清空与两张临时表删除、再次总览 | 通过 | 同用例：有限格数 2，清空后非空格/公式均 0，修订 1→2→3；删除摘要按表名且不重复 |
| 现有文件空操作拒绝、最后一张表不可删除；创建预览不生成文件 | 通过 | 同用例；`packages/modules/workbook/test/checkpoint.test.ts` 空创建用例另验证同批删光表被拒绝 |
| 无操作创建仍有可恢复日志；扩展名错误与已有路径在预览/执行中均拒绝、不覆盖文件 | 通过 | `packages/modules/workbook/test/checkpoint.test.ts` 空创建用例 |
| 文档 WS 续传包含创建修订；关闭服务后的文件只有一个空表，重新启动通过 REST 读取修订 3 与相同快照 | 通过 | `packages/server/test/e2e-doc.test.ts` 空工作簿用例 |
| QuickJS `wb.edit` 空创建；审批前文件未生成，结构删除预览无巨大格数；批准后新文件修订 1、发布回执与日志完整 | 通过 | `packages/server/test/e2e-script.test.ts` 脚本空工作簿用例 |
| 整表哨兵不计格、最后一格 `XFD1048576` 仍计 1、重复格去重 | 通过 | `packages/server/test/e2e-agent-control.test.ts` 变更摘要纯逻辑用例 |
| 卡片区分空创建/创建预览/结构修改；空创建有零单元格的结构变更导航 | 通过（reduce 层） | `packages/web/test/reduce.test.ts` 空创建与结构修改用例 |

## 边界与已知问题

- 假模型只替代模型服务输出，没有替换运行时、工具、文档 actor、QuickJS、网络或数据库实现。未验证真实模型在新说明下首次调用的自主成功率，也未做本次卡片文案的浏览器实机截图验收。
- 未在本轮验证 Windows/Electron 打包；此次不涉及新增依赖或改变合规配置。
- 全量测试退出时仍打印仓库此前已记录的 QuickJS `JS_FreeRuntime` 清理断言；Vitest 322 条均通过且最终命令退出码 0。此告警此前见 [M6 后端修复记录](m6-backend-fixes.md)，本轮未据此宣称运行时清理问题已修复。
