# 流式对话滚动与历史阅读验收（2026-10-01）

本次专项通过；不代表 M6 或整个并行工作树全部验收通过。设计依据为用户本轮要求、02 §3.1 与 [ADR 0017](../decisions/0017-chat-scroll-ownership.md)。保留原有未提交改动，没有提交或推送。

## 1. 修复范围

- 移除对话每次渲染无条件 `scrollIntoView`，由单一控制器只写入对话视口。
- 跟随最新与自由阅读分开管理；向上输入同步释放，取消已排队的自动滚动。下滚到达底部、历史视口 `End` 或显式恢复按钮重新跟随；发送、停止、生成结束不自动抢回滚动权。
- 原生滚动动画与触摸惯性期间不以旧锚点覆盖用户移动。处理流式增长与滚轮合成线程使用上一帧底部的竞态，避免已经向下滚到底却无法恢复跟随。
- 布局观测覆盖流式增量、消息落定与视口尺寸变化；自由阅读保持可见消息及偏移。返回会话时用缓存的已应用日志游标区分回放未完成与内容真正缩短，防止临时顶部校正覆盖阅读位置。
- 会话/代理视图缓存最近 30 项；隐藏面板与窄屏页签重挂载恢复原位置。工具参数/结果复用可聚焦的 UI ScrollArea，隔离滚轮、触摸与键盘导航。

涉及 `packages/web/src/use-chat-scroll.ts`、`components/ChatPanel.tsx` 与集中文案 `strings.ts`。未改变协议、会话日志、模型调用或依赖。

## 2. 环境与真实边界

- macOS arm64，Node v24.1.0，生产 Vite Web 构建，独立 headless Chromium（Playwright）。
- `packages/server/test/fixtures/chat-scroll-server.ts` 启动真实 `startServer`；真实 HTTP、WebSocket、SQLite 文件；只有 AI SDK 模型输出由 MockLanguageModelV4 替代。历史、工具执行、消息派发、停止与重连回放路径均使用产品代码。
- 数据全部为夹具：8 轮历史、一次真实只读 `find` 工具及可滚动长参数、`scroll.csv`、分批持续思考与正文。测试目录为 `/tmp/excelmanus-chat-scroll-20261001-03`，最终浏览器复测地址为 `http://127.0.0.1:60687`。
- 1440×900、1280×780、1024×768；触摸由 Chromium 原生 Input.dispatchTouchEvent 驱动，滚轮、键盘、选择文字与滚动条拖动由 Playwright 驱动。

## 3. 已执行场景

最终一轮 21 个场景全部通过，浏览器运行时错误为 0。完整数值证据见 [browser-results.json](chat-scroll-2026-10-01/browser-results.json)。自由阅读检查要求间隔内 scrollTop 变化小于 2px、消息锚点不变、外层页面 scrollTop 始终为 0；跟随检查允许一帧布局延迟，静止后到达真实底部。

| 场景 | 结果 |
| --- | --- |
| 1–2：加载历史默认到最新、持续生成自动跟随 | 通过 |
| 3–5：底部附近仅向上 8px 即释放、按钮恢复、快速连续向上滚轮 | 通过 |
| 6–8：编辑草稿、输入框方向键、调整窗口尺寸 | 通过，阅读位置与消息偏移保持 |
| 9–10：历史视口 PageUp、End | 通过，PageUp 保持自由阅读，End 明确恢复跟随 |
| 11–14：原生触摸、拖动滚动条、选择消息文字、向下滚轮到达底部 | 通过；向下恢复同时覆盖流式增长竞态 |
| 15–16：展开历史思考、工具参数独立滚动及其内部 End 键 | 通过，不抢占外层阅读位置 |
| 17–19：新视图默认跟随、返回旧会话恢复、停止与瞬时内容落定、结束后按钮返回 | 通过 |
| 20–21：打开真实 CSV 后隐藏/展开对话、窄屏表格/对话页签切换 | 通过，面板重挂载恢复阅读位置 |

截图：[自由阅读](chat-scroll-2026-10-01/history-reading.png)、[回到最新](chat-scroll-2026-10-01/following-latest.png)。

## 4. 门禁与证据边界

| 检查 | 结果与范围 |
| --- | --- |
| 前端类型检查、生产构建 | 最终滚动实现通过；构建保留既有大 chunk/依赖注释警告 |
| 本次源码与证据 JSON 的 Biome 检查 | 通过，ChatPanel 的两个既有无效 suppression 警告仍在 |
| `vitest --project web` | 5 files / 26 tests 通过；不替代本次真实浏览器验收 |
| 本轮中途 `pnpm check:all` | 52 files / 330 tests 通过，包括真实边界与投影重建；随后滚动调整另经类型/构建/浏览器复核，不能将该中途结果当成最终整个并行工作树通过 |
| 最终 `pnpm check` | 根与全包类型检查通过；lint 被并行新增的 `docs/acceptance/change-highlights/browser-results.json` 缺少末尾换行阻塞。没有改动该文件或放宽门禁；后续 deps/licenses 因命令短路未执行，本轮中途已通过 |
| `git diff --check` | 通过 |

本机详细命令输出保存在 `.agents/tasks/chat-scroll-2026-10-01/` 的 `build.txt`、`local-lint.txt`、`web-tests-final.txt`、`check-all.txt`、`check-final.txt` 与 `browser.txt`。浏览器通过证据与截图已复制到本验收目录，不依赖被忽略的临时目录。

## 5. 可重复执行与未验证范围

在仓库根目录构建后启动隔离数据目录，取标准输出中的实际 URL：

```sh
pnpm build:web
node packages/server/test/fixtures/chat-scroll-server.ts /tmp/excelmanus-chat-scroll-new 0
```

另一个终端运行浏览器脚本。Playwright 可从测试宿主提供；本次使用 Codex 已有 bundled runtime，没有向产品添加依赖：

```sh
PLAYWRIGHT_MODULE=/Users/jiangwenxuan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
  node packages/web/test/fixtures/chat-scroll-browser.mjs <实际URL> <证据输出目录>
```

脚本不依赖仓库原有数据或外部模型账户。缓存只在页面内存中；刷新默认跟随，消息锚点被删除或布局变短时按有效范围裁剪，不保证已删除内容的原位置。

真实断网重连、真实模型、物理触控板/手机、Electron 与其他浏览器未在本轮单独执行，不能标记通过；实现中的记录回放/增量更新使用同一个滚动控制器。本记录不扩展手机端产品承诺。
