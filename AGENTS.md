# AGENTS.md — ExcelManus Next 实现约定

## 唯一依据
- 实现**只依据 `docs/`**（入口 `docs/README.md`）。不参考、不复制旧仓库 `~/Desktop/excelmanus` 的任何代码。
- 约束等级：**【硬性】** 不可偏离；**【推荐】** 可换，但必须在 `docs/decisions/NNNN-标题.md` 写 ADR（背景、选项、决定、后果，并说明新方案如何满足同一组验收标准）；**【开放】** 自行设计。无标记视为【推荐】。
- 文档与实现冲突：先判断哪边错。文档错就改文档；实现错就改实现；不允许长期不一致。
- 文档未覆盖、且影响用户可见行为或数据安全的问题：记入 `docs/appendix-c-open-questions.md`，不要擅自拍板。
- 完成状态以验收记录为准：里程碑结束时写 `docs/acceptance/<里程碑>.md`（执行了哪些门禁/场景、环境、结果、证据位置、已知问题）。**没有证据的项不能标记为通过。**

## 硬性红线（摘要，细节以原文为准）
1. TypeScript strict 全栈（ESM，Node ≥ 24）。不引入 Python；不提供任意 shell 执行工具。
2. 不 fork 任何 agent 框架。模型网关 = Vercel AI SDK 7 **单步**能力（工具不提供 `execute`，工具调用交回自有效果执行器）；运行时（Agent actor）是自有代码。运行时/日志只见产品中立消息格式，AI SDK 类型只出现在 `models` 包适配层。（03 §5）
3. **会话日志是会话状态唯一事实源**；写日志与更新物化投影在**同一 SQLite 事务**；事务提交后才推送客户端；投影必须可删除后重建，CI 有"重建 = 增量"测试。流式增量不入日志。（03 §3.1、10）
4. **活文档**：文档 actor 是唯一写入者，修订号严格递增；用户编辑/代理工具/脚本走同一条写入路径；提交带 `baseRev` + 读集，区域级冲突检测；文档日志先落库，xlsx 是异步检查点。（03 §3.2、§6，07）
5. **不破坏文件**：未修改部件逐字节保留；做不到保留就拒绝并说明，不静默丢失。修改已有文件前强制自动备份（会话内首次）。（07 §1、§7）
6. 契约包 `protocol`（Zod）是 REST/同步通道/日志记录类型的**唯一定义**；**字段一律 camelCase**，不做命名转换；前端只通过契约生成的客户端发请求；未知记录类型只警告忽略。（11）
7. 工具：主代理内置 ≤ 22 个；每个工具声明 `name/title/description/input/output/effect/targets/replay/timeoutMs/roles`；统一 `ToolResult`；错误码用统一词表（新增需登记）；不做"按需发现工具"。（06）
8. 历史**只追加**，只有压缩可改写；系统提示词会话内冻结；每轮变化的上下文放本轮用户消息前的 `<context>` 块。（04 §6–7）
9. 所有工具调用先写 `tool.intent` 后写 `tool.result`；崩溃恢复**永不自动重放有副作用的操作**。（04 §8）
10. 安全：只监听 `127.0.0.1`；设备令牌库中只存哈希；WebSocket 只用一次性短期票据；校验 `Host`/`Origin`；文件工具不出工作区、不跟随外指符号链接、`.excelmanus/` 对代理不可见；密钥 AES-256-GCM 且读接口只返回掩码；**日志/错误/导出中不出现密钥、文件内容、提示词正文**；模型生成代码只在 QuickJS 沙箱运行。（01 §5.3、03 §13、10 §4）
11. 许可证：只用 MIT/Apache-2.0/BSD/ISC 等宽松许可依赖；**禁止** `@univerjs-pro/*`、HyperFormula。前端与服务端 Univer **同一精确版本**（精确锁定，不用范围）。（03 §10）
12. 依赖方向（CI 强制，禁止循环）：`protocol`、`core` 不依赖其他工作区包；`kernel`/`models`/`sandbox` 只依赖 `protocol`、`core`；`modules/*` 只依赖 `kernel` 公开接口、`protocol`、`core`、`models`、`sandbox`，**模块之间互不依赖**；`web` 只依赖 `protocol`、`core`；`server` 负责装配；`desktop` 只依赖 `protocol`、`core`、`server`。
13. 验收在真实边界：真实 HTTP、真实 WebSocket、真实 SQLite 文件；假模型只替代模型服务输出，**不替代我们自己的任何代码**；不写"仓库内能过、别处起不来"的假绿门禁。（14）

## 依赖与版本策略
- 新增依赖用 `pnpm add`；**优先选发布满 7 天以上的版本**（`npm view <pkg> time --json` 查发布时间）；避免 `latest`/`*`/无上界范围；关键依赖（Univer 全家、`quickjs-emscripten`、`ai` 及 `@ai-sdk/*`）**精确锁定**。
- 不得修改仓库的安全策略/合规配置来绕过失败（如放宽许可证白名单、跳过检查）；遇到需要例外时停下来报告。
- 文档中给出的技术选型见 03 §10（Hono、Kysely、Zod 4、React 19 + Vite、TanStack、Zustand、Tailwind 4 + shadcn/ui、Vitest、Playwright、Electron 44+）；具体版本按上一条选择。

## 代码约定
- 目录结构见 03 §11（`packages/{protocol,core,kernel,models,modules/*,sandbox,server,web,desktop}`；`assets/ skills/ samples/ fixtures/ docs/`）。M0 验证代码放 `spikes/<名称>/`，**不进入产品包**；spike 结论写 `docs/decisions/`。
- 包名 `@excelmanus/<目录名>`。日期时间用 ISO 8601 UTC 字符串。
- 简洁：能用一个通用机制解决就不做三个专用机制；只在真实边界处处理错误；不添加与需求无关的注释。
- 用户可见文案集中管理（简体中文），不散落在组件里。

## 工作流
- 每个里程碑（`docs/15-milestones.md`）开始前先做该阶段的 spike，结论写 ADR；spike 失败按文档给出的备选方案切换，并把范围变化写进 ADR。
- 每个里程碑的退出条件 = `docs/14-quality.md` 中对应门禁与验收场景；逐项在 `docs/acceptance/` 留证据。

## 测试策略（ADR 0006，覆盖 14 §2–§4 的严格条款）
- 不追求工业级：每个主要能力一条真实边界集成测试（真实 HTTP/WS/SQLite + 假模型）+ 投影重建测试；不做逐端点契约测试、覆盖率、逐转换单测。
- 纯逻辑只在易错处测（区域运算、reduce、冲突判定）。

## 命令
- 安装：`pnpm install`（CI 用 `pnpm install --frozen-lockfile`）
- 类型检查：`pnpm typecheck`（根 scripts/test + 每包 `tsc --noEmit`）
- lint + 格式：`pnpm lint`（Biome `check`）；自动修复 `pnpm exec biome check --write .`
- 依赖方向检查：`pnpm check:deps` = package.json 工作区依赖声明校验（`node scripts/check-deps.ts`）+ 文件级 depcruise（规则与声明同源，见 `scripts/dependency-matrix.ts`）
- 许可证检查：`pnpm check:licenses`（`pnpm licenses list --json`，白名单见 `scripts/check-licenses.ts`）
- 单元测试：`pnpm test`（Vitest projects：每包一个 project，另含根 `test/gates/` 门禁反例测试）
- 一键门禁：`pnpm check`（typecheck + lint + deps + licenses，不含测试）；`pnpm check:all`（加测试）
- 裸 Node 直跑（source-first，无构建）：`node packages/server/src/smoke.ts`

## 当前进度
- 单仓骨架 + 门禁框架完成：pnpm workspaces，15 个包（protocol/core/kernel/models/sandbox/server/web/desktop + modules/*7），源码优先（exports → `./src/index.ts`，Node 24 原生类型剥离已验证），depcruise + 声明校验的依赖方向门禁（`scripts/dependency-matrix.ts` 单一规则源），许可证门禁，Vitest projects 测试，Biome lint，CI 门禁工作流。
- 依赖版本策略注意：`autoInstallPeers: false`（防止 vite 的 optional peer `lightningcss` MPL-2.0 被自动装入）；typescript 锁定 6.0.3 而非 7.x（depcruise 18 只支持 TS <7 转译器）。
- 下一步：M0 spike（QuickJS 沙箱、Univer 无头、node:sqlite WAL/FTS5、AI SDK 单步），结论写 `docs/decisions/`。
