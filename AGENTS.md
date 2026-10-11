# AGENTS.md — ExcelManus Next 开发约定

## 定位

小型开源项目，**功能优先**：把产品做出来、做好用，不追求全面测试、发布认证或过度防御。拿不准值不值得做时先问：它是否直接让用户完成更多任务、少踩坑？

- 设计依据在 `docs/`（入口 `docs/README.md`）。它是设计参考，不是合同；文档和实现冲突时改成一致即可，哪边对就改另一边。
- 待办、功能缺口和已知问题只记在 `docs/backlog.md`，做完就删掉对应条目。
- 改动不需要写 ADR、验收记录或证据。只有影响全局的取舍（换核心依赖、改下面的核心约定）才在 `docs/decisions/` 写几段话的 ADR。`docs/acceptance/` 是历史存档，不再新增。
- 不参考、不复制旧仓库 `~/Desktop/excelmanus` 的代码。

## 不要做的事

- 不为"完整"补测试矩阵、逐端点契约测试、覆盖率或验收场景证据。
- 不主动追加新的安全加固层、审计式排查或边界情况防御。现有防护保持，遇到具体问题再修。
- 不在签名公证、安装包自检、性能基准、真实模型评测上投入，除非用户明确要求（见 backlog「暂缓」）。
- 不做与当前任务无关的重构、抽象和"顺手优化"。

## 核心约定

这些是产品正确运行的基础，已经实现，保持即可。确需改动时先想清楚影响，改完同步文档。

1. TypeScript strict 全栈（ESM，Node ≥ 24）；不引入 Python；不提供任意 shell 执行工具。
2. 不 fork agent 框架。模型网关只用 Vercel AI SDK 的单步能力，代理循环是自有代码；AI SDK 类型只出现在 `models` 包。
3. **会话日志是会话状态的唯一事实源**：写日志与更新投影在同一 SQLite 事务，提交后才推送客户端，投影可删除后重建。历史只追加（压缩除外），系统提示词在会话内冻结，每轮变化的上下文放在用户消息前的 `<context>` 块。
4. **活文档**：文档 actor 是工作簿唯一写入者，修订号递增。用户编辑、代理工具、脚本走同一条写入路径（`baseRev` + 读集，区域级冲突检测）；xlsx 是异步检查点。
5. **不破坏用户文件**：未修改的部分原样保留，做不到就拒绝并说明；会话内首次修改已有文件前自动备份；删除进回收站。
6. 工具调用先写 `tool.intent` 再写 `tool.result`；崩溃恢复不自动重放有副作用的操作。
7. 契约包 `protocol`（Zod）是 REST、同步通道、日志记录类型的唯一定义；字段一律 camelCase；前端只用契约客户端发请求。
8. 主代理内置工具 ≤ 22 个，统一 `ToolResult` 与错误码词表（在 `protocol` 中）。
9. 包依赖方向：`protocol`、`core` 不依赖其他包；`kernel`/`models`/`sandbox` 只依赖 `protocol`、`core`；`modules/*` 之间互不依赖；`web` 只依赖 `protocol`、`core`；`server` 负责装配；`desktop` 只依赖 `protocol`、`core`、`server`。`pnpm check:deps` 自动检查，规则在 `scripts/dependency-matrix.ts`。

## 基本防护（保持现状，不扩展）

服务只监听本机并校验访问令牌；文件工具限定在工作区内；密钥加密存储，不进日志和错误信息；模型生成的代码只在 QuickJS 沙箱运行。改相关代码时别把它们弄坏，不需要再加新层。

## 依赖

- 用 `pnpm add` 添加，避免 `latest`、`*` 和无上界范围。
- Univer 全家、`quickjs-emscripten`、`ai` 与 `@ai-sdk/*` 精确锁定版本；**前后端的 Univer 必须是同一版本**（mutation 格式互相耦合）。
- 只用宽松许可（MIT、Apache-2.0、BSD、ISC 等），由 `pnpm check:licenses` 检查。禁止 `@univerjs-pro/*` 和 HyperFormula（许可不兼容）。确需例外时加进 `scripts/check-licenses.ts` 的白名单，在提交说明里写原因。
- typescript 锁在 6.x：dependency-cruiser 18 只支持 TS < 7 的转译器。

## 代码约定

- 目录 `packages/{protocol,core,kernel,models,modules/*,sandbox,server,web,desktop}`，包名 `@excelmanus/<目录名>`；日期时间用 ISO 8601 UTC 字符串。
- 简洁：一个通用机制能解决就不做三个专用机制；只在真实边界处理错误；不写与需求无关的注释。
- 用户可见文案集中在 `packages/web/src/strings.ts`（简体中文）。
- 前端控件只用 `packages/web/src/components/ui/`，图标只经 `Icon.tsx`，不用原生 `select`、`confirm`、`title` 提示（`ui-conventions.test.ts` 会检查）。
- 技能只写任务方法；工具用法写在工具说明里，产品帮助写在 `docs/user-guide.md`。分工见 `docs/17-skill-authoring.md`。

## 测试

- 改了容易出错的逻辑（区域运算、reduce、冲突判定、写回、恢复）就补一条测试；修 bug 先写一条能复现的测试。新功能只要求现有测试继续通过。
- 测试尽量跑真实代码（真实 HTTP、WebSocket、SQLite），假模型只替代模型服务的输出。
- 过时或成本远大于价值的测试可以删改，在提交说明里写一句原因。
- 本机装了 LibreOffice 时，部分测试会额外实际打开生成的文件；没装就跳过这一步。
- 改了页面就在浏览器里实际看一眼；发布前按 `docs/14-quality.md` 的冒烟清单走一遍。

## 命令

- 安装：`pnpm install`（CI 用 `pnpm install --frozen-lockfile`）
- 启动：`pnpm start`（先构建前端再启动后端，打开终端打印的地址）；开发模式 `pnpm dev`（后端 8787 + Vite 5173）
- 用假模型看页面（不花钱）：`pnpm build:web` 后运行 `node packages/server/test/fixtures/ui-preview-server.ts <数据目录> [端口] packages/web/dist`，打开输出的地址
- 检查：`pnpm check`（typecheck + lint + 依赖方向 + 许可证）；`pnpm check:all`（再加 Web 构建和全部测试）
- 单项：`pnpm typecheck`、`pnpm lint`（自动修复 `pnpm exec biome check --write .`）、`pnpm test`、`pnpm build:web`
- 桌面：`pnpm build:desktop` 构建；`pnpm --filter @excelmanus/desktop start` 运行；`pnpm pack:desktop` 打 zip 包
- 更新模型目录快照：`node scripts/update-model-catalog.ts`

## 当前状态（2026-10-11）

V1 功能和前端整体重构的代码已完成，2026-10-10 的 `pnpm check:all` 通过（72 个文件 / 371 个测试）。新前端还没在浏览器里实际跑过。接下来做什么见 `docs/backlog.md`。
