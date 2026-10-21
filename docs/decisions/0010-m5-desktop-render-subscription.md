# 0010 M5 实现取舍：截图由界面客户端渲染、桌面用 @electron/packager 打包、订阅用自写薄适配

- 状态：已接受
- 日期：2026-10-01

## 背景

M5（15 §M5）交付桌面、订阅登录、技能/记忆/规则/MCP 与提供商扩展。其中三处与文档的【推荐】选型不同，按 AGENTS.md 需要 ADR：

1. **截图渲染**（07 §8、13 §1）：文档写"渲染池加载只读渲染页"，桌面为离屏窗口，本机 Web 形态的做法留在附录 C T-9（借用已打开页签 vs 连接系统 Chrome）。Univer 服务端无头实例没有绘制能力。
2. **打包**（13 §4.1）：推荐 electron-builder，产出 DMG / NSIS。
3. **订阅 provider**（09 §4.2）：推荐先评估社区包，不满足时写约 300 行薄适配。

## 选项

### 截图

- A：服务端起无头 Chromium（Playwright）渲染。需要额外下载浏览器，桌面包体积超预算，且本机 Web 用户要装浏览器二进制。
- B：由已连接的界面客户端渲染：服务端把区域排成版式（行高列宽、合并、常用样式、数字/日期格式），经同步通道 `render.request` 发给订阅了 `app` 主题的连接，客户端在 canvas 上绘制后回 `render.result`（PNG base64）。桌面由隐藏的离屏窗口（`?renderer=1`）承担；本机 Web 由打开的页签承担。

### 打包

- A：electron-builder 26（DMG/NSIS/自动更新元数据一站式）。
- B：@electron/packager 20（BSD-2）产出平台应用目录 + zip，自动更新仍用 electron-updater。

### 订阅

- A：社区包 `@grikomsn/ai-sdk-provider-chatgpt-oauth` 等。
- B：自写：OAuth（PKCE 本机回调 + 设备码）在 `server/src/accounts.ts`，请求用官方 `@ai-sdk/openai` Responses 实现，经自定义 `fetch` 注入令牌、`chatgpt-account-id`、`originator` 头并改写请求体（`store:false`、系统提示放 `instructions`）。

## 决定

- 截图选 **B**。附录 C T-9 的结论：借用已打开页签；没有渲染端时工具明确返回 `UNSUPPORTED_FEATURE`（"请保持界面打开"），不伪造结果。渲染限制随结果返回（条件格式、边框、图表未渲染）。
- 打包选 **B**。electron-builder 的依赖链含 `truncate-utf8-bytes`（WTFPL），不在许可证白名单；按 AGENTS.md 不放宽白名单。推翻 13 §4.1 的"electron-builder；DMG / NSIS"，改为应用目录 zip（macOS 用 `ditto` 保留签名所需结构，Windows 为目录 zip）。安装器（DMG/NSIS）待有白名单内的替代工具后再补。
- 订阅选 **B**。社区包都要求把凭据存进包自己的存储，不满足"凭据进我们的加密库"；端点与 client_id 取自 openai/codex 开源客户端（2026-10 核实）。适配代码 `models/src/chatgpt.ts` 约 90 行，协议解析仍由官方包完成。

## 后果

- 正面：没有新增浏览器二进制与原生依赖；截图与界面同一套字体与绘制逻辑；许可证门禁保持原样。
- 负面 / 代价：
  - 本机 Web 形态关闭全部页签后 `workbook_render` 不可用；截图只覆盖值、填充、字体、对齐、合并，不含边框、条件格式、图表。
  - 无 DMG/NSIS 安装器；Windows 无开始菜单快捷方式与文件关联（13 §3 文件关联本为 P1）。
  - electron-updater 需要发布源里的 `latest*.yml` 元数据，packager 不生成；自动更新在没有发布流水线之前无法端到端验证。
  - 订阅接口非公开，端点或请求体约束变化时会直接失败；界面已标注。
- 需要跟进：
  - 签名与公证（附录 C P-8）、DMG/NSIS 安装器、发布流水线生成更新元数据后，完成场景 23。
  - 用真实 ChatGPT 账号验证场景 19（本次只用假 OAuth 发行方验证了流程）。

## 验收标准符合性

- 场景 15 依赖的 `workbook_render`：`server/test/e2e-m5.test.ts` 用真实 WebSocket 客户端充当渲染端，断言版式、PNG 进入视觉输入、无渲染端时报错；另在真实浏览器页签中实机渲染 `samples/sales.xlsx`（截图见 `docs/acceptance/m5.md`）。
- 13 §4.4 安装包自检：打包产物解压到仓库外（`/tmp`）运行 `--self-test`，数据库、示例工作簿修改、沙箱、内置技能、模型目录、离屏截图全部通过；CI 新增 macOS/Windows 两个平台的同一作业。
- 13 §4.1 体积预算：`pack.ts` 输出体积报告，zip 超过 250 MB 即失败（macOS arm64 实测 129 MB）。
- 场景 19：`e2e-m5.test.ts` 以假 OAuth 发行方走真实本机回调（127.0.0.1:1455）与设备码轮询，断言自动建档案、读接口不泄露令牌、访问令牌临近过期时请求前自动刷新。

## 2026-10-16 修订：无界面时的服务器渲染

现网模型小测发现 `workbook_render` 在接口任务中因没有连接的界面而必然失败。按用户要求补足能力：保留 B 的界面渲染优先路径，增加 MIT 许可的 `@napi-rs/canvas@0.1.80` 服务器兜底；无客户端立即使用，断连、失败或 5 秒超时后自动使用。两端共用 core 单元格绘制实现，不再要求用户为接口任务打开网页。

代价是新增平台原生依赖，并使用部署系统字体；仍不渲染边框、条件格式、图表和图片，限制随工具结果返回。没有浏览器二进制依赖，不执行工作簿代码或加载外部资源。打包与订阅决策保持不变。
