# 输入框思考等级与任意文件引用验收

- 日期：2026-10-02（Asia/Shanghai）
- 范围：聊天输入框思考等级、文件选择/上传/引用、Cookie 模式附件鉴权。
- 依据：02 §3.3、09 §3、11 §4、ADR 0020；本记录不代表里程碑整体完成。

## 实现

- 输入框旁提供七个 protocol 定义的思考等级，直接保存到当前代理所用的模型档案；切换模型后入口跟随档案。失败时保留原值，无模型时禁用。与设置中心编辑同一字段，后续请求使用保存值。
- 添加文件按钮不再限制图片扩展名。支持混合多选、粘贴、拖入；PNG/JPEG/GIF/WebP 保留图片附件链路，其他文件通过现有工作区上传契约，在发送时追加真实返回的 @路径。发送前显示可移除的卡片和上传/失败状态。
- 同名上传返回 409，不覆盖或只凭同名引用旧内容。上传中或失败时阻止发送，失败发送保留草稿和文件卡片；移除卡片不删除已上传文件。会话切换清除卡片，迟到结果不进入新会话。
- 修复协议客户端三处附件请求遗留的 Bearer null：本机 Web 使用 Cookie，桌面令牌模式仍使用 Bearer；图片读取复用统一二进制下载路径。
- 极窄聊天区域中工具栏换行，等级与发送按钮不重叠。

## 环境与真实边界

macOS arm64，Node 24.1.0，项目 pnpm 10.11.0，bundled Playwright Chromium。浏览器尺寸 1440×900 与 420×850（保留展开侧栏，检查极窄聊天区域）。隔离数据目录 `/tmp/excelmanus-composer-20261002-05`，真实 startServer、HTTP、WebSocket、SQLite 文件、协议客户端、运行时与模型网关。仅模型提供商输出使用 ai/test MockLanguageModelV4 替代；模型夹具同时断言 SDK 收到的 reasoning 与已解析档案一致。

故障注入通过浏览器中断真实网络请求，分别检查保存失败、发送失败和延迟上传；没有替换应用服务、工具执行器或持久化代码。

## 浏览器场景

以下 11 项通过，机器记录见 [browser-results.json](composer-settings-2026-10-02/browser-results.json)：

1. 七个思考等级均经真实 HTTP 保存并读回。
2. 刷新页面保留选择。
3. 等级保存失败保留原值。
4. CSV（含空格中文文件名）、任意二进制、SVG 与 PNG 混合多选：消息日志有三条路径和一张图片；真实网关收到对应引用和图片，返回等级 high；已发送图片可通过 Cookie 读回并显示。
5. 切换模型后显示该档案等级，只修改当前档案，原档案不受影响。
6. 同名文件冲突不覆盖，失败卡片阻止发送；下载旧文件仍是原始字节。
7. 发送失败保留草稿和卡片，重试只发送一次引用。
8. 延迟上传期间切换会话，迟到结果不进入新会话草稿或卡片。
9. 窄屏无控件重叠，键盘打开等级选择；provider-default 进入网关时不显式覆盖 SDK reasoning。
10. 无模型时等级控件禁用。
11. 浏览器无 pageerror。

已人工复核 [桌面截图](composer-settings-2026-10-02/desktop.png) 和 [窄屏截图](composer-settings-2026-10-02/narrow.png)。

## 门禁

| 检查 | 本轮结果 |
| --- | --- |
| pnpm typecheck | 根与所有产品包通过 |
| pnpm lint | 通过；107 个 warning / 4 个 info，未放宽规则 |
| pnpm build:web | 通过；仍有依赖注释、分块和大 bundle 警告 |
| pnpm test | 52 files / 330 tests 通过，包含增强的真实 HTTP Cookie 上传与图片读取回归；最后仅调整工具栏换行，随后另经类型/构建/浏览器复核 |
| Cookie 鉴权聚焦测试 | 1 file / 1 test 通过 |
| pnpm check:licenses | 494 个依赖通过，沿用已有构建期例外 |
| pnpm check:deps | **未通过**：声明方向检查 22 个包通过；depcruise 将 Web dist 当作输入，报告 index-zvmAaiQU.js → Workbench-kziokkfo.js → index-zvmAaiQU.js 循环 |
| pnpm check | **未通过**，依赖门禁阻塞；不宣称整体门禁通过 |
| git diff --check | 通过 |

现有 `docs/acceptance/change-highlights/browser-results.json` 缺少末尾换行，首次 lint 被阻塞。本轮只补了末尾换行，未改变该证据数据。没有修改依赖/许可证/安全门禁配置，也没有以过滤构建产物的替代命令冒充原命令通过。

门禁摘要见 [gate-results.txt](composer-settings-2026-10-02/gate-results.txt)。全测试仍输出 QuickJS JS_FreeRuntime 断言消息，测试进程退出码为 0；本轮没有调查或修复此独立问题。

## 重现

```sh
pnpm build:web
node packages/server/test/fixtures/composer-settings-server.ts /tmp/excelmanus-composer-fresh
PLAYWRIGHT_MODULE=<Playwright index.mjs 路径> node packages/web/test/fixtures/composer-settings-browser.mjs <实际URL> <证据目录>
```

每次使用新的隔离数据目录；浏览器脚本最后删除夹具模型以检查禁用状态。Playwright 来自测试宿主，不向产品增加依赖。真实提供商是否接受各等级、真实模型读取和理解各格式文件、Electron 和其他浏览器本轮未验证。
