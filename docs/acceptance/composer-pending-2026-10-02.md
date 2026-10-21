# 组合模型入口与待处理气泡验收

- 日期：2026-10-02（Asia/Shanghai）。
- 依据：02 §3.2–3.3、04 §4、11 消息/设置契约、16 §8、ADR 0022。
- 本轮是输入区和派发流程增量修复，不代表 M6a 整体验收完成。未提交任何变更。

## 实现与参考取舍

模型与思考等级合并为输入区底部入口，模型菜单使用大圆角、列表与右侧选中勾；思考子页使用六个离散停点（无、低、中、高、极高、最高）、当前等级、返回模型入口和重置为默认。保存作用域仍是当前代理的模型档案，设置中心共享同一字段。旧 minimal 只显示已保存值；不推断模型能力，也不新增语音输入。

单个蓝色圆形操作键在有草稿时显示上箭头，运行中输入为空时显示暂停方块。普通发送省略 mode，由服务端读取 defaultDispatchMode；权限与运行设置可以选择引导、排队或打断。输入区没有策略分拆按钮，Enter 与点击使用同一路径。

引导/排队消息只在真实服务端受理后显示待处理气泡。按用户随后要求，移除气泡下方整行紫色文字，保留虚线浅色边框和灰色时钟；辅助技术仍可读取待送达状态。点击气泡就地编辑，下方保留「打断并发送」「删除消息」。编辑保留原图与区域引用，打断可发送编辑后的正文。替换在一笔日志事务内撤回旧派发并登记新派发；已生效则返回冲突。删除只追加 cancelled，聊天隐藏旧消息，日志仍保留。

## 环境与真实边界

macOS arm64、Node 24.1.0、pnpm 10.11.0、bundled Playwright Chromium，1440×900 和 420×850 视口，浅色/深色主题。最终浏览器夹具数据目录 `/tmp/excelmanus-composer-pending-20261002-c`，真实 startServer、HTTP、WebSocket、SQLite、模型网关与运行时。仅模型服务输出由 MockLanguageModelV4 替代，长响应可以收到真实取消信号；假模型不替代工具、日志、持久化或派发代码。

网络失败通过浏览器中断真实请求注入。较早夹具将中断前后相邻 user 消息合并后的整段文本用于判定长响应，导致错误等待；最终夹具只按合并输入的末条消息生成输出，未修改产品对话历史逻辑。

## 浏览器场景

11 项通过，机器记录见 [browser-results.json](composer-pending-2026-10-02/browser-results.json)：

1. 鼠标和键盘切换真实代理模型档案。
2. 六个等级停点、默认重置经真实 HTTP 保存，刷新读回；与设置中心共用档案。
3. 设置中心保存默认排队策略。
4. 排队气泡编辑：原子替换、图片引用保留、刷新后仍显示待处理；同时断言紫色说明仅为不可见的辅助技术描述。
5. 删除后气泡隐藏，旧正文与撤回记录仍在日志。
6. 圆形暂停键停止当前任务、保留队列，气泡可以直接发送。
7. 默认引导时显示待处理气泡；编辑请求失败保留编辑稿，点击打断发送编辑后的正文。
8. 默认打断由 Enter 触发，输入区无策略分拆按钮。
9. 网络发送失败保留草稿、不伪造已受理气泡；恢复请求后可重试。
10. 窄屏菜单和操作键不越界、不重叠，侧栏收起后布局复核；浅/深色菜单均复核。
11. 无 pageerror。

人工复核截图：[模型菜单](composer-pending-2026-10-02/model-menu.png)、[思考滑条](composer-pending-2026-10-02/reasoning-high.png)、[暂停](composer-pending-2026-10-02/pause.png)、[无紫色文字的待处理气泡](composer-pending-2026-10-02/pending-queue.png)、[窄屏](composer-pending-2026-10-02/narrow-sidebar-collapsed.png)、[深色](composer-pending-2026-10-02/model-dark.png)。

## 服务端与门禁

`e2e-dispatch.test.ts` 新增一条真实边界场景，验证默认策略、同目标原子编辑/打断、重复提交/不同目标冲突、两个并发相同请求只登记一条替换、真实文档区域引用和图片引用保留、旧派发正文不进入后续模型请求、已生效冲突，以及 dispatches/agent_context 投影重建与增量一致。最终聚焦 1 file / 11 tests 通过。

| 检查 | 结果 |
| --- | --- |
| pnpm check | 通过：类型、lint、依赖方向、许可证；110 warnings / 4 infos |
| pnpm build:web | 通过，保留已有 bundle 警告 |
| pnpm test | 52 files / 335 tests 通过；在最终纯视觉调整之前执行 |
| 最后增量验证 | typecheck、增强后的派发集成测试 11 项、最终浏览器 11 项均通过 |
| git diff --check | 通过 |

门禁摘要见 [gate-results.txt](composer-pending-2026-10-02/gate-results.txt)。最初 check:all 被其他验收 JSON 的格式问题阻塞，本轮只格式化四份对应证据文件，未改动内容数据或门禁策略。最终按独立 check/build/test 完成门禁，没有把早期失败的一键命令写成通过。

全测试仍输出既有 QuickJS JS_FreeRuntime 断言，退出码为 0；本轮未调查此独立问题。真实模型服务是否接受各思考等级、Electron、其他浏览器和真实手机未验证。浏览器场景使用图片保留；区域保留和并发替换在服务端真实文档场景验证，未额外执行工作台框选浏览器流程。

## 重现

```sh
pnpm build:web
node packages/server/test/fixtures/composer-pending-server.ts /tmp/excelmanus-composer-pending-fresh
PLAYWRIGHT_MODULE=<Playwright index.mjs 路径> node packages/web/test/fixtures/composer-pending-browser.mjs <实际URL> <证据目录>
pnpm exec vitest run packages/server/test/e2e-dispatch.test.ts
```

夹具每次使用新的隔离数据目录。证据生成后按仓库 Biome 格式化 JSON。
