# M1 纵切验收记录（后端 + 活文档 + Web SPA）

日期：2026-09-30　环境：macOS（Apple Silicon）、Node v24.1.0、pnpm 10.11.0

范围：创建模型档案 → 创建会话 → WebSocket 订阅 → 发消息（可带工作簿选区
context）→ 代理调用只读文件/工作簿工具 → 流式回答 → React SPA 三栏界面
（会话 / 对话 / 只读表格工作台）。全部走真实 HTTP / WebSocket / SQLite 文件；
假模型（`ai/test` MockLanguageModelV4）只替代模型输出，不替代任何自有代码。

## 门禁执行结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 一键门禁 | `pnpm check` | 全绿（typecheck + lint + deps + licenses）。根 typecheck 已按许可改为 `pnpm -r --filter './packages/**'`（spikes 不进门禁） |
| 单元/集成测试 | `pnpm test` | 40 passed / 7 files（core 8、kernel 2、workbook 7、server 2、web 3、gates 18） |
| 依赖方向 | `pnpm check:deps` | 通过（176 modules / 274 deps）；module→module 方向门禁含 workbook→files 拒绝用例 |
| 许可证 | `pnpm check:licenses` | 通过（337 个依赖） |
| Web 构建 | `pnpm --filter @excelmanus/web build` | 成功（vite 7.3.6 + esbuild JSX，产物 dist/） |
| 生产启动 | `pnpm start`（EXCELMANUS_HOME=tmp） | `GET /` → 200 index.html（398B）；`/assets/*.js` 200；SPA 回退 `/sessions/abc` 200；`/api/v1/health` → `{ok:true,protocolVersion:1}` |
| 截图 | headless Chrome | `docs/acceptance/m1-screenshot.png` |

## modules/workbook（07 §3、06 §4，ADR 0003 快照定影）

- 自研只读 xlsx 导入：fflate 解 zip + fast-xml-parser 解析 workbook.xml /
  sharedStrings / styles（仅 numFmt 格式码 → Univer styles.n.pattern）/
  sheetData（s/n/b/str/e/inlineStr + 公式，共享公式跟随格保留缓存值）、
  合并单元格、列宽行高、冻结窗格、隐藏表；图表/透视表/宏/图片等不支持部件
  计数进 overview 的 `unsupported`。
- CSV：BOM（UTF-8/UTF-16LE/BE）→ UTF-8 fatal 嗅探 → GBK 兜底，分隔符嗅探。
- `DocumentService`（documents 表模块迁移，rev 从 0）：open/read/snapshot，
  快照对调用方深拷贝；进程重启后按 documents 行重导入复用 docId。
- 工具 `workbook_read`（overview/range/search，2000 格/16000 字符截断带
  nextOffset 游标）与 `workbook_analyze`（sql：区域装入内存 node:sqlite，
  仅 SELECT/WITH、≤200 行预览；profile：列画像）。effect=read、replay=safe，
  结果统一带 docRevs。
- 路径安全公共实现落在 `kernel/src/paths.ts`（files 与 workbook 共用，
  module 间零依赖）。

## REST 新增（protocol 契约 + 服务端）

- `POST /workspaces/:id/docs/open`、`GET /workspaces/:id/docs/:docId/snapshot`
- `GET /workspaces/:id/files?path=`、`POST /workspaces/:id/files/upload`（multipart）
- `SendMessageBody.context`：结构化 `{docId, rev, range}[]`，投影写入模型历史时
  渲染为本轮用户消息前的 `<context>` 块（04 §7.3）

## e2e 关键路径（packages/server/test/e2e-chat.test.ts）

- 基础纵切：档案 → 会话 → 票据 → sub cursor=0 → 发消息 → `find` 真实执行 →
  流式回答；记录序列保序断言；断线游标续传；`GET /log` 与 WS 逐条相等；
  429 → retry.scheduled → error.guidance(rate_limit)；401 → error.guidance(auth)；
  clientMessageId 幂等。
- workbook 纵切：mock 模型调 `workbook_read` overview 打开工作区 sales.xlsx →
  tool.result ok 且含表名「销售」；消息携带 `context:[{docId,rev,range}]` →
  发给模型的用户消息含 `<context>` 块；REST docs/open、snapshot、files 实测可用。
- e2e 把真实 WS 消息流录到 `packages/web/test/fixtures/session-stream.json`，
  web reducer 测试回放它断言最终状态（消息数、工具卡状态、最终文本）。

## 前端（packages/web）

- React 19.3 + Vite 7 + Zustand + marked；普通 CSS（stitch 视觉参考），无 Tailwind。
- 令牌：`#token=` → localStorage → 清 hash；REST 只经 `createApiClient`；
  WS 走票据 + `sub cursor` + 断线指数退避重连续传。
- `reduceSession` 纯函数：未知类型 console.warn 忽略、seq 幂等、delta 累积为
  流式文本、model.output 替换、attempt.discarded 清除。
- 布局：左会话列表（新建/切换/删除）；中对话（流式 Markdown 白名单消毒渲染、
  思考折叠、工具卡片、错误指引、重试提示、Enter 发送/Shift+Enter 换行/停止）；
  右只读工作台（文件列表、上传、xlsx/csv → UniverSheetsCorePreset 1.0.2 只读、
  选区随下一条消息作为 context 发送）。
- 设置弹窗：档案列表/新增（provider 下拉来自 /providers）/设为默认/测试连接；
  无档案时首页引导。
- 生产模式 server 托管 `packages/web/dist`；开发 `pnpm dev` 起后端 8787（--dev
  放行 5173 Origin/Host）+ Vite 5173（/api 与 WS 代理）。

## 真实 MiMo 冒烟（packages/server/scripts/smoke-real.ts）

配置来源 `~/.config/excelmanus-next/spike.env`（mimo-v2.6-flash）。本轮提问
"sales.xlsx 每列是什么意思"（工作区放入样例 xlsx），真实模型自主调用
workbook_read 三次（全部 ok）后逐列解释：

```
session.created → agent.spawned → user.message → dispatch.updated → dispatch.updated →
turn.started → step.started → model.output → tool.intent(workbook_read) → tool.result(ok) →
step.started → model.output → tool.intent(workbook_read) → tool.result(ok) →
tool.intent(workbook_read) → tool.result(ok) → step.started → model.output →
turn.completed → usage.updated   （20 recs / 144 deltas）
```

回答前 200 字：「`sales.xlsx` 包含两个工作表：**「销售」表**（第 1 行是标题
「销售明细表」，第 2 行是表头）：| A | 地区 | 销售区域（如华东、华南…）」——
列名与含义全部正确。

## 已知问题 / 限制

- vite 锁定 7.3.6：vite 8 把 lightningcss（MPL-2.0）列为硬依赖，@vitejs/plugin-react
  5/6 的 babel 链会引入 caniuse-lite（CC-BY-4.0），均被许可证门禁拒绝；当前用
  esbuild JSX，无 Fast Refresh。
- 共享公式的跟随单元格只保留缓存值（不展开文本公式）；公式列在 analyze 中
  取缓存值。
- xlsx 导入不还原数字格式渲染（numFmt 已进快照，由前端 Univer 渲染）。
- markdown 消毒为自写标签白名单（避免 dompurify 的 MPL-2.0 双许可）。
- WS 客户端须在 `open` 之前挂 `message` 监听，否则可能丢握手同帧的 hello。
