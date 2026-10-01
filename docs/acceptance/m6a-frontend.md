# M6a 前端整体设计与收口 — 验收记录（第一轮）

日期：2026-10-01 · 结论：**部分完成**（布局、视觉体系与主要流程已收口并实测；下文「未完成 / 已知问题」中的项未通过）

## 1. 盘点结论（开始时）

- `styles.css` 停留在旧三栏结构，组件已重写但约 80 个类名（`stage`、`split`、`splitter`、`chat-header`、`composer-*`、`range-chip`、`icon-btn`、`spinner`、`tool-*`、`doc-header` 等）没有任何样式，页面骨架与网格错位——这是"粗糙"的主因。
- 功能缺口：选区徽标从不更新（`FWorkbook.onSelectionChange` 只在鼠标拖选结束时触发）；「确认此区域」提交的是当前选区而非建议区域（违反 02 §4.3）；新建模型档案后"还没有可用的模型"提示不消失；思考块与正文脱节且只在流式期间显示；表格无公式栏与工作表标签；无已修改/拟修改叠加层；团队面板在没有子代理时也出现。

## 2. 本轮改动

| 区域 | 内容 |
| --- | --- |
| 视觉体系 | 重写 `styles.css`：一套 token（16 §2.1 示例色），深色主题只换变量；系统中文字体回退、等宽数字；按钮/徽标/区域徽标/提示条/分段控件/加载指示统一；减少动效偏好生效 |
| 整体布局 | 侧栏 + 舞台网格；对话优先时 760px 居中阅读列；分栏默认 60/40、最小对话宽 380px、可拖动（键盘左右键）与记忆；1024–1279px 表格/对话标签 + 迷你输入条 |
| 侧栏 | 会话相对时间、悬停删除；文件当前项；代理团队仅在有子代理时出现，两行卡片（状态点、状态·角色·最近工具·token、悬停操作）；底部设置（含快捷键提示）与主题切换 |
| 对话 | 思考块挂在所属助手消息上、默认折叠（流式时"正在思考…"）；工具卡中文标题 + 状态点 + 目标徽标，参数/结果折叠；错误指引按 9 类中文分类 + 原因 + 下一步 + 去设置；提示统一收在输入框上方；运行中发送按钮显示「发送（引导/打断/排队）」，独立停止 |
| 待处理条 | 审批卡琥珀左条、提问卡靛蓝左条；审批显示「代理想修改 文件 · 区域 · N 个单元格」，区域可点击定位，参数「查看详情」折叠；区域确认改为「取消 / 我来重新选择 / 确认此区域」 |
| 工作台 | 文档头（文件、修订、写回状态、折叠/关闭）；选区栏（选区徽标、「已查看」、「问代理」）；开启 Univer 公式栏、工作表标签、统计栏与缩放；叠加层：已提交修改绿底实线（保留到「已查看」或下一轮），待审批写入琥珀虚线；表格跟随应用深色主题 |
| 设置中心 | 分类图标导航 + 搜索；固定标题栏与关闭（Esc）；档案卡、能力徽标、表单控件与反馈样式统一；测试连接后刷新能力来源 |
| 快捷键 | Cmd/Ctrl+1/2/L 先展开或切换到目标面板再聚焦；L 恢复附带选区 |
| 修复 | 选区跟随改为监听 `sheet.operation.set-selections`（鼠标、键盘、引用定位都更新徽标）；`refreshProfiles` 同步 `hasModelProfile`；`model.output` 按 `stepId` 合并，不再覆盖上一步正文 |

草图取舍：采用温暖中性色、轻边框、等宽区域徽标、固定待处理条、变更导航条与设置分类 + 档案卡；调整了固定 256px 侧栏与 62/38 分栏（改为可拖动、按视口最小宽度）；不采用草图的顶部横栏、重复设置导航、终端/分享/成员入口、示例数值与英文主标题（16 §5）。

## 3. 验证环境与方法

- macOS，Claude 桌面应用内置浏览器（Chromium）；Node 24；源码优先启动。
- 后端：`packages/server/test/fixtures/ui-preview-server.ts`——真实 `startServer`、真实 HTTP/WebSocket/SQLite 与真实工具，**假模型只替代模型输出**（思考 → 读表 → 区域确认 → 写入 → 带表格与区域引用的总结；"失败"触发 401；"团队"触发两个子代理）。启动配置见 `.claude/launch.json` 的 `ui-preview-fake-model` + `web-dev-fake-model`。
- 判定以 DOM 尺寸、计算样式和状态读数为准；截图另行存档。
- 门禁：`packages/web` 与 `packages/server` 的 `tsc --noEmit` 通过；`vitest run packages/web` 13/13 通过；`pnpm build:web` 通过；Biome 对改动文件 0 错误（13 条特异性/既有告警）。仓库级 `pnpm lint` 仍有 3 个其他包的既有格式错误，未在本轮处理。

## 4. 场景结果

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 首次启动：引导卡、无模型；设置中新增档案 → 测试连接 → 能力探测（来源标注"探测"） | 通过 | 实测记录 |
| 打开工作簿：分栏 757/9/426（1440）、公式栏 28px、工作表标签 36px；无横向溢出 | 通过 | `m6a-frontend/1440-workbench.jpg` |
| 发送 → 思考折叠 → 读取卡完成 → 区域确认卡固定在输入框上方 → 确认 → 审批卡（区域、单元格数、详情折叠）→ 批准 → 修订 0→1、已写回、变更导航 `Sheet1!E1:E4 · 4 个单元格 · 修改前备份` | 通过 | 实测记录 |
| 正文区域引用：等宽虚线徽标，点击定位后选区徽标、输入框上方徽标、「问代理」同步出现；钉住后不随选区变化；「已查看」清除高亮 | 通过 | 实测记录 |
| 模型错误：认证失败分类、原因、下一步、去设置 | 通过 | 实测记录 |
| 子代理：团队面板出现两个子代理；进入代理视图（面包屑、返回主代理、输入框占位"正在查看：核对员"）；内部消息折叠 | 通过 | 实测记录 |
| 断线：后端停止后顶部"连接已断开，正在重连…"，恢复后消失（生产构建直连后端） | 通过 | 实测记录；Vite 开发代理下不触发，见已知问题 |
| 1280px：对话列 ≥ 368px 时调大默认比例与最小宽度；无溢出 | 通过 | 实测记录 |
| 1024px：表格/对话标签、迷你输入条、变更导航可见；无溢出 | 通过 | `m6a-frontend/1024-sheet-tab.jpg` |
| 设置中心：9 个分类、搜索、Esc 关闭、焦点进入对话框 | 通过 | `m6a-frontend/1440-settings.jpg` |
| 深色主题：正文 17.3:1、次要文字 ≥ 6.9:1；表格同步深色 | 通过 | `m6a-frontend/1440-dark.jpg` |
| 浅色次要文字对比度：调整后 ≥ 4.7:1（纸白、次级表面、悬停、琥珀底） | 通过 | 实测记录 |
| 键盘：Cmd+, / Esc / Cmd+B / Cmd+2 | 通过 | 实测记录 |

## 6. 第二轮：stitch 草图对齐（A 组）

2026-10-01，按 [对齐清单](../design/m6a-stitch-alignment.md) 完成 A1–A12 与 C8，逐项证据记在清单里。环境同 §3（假模型后端新增「慢」延时触发，用于检查运行中派发）。门禁：`packages/web` `tsc --noEmit` 通过、`vitest run packages/web` 13/13、Biome 0 错误。截图：`m6a-frontend/a-1440-approval.jpg`（对话区上浮卡片、压缩审批条、文档头合并）、`m6a-frontend/a-1440-settings-models.jpg`（分组导航、页头说明、档案参数网格与能力格）。

## 7. 第三轮：草图对齐（C 组交互）

2026-10-01，按 [对齐清单](../design/m6a-stitch-alignment.md) 完成 C1–C3、C6–C8，C4/C5 部分，C9 阻塞；逐项证据在清单。假模型后端新增「只读」「改值」脚本。截图：`m6a-frontend/c-1024-changed-tag.jpg`（已修改角标）。门禁：`packages/web`、`packages/server` `tsc --noEmit` 通过；`vitest run packages/web` 16/16（新增触发词解析 3 例）；`pnpm build:web` 通过；改动文件 Biome 0 错误。

本轮发现并修复：
- 删除会话没有确认，删除按钮悬停才显示且与时间文字重叠，容易误删（日志一并删除、不可恢复）→ 加二次确认。复核期间预览数据目录中的历史会话被删除，未能确定是哪次操作触发；涉及的只是 `/tmp` 下的测试数据。
- Univer 1.0.2 的 canvas 浮层只在滚动/选区/尺寸变化时重算位置，新打开文档时首挂会停在视口外 → 布局稳定后重挂一次。
- 写入新增的行列超出当前表格尺寸时，高亮与角标整段失败 → 按当前尺寸截断。

复核注意：内置预览只有一个标签页，与用户共用；本轮后段有一次脚本把「改值」发进了用户正在使用的会话（只改了预览数据目录中的测试表），之后改为只读检查。

## 8. 第四轮：补齐后端阻塞项（B1、B2、C4、C5、C9）

2026-10-01。契约变更（均为可选字段/新增接口，已写入 11）：`tool.result.durationMs`、`model.output.reasoningMs`、`ToolDefinition.activity` → `workbook_activity` 增量、`GET .../docs/{docId}/revs/{rev}/before`、`POST/GET /attachments`、`SendMessageBody.attachments`、`user.message.attachments`、中立 `ContextItem(user).images`、`bootstrap.dataDir`。kernel 新增 `BlobStore`（`<dataDir>/blobs/`）。

门禁：protocol/kernel/models/workbook/server/web `tsc --noEmit` 通过；`pnpm check:deps` 无违规；`pnpm build:web` 通过；改动文件 Biome 0 错误；测试 kernel、models、protocol、workbook、web 与服务端 e2e（chat、approval、doc、attachments、question、dispatch、compaction、agents、m5、kill、script）全部通过（20+2 个文件，110 例）。新增 `e2e-attachments.test.ts`；`e2e-doc.test.ts` 增加活动增量、不入日志、durationMs、修改前的值断言。

页面实测（假模型后端）：粘贴图片 → 缩略图 → 发送 → 气泡缩略图 → 模型回"收到 1 张图片"；"正在读取"角标与文档头提示；工具耗时与"思考了不到 1 秒"；数据目录卡。为测试把预览档案的视觉能力手动覆盖为"支持"。

排查记录：预览数据中修订 5 起逆操作为空，复现确认是夹具每次写入相同的值（写入无变化），不是外部重载的问题；夹具已改为每次写不同值，界面对此显示"写入的值与原值相同"。

## 5. 未完成 / 已知问题

对照 `stitch/` 草图的后续优化与补齐逐项记在 [design/m6a-stitch-alignment.md](../design/m6a-stitch-alignment.md)，以该台账为准。

- 未实现：右键「问代理…」快捷项（02 §4.6）、`@` 引用候选与附件（02 §3.3）、用户与代理同时编辑的冲突条（02 §4.7）、presence 与"正在读取"叠加层（服务端尚未推送 `workbook_activity`/`presence`）、工作表标签上的修改小点、叠加层一键隐藏、"修改前：xxx"原值小窗。
- 未在真实键盘/鼠标下验证：Univer 画布内拖选（内置浏览器的合成指针事件不进入 Univer），以程序化定位与 `set-selections` 操作代替验证。
- Vite 开发代理在后端退出时不关闭浏览器侧 WebSocket，开发模式下看不到断线条；生产构建正常。
- 打开工作簿时控制台有 React "synchronously unmount a root" 警告（Univer 实例在 StrictMode 下重建），未影响功能，未处理。
- 场景截图以 DOM 测量判定布局；未做像素比对（沿用 ADR 0006）。

## 8. 第四轮：Tailwind CSS 4 与组件层视觉大修

2026-10-01 · 结论：**部分完成**。依据 [ADR 0011](../decisions/0011-tailwind-shadcn-ui-layer.md)，逐项状态见 [对齐清单 E 组](../design/m6a-stitch-alignment.md)。

范围：样式体系换成 Tailwind CSS 4（`styles.css` 3080 → 349 行），新增 `components/ui/` 组件层（Radix 原语），所有页面迁移；原生 `select`/复选框/单选框/滑块/`datalist`/`details`、`window.confirm`、原生 `title` 提示在 `components/ui/` 以外清零；文案集中到 `strings.ts`。不改 store、reduce、协议与服务端。

环境：macOS，Node 24.1，Playwright 1.63 Chromium（无头），后端 `ui-preview-server.ts`（真实 HTTP/WS/SQLite + 假模型），数据目录 `/tmp/excelmanus-ui-preview`；Vite 开发服务器。

| 门禁 | 结果 |
| --- | --- |
| `pnpm --filter @excelmanus/web typecheck` | 通过 |
| `pnpm exec vitest run packages/web test/gates` | 47/47 通过（含新增 `ui-conventions` 4 条、许可构建期例外 6 条） |
| `pnpm exec biome check packages/web biome.json scripts/check-licenses.ts test/gates/license-check.test.ts` | 0 错误，9 条告警（`!important` 等既有写法） |
| `pnpm check:licenses` | 通过；所用构建期例外 `lightningcss@1.32.0`、`lightningcss-darwin-arm64@1.32.0`；生产依赖不含例外包 |
| `pnpm check:deps` | 通过 |
| `pnpm build:web` | 通过；CSS 168.5 KB（gzip 27 KB，含 Univer） |
| `pnpm build:desktop` | 通过；`packages/desktop/build/app` 内搜索 `lightningcss` 命中 0 |

页面复核（Playwright 脚本，结束后已删除）：

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1440 浅色：打开工作簿，公式栏/表头/工作表标签/统计栏/缩放正常 | 通过 | `m6a-frontend/e-1440-workbench.jpg` |
| 1440 深色：同上，界面控件保持样式 | 通过（修复后） | `e-1440-workbench-dark.jpg`、`e-1440-settings-dark.jpg` |
| 谨慎模式下发送 → 区域确认卡 → 确认 → 审批卡（拟修改角标与前后对比浮层）→ 拒绝展开理由 → 取消 → 批准 | 通过 | `e-1440-approval.jpg`、`e-1440-deny-reason.jpg` |
| `@` 候选列表 | 通过 | `e-1440-suggest.jpg` |
| 删除会话确认框：默认聚焦「取消」，Esc 关闭且会话未删除 | 通过 | `e-1440-confirm.jpg` |
| `Cmd+,` 打开设置、切换分页、Esc 关闭 | 通过 | `e-1440-settings-models.jpg`、`-general.jpg`、`-about.jpg` |
| 模型错误指引（「失败」脚本） | 通过 | `e-1440-error.jpg` |
| 1440 / 1280 / 1024 无横向溢出（`scrollWidth = innerWidth`） | 通过 | `e-1280-workbench.jpg`、`e-1024-sheet-tab.jpg`、`e-1024-chat-tab.jpg` |
| 控制台页面错误 | 0 | 脚本输出 |

本轮发现并修复：Univer 深色模式给 `<html>` 加 `univer-dark` 类，使 preflight 守卫命中整页、所有按钮回到浏览器默认样式（守卫改为排除 `html/body`）；对话头部提示框遮住打开的下拉菜单（头部选择器去掉悬停提示，说明改入可访问名称）；窄分栏下头部挤压标题（用量数值按容器宽度隐藏）。

未执行 / 已知问题：

- 未执行：B5.5 的 Univer 逐元素计算样式对比；对比度实测表；完整键盘走查；减少动效模拟；`pack:desktop` 与 `--self-test`；三宽度 × 两主题的完整矩阵（只覆盖上表）。
- 未在页面复核：订阅、规则、记忆、技能分页；除删除会话外的 11 个确认点；团队视图与工作区下拉；运行中的派发策略下拉。
- 未做设计稿中的 Univer 灰阶色板替换（V-11），表格灰阶仍为 Univer 默认。
- 待决：附录 C P-18（成功提示改 Toast）、P-19（控件边框对比度）、P-20（最低浏览器版本）。
- 预览令牌：非交互启动时后端不打印令牌（附录 C P-15），复核时直接改写了 `/tmp` 测试库中的设备令牌哈希，只涉及测试数据。
