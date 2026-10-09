# 提供商 Logo 接入验收（2026-10-02）

## 范围与来源

按用户要求，从桌面一代 `excelmanus/web/public/providers/` 导入 22 个 SVG 素材到 `packages/web/public/providers/`，没有读取或复用一代的实现代码。缺失的 Ollama 与正确的 xAI 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)（MIT，许可文本随资源保存）。一代 `x.svg` 内嵌标题为 X.Org，未作为 xAI 导入。

来源、最终 SHA-256 与可访问性标题补充记录见 `packages/web/public/providers/sources.json`；来源许可与说明见该目录 `README.md`、`LICENSE-excelmanus` 和 `LICENSE-lobe-icons`。未新增依赖或改变安全/许可门禁。

统一经 `Icon.tsx` 的 `ProviderLogo` / `ProviderLabel` 入口渲染，已接入：

- 对话模型选择器：当前值及全部候选；切换后随真实会话状态更新。
- 空白会话模型状态、模型档案卡片、提供商选择（选项及当前值）。
- 新增档案的模型输入与筛选候选。
- 用途分配：主对话标识、子代理与压缩模型选项及当前值。
- ChatGPT 订阅页标题、已登录账号卡片与团队中具有模型档案的代理行。

15 个现有预设中，ChatGPT 复用 OpenAI Logo；自定义兼容接口使用中性备用图标。未知提供商也使用备用图标，不从模型名推断品牌。单色 Logo 在深色主题反色，彩色 Logo 保留原色。功能/状态/设置分类的通用图标保留原有语义。

## 环境与门禁

macOS arm64，Node 24.1.0，pnpm 10.11.0；保留原工作树的并行未提交改动。本轮完整门禁日志临时位置：`/tmp/excelmanus-provider-logo-check.log`，持久摘要见 [gate-results.txt](provider-logos-2026-10-02/gate-results.txt)。24 个素材的最终 SHA-256 已逐项核对；文档与浏览器脚本落盘后 `pnpm lint` 再次通过。

| 检查 | 结果 |
| --- | --- |
| `pnpm check:all` | 通过：所有包类型检查、Biome、依赖方向、许可证、Web 生产构建、52 文件 / 334 项测试 |
| 前端聚焦 `pnpm exec vitest run --project web` | 5 文件 / 26 项通过 |
| 生产页面 Logo 浏览器复核 | 8 项通过；页面错误 0，第三方界面请求 0 |

门禁通过仍有既存 lint 警告、构建分块/纯注释警告及 QuickJS 运行时输出；本次不声称清除这些既存问题。

## 真实页面证据

服务使用 `packages/server/test/fixtures/ui-preview-server.ts` + 独立临时数据目录 + 生产 Web 构建，真实 HTTP / WebSocket / SQLite；模型输出替代器未在 Logo 验收中触发。浏览器脚本 `packages/web/test/fixtures/provider-logos-browser.mjs` 经真实 API 创建 14 个非订阅提供商档案，未使用接口 mock 或真实账号密钥。

复跑：

```sh
pnpm build:web
node packages/server/test/fixtures/ui-preview-server.ts <全新临时数据目录> 0 <packages/web/dist绝对路径>
PLAYWRIGHT_MODULE=<Playwright index.mjs> node packages/web/test/fixtures/provider-logos-browser.mjs <夹具URL> docs/acceptance/provider-logos-2026-10-02
```

运行结果见 [results.json](provider-logos-2026-10-02/results.json)。通过项：24 个本地 SVG 在生产构建中可加载；14 个模型选项、14 个档案卡片及 14 个提供商候选图标全部解码成功；切换 DeepSeek 后选择器与落地页均更新；模型输入和筛选候选一致；用途分配与订阅标题正确；深色主题单色反色、豆包彩色保持原色；960px 无页面横向溢出，当前 Logo 可见。

| 页面 | 证据 |
| --- | --- |
| 模型切换列表 | [model-options.png](provider-logos-2026-10-02/model-options.png) |
| 档案卡片（浅色 / 深色） | [profiles-light.png](provider-logos-2026-10-02/profiles-light.png) / [profiles-dark.png](provider-logos-2026-10-02/profiles-dark.png) |
| 提供商列表 | [provider-options-light.png](provider-logos-2026-10-02/provider-options-light.png) |
| 用途分配 | [roles-light.png](provider-logos-2026-10-02/roles-light.png) |
| 订阅标题 | [subscription-light.png](provider-logos-2026-10-02/subscription-light.png) |
| 对话主题与窄窗口 | [chat-light.png](provider-logos-2026-10-02/chat-light.png) / [chat-dark.png](provider-logos-2026-10-02/chat-dark.png) / [chat-960.png](provider-logos-2026-10-02/chat-960.png) |

已实际查看浅色/深色档案截图与模型选择列表，Logo 清晰、对齐，长名称选择值保持截断。

## 未验证边界

真实订阅登录后的账号卡片及多代理团队行本轮完成实现、类型检查和现有测试，未进行该状态的专项浏览器验收；未验证桌面打包。此记录只覆盖 Logo 接入，不宣称 M6 整体完成或真实模型/订阅功能验收。
