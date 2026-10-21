# M6 后端缺陷修复续验（2026-10-01）

本轮针对 `.agents/tasks/m6-backend-audit-2026-10-01/audit-report.md` 中的 P0/P1 缺陷继续修复，未修改前端验收结论。实现依据 `docs/` 与 AGENTS.md；工作树保留既有未提交改动。

## 已执行门禁

| 门禁 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过 | 15 个 workspace 包均 `Done` |
| lint/格式 | `pnpm lint` | 通过（108 条已有/新增 warning，3 条 info） | Biome exit 0 |
| 依赖方向 | `pnpm check:deps` | 通过 | 22 个包、442 modules、1181 dependencies |
| 许可证 | `pnpm check:licenses` | 通过 | 494 个依赖；仅登记 lightningcss 构建期例外 |
| 单元与边界测试 | `pnpm test` | 通过（集成阶段） | 46 files / 312 tests passed；真实 HTTP、WebSocket、SQLite 场景包含在 server tests |
| 工作簿回归 | `pnpm exec vitest run packages/modules/workbook/test/workbook.test.ts` | 通过 | 7 tests passed |
| 差异格式 | `git diff --check` | 通过 | 无空白错误 |

测试在允许本机 `127.0.0.1` 监听的环境执行；沙箱权限下的监听失败不作为功能结果。随后对最终工作簿映射改动又执行了 5 个测试文件、49 个测试，全部通过。LibreOffice 样本 5 个均报告 `opened: true`。测试进程退出时 QuickJS 打印运行时断言，但 Vitest 仍以 312/312 通过结束，需后续单独处理运行时清理告警。

## 本轮完成

- 确定性 `UNSUPPORTED_FEATURE` 不再触发检查点和启动恢复的无限重试；瞬态文件错误仍按退避重试。
- 外部版本切换无法保真导出时直接返回 `UNSUPPORTED_FEATURE`，不再静默降级为 `minimalXlsx`。
- 粗粒度读集不再因部分结构删除永久进入 `VERSION_CONFLICT`；重启后的 preservation 基底按工作表名匹配，避免外部重排导致按索引错写。
- REST/结构化错误、账号错误和会话导出路径统一做递归密钥脱敏；短密钥也不会回显。
- MCP 解密值只登记实际值及 Bearer 令牌子串，避免把普通 env 配置污染到全局脱敏表。
- 增加鉴权 `/api/docs` OpenAPI 3.1 资源索引，并把 `unsupported_media_type` 纳入契约错误码。
- `workbook_analyze` 的 SQL 支持 `{{sheet}}` 到内存 `data` 表的兼容别名；旧测试错误码同步为统一词表中的 `INVALID_ARGUMENT`。

## 当前工作树续验（2026-10-01）

在本记录原有门禁之后，当前工作树重新执行了 `pnpm check:all`：类型检查、lint、依赖方向、许可证、Web 构建和全量测试均通过；全量测试为 48 个文件、317 个测试。随后执行 `pnpm build:desktop`、`pnpm --filter @excelmanus/desktop self-test` 和 `pnpm pack:desktop`，桌面自检与打包均通过。

自检首次在同一工作树失败于“打开并修改示例工作簿 / 单元格回读校验失败”。定位为 `pendingChanges` 排除 `engine` 来源区域，导致仅有引擎修订时导出器不刷新缓存。现已让引擎区域参与导出器的局部回写，并新增 `writeback.test.ts` 回归；修复后的桌面自检完整通过。引擎结果仍不计作作者结构修改。

生产启动复核使用真实服务和临时 SQLite 目录：`/api/v1/health` 与首页返回 200；无设备令牌访问 `/api/v1/bootstrap`、`/api/docs` 均返回 401，符合鉴权边界。

## 尚未宣称通过的项目

- 重启后 `keepApp` 的外部 OOXML 工作表/样式索引重排、损坏源文件的备份替换，尚缺独立真实样本；详见 `continuation-workbook.md`。
- Univer 计算仍在主线程，尚未完成 worker 迁移；大工作簿检查点的停顿不能标记为解决。
- `/api/docs` 当前为资源索引，完整 DTO schema 仍由 protocol 的 Zod 契约维护；Windows/NTFS、Finder 启动和生产反向代理未实机验证。
- 审计报告中的 P2 项未逐条复核；P-17（删除超时后的迟到副作用）和 `truncated.cursor` 续取仍按附录 C 待决项处理。

因此本记录证明本轮门禁与已列修复通过，不能将未验证项目记为 M6 后端全部完成。
