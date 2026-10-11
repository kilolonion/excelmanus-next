# 思考等级文案、最高档与 minimal 展示调整

- 日期：2026-10-02（Asia/Shanghai）
- 依据：用户追加要求、09 §3、ADR 0020 的后续调整。
- 范围：聊天/设置中心等级选择、最高档协议与提供商参数、已有 minimal 配置兼容；不代表里程碑整体验收。

## 最终行为

两处入口共用七个选项：**默认、无、低、中、高、极高、最高**。默认/无仍保存为 provider-default/none；最高保存为新增的 max。minimal 不出现在选项列表，协议保留该值以读取已有档案；已有值显示为「最少（已保存）」，不会自动改写，可以显式切换其他等级。

锁定 SDK 的统一 reasoning 不含 max。models 通过官方 providerOptions 传递：OpenAI/ChatGPT 使用 openai.reasoningEffort，Anthropic 使用 effort=max 和 adaptive thinking，兼容接口使用对应的 camelCase 命名空间 reasoningEffort=max。选择 max 覆盖已有低等级，包括自定义接口旧的原始/新 camelCase 命名空间。未实现该映射的适配器在调用模型前返回 invalid_request，不静默降为 xhigh。

菜单展开时关闭其说明提示，修复提示层影响 Esc 关闭选择器的问题。

## 环境与证据

macOS arm64、Node 24.1.0、项目 pnpm 10.11.0、bundled Playwright Chromium，1440×900 与 420×850。最终复核使用隔离目录 `/tmp/excelmanus-reasoning-levels-20261002-03`；真实 HTTP、WebSocket、SQLite、协议客户端、运行时与模型网关，仅提供商输出是假模型。

浏览器 **14 项通过**，无 pageerror，见 [browser-results.json](reasoning-levels-2026-10-02/browser-results.json)。覆盖七档保存/读回、菜单中无 minimal、max 进入网关的提供商参数、刷新保持、保存失败保持、模型切换、聊天与设置显示已有 minimal 但不提供该选项、已有值不被改写、文件引用/图片/冲突/失败重试/会话隔离、窄屏与键盘、无模型禁用。已人工复核 [聊天选择器](reasoning-levels-2026-10-02/level-options.png) 和 [设置选择器](reasoning-levels-2026-10-02/settings-level-options.png)。

真实 SDK 参数回归新增 4 项：OpenAI Responses、Anthropic、自定义兼容接口均捕获真实 SDK 生成的请求体，断言 max 覆盖已有低等级；不支持的适配器明确失败且不调用模型。测试仅替代提供商 HTTP 响应，不替代 SDK、转换或网关代码。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| pnpm typecheck | 全包通过；最后提示层调整另经 Web 类型检查通过 |
| pnpm build:web | 最终实现通过，仍有依赖注释与 bundle 警告 |
| 模型包测试 | 1 file / 13 tests 通过，包含最高档的 4 项新增回归 |
| 最终 Web + gates 测试 | 8 files / 53 tests 通过 |
| 本轮中途 pnpm test | 52 files / 334 tests 通过；发生在 minimal 展示缩减前，后续 UI 经上述聚焦测试和真实浏览器验证，不将中途计数当作最终整树门禁通过 |
| 最终变更文件 Biome | 10 files 检查通过，2 条已有 suppression warning |
| git diff --check | 通过 |

检查摘要见 [gate-results.txt](reasoning-levels-2026-10-02/gate-results.txt)。本次未重跑完整 pnpm check；此前构建产物循环引用导致的依赖门禁问题见 [输入框专项验收](composer-settings-2026-10-02.md)，本轮未修改门禁配置。全测试仍输出 QuickJS JS_FreeRuntime 断言消息，本次不处理此独立问题。

真实提供商是否接受具体模型的 max、实际推理行为与耗时、Electron 和其他浏览器未验证。模型名称不用于推断支持等级。

## 重现

```sh
pnpm build:web
node packages/server/test/fixtures/composer-settings-server.ts /tmp/excelmanus-reasoning-fresh
PLAYWRIGHT_MODULE=<Playwright index.mjs 路径> node packages/web/test/fixtures/composer-settings-browser.mjs <实际URL> <证据目录>
```

每次使用新的隔离目录。脚本最终删除夹具模型以检查无模型状态。
