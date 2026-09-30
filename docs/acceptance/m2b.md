# M2b 写回、备份与写入工具验收记录

日期：2026-09-30（Asia/Shanghai）

范围：xlsx/CSV 检查点写回、修改前备份、回收站、文本文件工具、另存/新建和 SQL `saveTo`。本记录只标记已经在当前工作树执行并有输出的项目。

## 证据

- `pnpm typecheck`：通过（根脚本和 15 个工作区包）。
- `pnpm exec vitest run --project modules-workbook --project modules-files --project kernel --project server`：通过；最近一次聚焦运行输出为 7 个文件、29 个测试通过；完整 `pnpm check:all` 的测试阶段输出为 12 个文件、69 个测试通过。
- `packages/modules/workbook/test/checkpoint.test.ts`：真实临时文件 + SQLite，覆盖宏/图表/customXml 部件逐字节保留、样式追加、新增工作表、签名/对象结构拒绝、重启恢复、外部修改、CSV 编码/分隔符、另存/新建、SQL `saveTo`，并用 5 个 LibreOffice 生成样例回读；本机 `soffice` 打开转换验证全部通过。
- `packages/modules/files/test/files.test.ts`：真实文件系统 + SQLite，覆盖版本冲突、会话内只备份一次、整批预检/回滚、审批前删除拒绝、已批准回收站、符号链接和备份清理。
- `packages/server/test/e2e-doc.test.ts`：真实 HTTP/WebSocket/SQLite，代理提交后等待 `doc.checkpoint`，验证原文件写回、备份记录和文件字节；关闭并重启服务后验证修订号、检查点修订和内容。
- `node packages/server/scripts/smoke-real.ts --file samples/sales.xlsx --prompt "...新建汇总表..." --verify-xlsx summary.xlsx`：真实 MiMo `mimo-v2.6-flash`，`outcome: done`，32 条日志记录、248 个流增量；工具序列含 `workbook_analyze`、`workbook_edit`、`workbook_read`，检查点重新导入报告 `ok: true`。

## 当前结论

- 未修改的 OOXML 部件和未修改工作表 XML 原字节保留；修改工作表仅更新建模区域。宏部件原样保留；含数字签名、透视/表/图表且需要结构平移的操作在提交前返回 `UNSUPPORTED_FEATURE`。
- 检查点使用临时文件、回读解析、哈希和原子发布；SQLite 中的检查点发布意图覆盖改名与数据库提交之间的崩溃窗口。写回失败时保留 `doc_ops` 并延迟重试。
- 代理/脚本首次修改已有文件自动备份；同一会话只备份一次。删除进入回收站，`files` 整批操作在预检失败时不执行。
- M2c 审批执行器尚未交付，`files.delete` 在未获得受信审批标记时返回 `APPROVAL_DENIED`；此行为符合“删除要审批”的已拍板范围。

## 未在本轮验证的范围

Excel/WPS 原生文件的人工打开、并发模糊、对象层结构平移、工作台可编辑和 M2c/M2d 均留待后续里程碑。
