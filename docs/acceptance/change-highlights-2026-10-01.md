# 改动高亮专项验收（2026-10-01）

本轮由用户明确要求替换静态常驻绿色遮罩，解决无法直观清除和重复修改叠色。交互与取舍见 [02 §4.2](../02-interaction.md#42-代理活动叠加层)、[ADR 0019](../decisions/0019-transient-change-highlights.md)。仅记录本轮增量验收，不宣称 M6 或全工作树最终验收完成。

## 环境与实现

- macOS arm64，Node 24.1.0、pnpm 10.11.0，仓库现有并行未提交改动保留。
- 生产 Web 构建、Chromium（Playwright），1440×900 与 1024×768。
- `packages/server/test/fixtures/change-highlights-server.ts`：真实服务装配、HTTP、WebSocket、SQLite 文件、xlsx 导入/写入、修订和会话日志；只替代模型服务输出。夹具数据位于 `/tmp/excelmanus-change-highlights-20261001-r2`，监听随机 127.0.0.1 端口。
- `change-highlights.ts`：复用 core 区域差集，重叠单元格只由最新提交绘制；使用原会话记录的提交时间，6 秒到期。最初 650ms 退去轻填充，末尾 900ms 淡出边框；稳定阶段停止重绘。
- 工作台反馈卡带区域数、修订号、勾选、倒计时线与“清除高亮”；主体 pointer-events 为 none。减少动效下只有文字与静态细边框，不播放填充/入场/倒计时动画，仍到期清除。

## 已执行检查

| 检查 / 场景 | 结果 | 证据 |
| --- | --- | --- |
| Web 类型检查 | 通过 | `pnpm --filter @excelmanus/web typecheck`，退出码 0 |
| Web 测试与界面约定 | 通过 | 5 files / 26 tests；包含重复区域、交叠归属、L 形空洞、时间边界和减少动效 |
| 全仓测试 | 通过 | `pnpm test`，52 files / 330 tests，退出码 0 |
| 变更文件 Biome | 通过，有警告 | 7 文件，退出码 0；既有 unused suppression、optional chain 与 reduced-motion `!important` 警告未放宽规则 |
| 依赖方向 | 通过 | `pnpm check:deps`，22 个包，退出码 0 |
| Web 生产构建 | 通过 | `pnpm build:web`，退出码 0；既有依赖注释、动态导入与体积警告仍存在 |
| 三次连续真实写入：D2:D4 → D3:E5 → D3:E5 | 通过 | 正确显示 2 处区域及最新修订；3 条导航记录；最新归属与不叠色由区域测试佐证 |
| 6 秒自动清除 | 通过 | 卡片到期移除，截图中绿色改动边框消失，3 条变更记录仍可查看 |
| 淡出后导航 | 通过 | 点击上一处变更，位置从 3/3 到 2/3；历史不会重新播放“刚刚修改”提示 |
| 手动清除与后续新修改 | 通过 | 清除立即移除提示，记录仍在；下一次实际提交继续提供新反馈 |
| 刷新回放 | 通过 | 刷新并确认工作簿已打开，过期改动不重新提示 |
| 深色与减少动效 | 通过 | 深色画布与卡片目视检查；CSS animationName 为 none；到期移除 |
| 1024px 与键盘清除 | 通过 | 表格标签页内按钮完整可见，聚焦后 Enter 清除 |
| 浏览器运行时错误 | 通过 | 7 场景完成，pageerror 为 [] |

可复跑的浏览器流程：`packages/web/test/fixtures/change-highlights-browser.mjs`。先用全新临时数据目录启动服务夹具，再以 `PLAYWRIGHT_MODULE=<已安装 Playwright 的 index.mjs>` 执行该脚本，参数为夹具 URL 与证据目录。未新增依赖或降低门禁。

## 证据位置

持久保存的截图与结果在 [change-highlights/](change-highlights/)：

- [连续与交叠修改](change-highlights/fresh-overlapping-changes.png)
- [自动淡出后](change-highlights/automatically-cleared.png)
- [深色减少动效](change-highlights/dark-reduced-motion.png)
- [1024px 表格页](change-highlights/narrow-1024.png)
- [浏览器结果](change-highlights/browser-results.json)

命令输出留在 `.agents/tasks/change-highlights-2026-10-01/` 的 `tests.log`、`build.log`、`deps.log`、`lint.log`；该目录被 Git 忽略。截图与 JSON 不依赖这些本地日志即可查看。

## 已知边界

- 当前工作树服务端类型检查未通过：`packages/server/test/e2e-doc.test.ts:130–131` 的 `Promise.withResolvers` 超出当前 TypeScript lib，TS2550；与本轮高亮改动无关。未修改该并行测试或全仓配置，也未宣称 `pnpm check:all` 通过。
- 全仓测试输出存在 QuickJS 回收断言日志，但 Vitest 330 tests 与进程退出码均通过；本轮未审计该既有沙箱问题。
- 浏览器验收使用假模型；没有真实模型与 Electron 实机验收。无表格区域的纯结构变更仍通过导航展示，不虚构单元格高亮。
- 本轮覆盖重复与局部交叠、清除、回放、主题和窄屏；大型批量区域的动画性能及屏幕阅读器实机播报未另作验收。
