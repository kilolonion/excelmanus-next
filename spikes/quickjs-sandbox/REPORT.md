# M0-C QuickJS 沙箱 spike — 验证报告

## 结论

**51/51 逃逸与滥用用例全部通过**（含全部公共后置条件），3 项性能判据全部达标。
`quickjs-emscripten@0.32.0`（同步 release 变体 + worker_threads + 宿主 Promise 桥）
满足 docs/08 对"模型生成代码只在 QuickJS 内运行"的全部 M0 要求，可以作为
`sandbox` 产品包的实现基线。

## 摘要表（结论先行）

| 判据 | 结果 | 关键数据 |
|---|---|---|
| G01–G13 宿主对象/全局/信息泄露 | ✅ 13/13 | `process`/`require`/`fetch`/`WebAssembly`/`self` 等全 undefined；`import()`/Function 逃逸被 BLOCKED；错误栈无宿主路径（CLEAN）；`prepareStackTrace` 不可污染宿主（SAFE） |
| P01–P03 原型污染 | ✅ 3/3 | 脚本内污染 VM 内建不影响宿主；SDK 返回值为纯 JSON 数据，跨调用互不可见 |
| R01–R05 返回值滥用 | ✅ 5/5 | toJSON/Proxy 死循环在 timeoutMs 内被 VM 中断（1501ms ≤ 2000ms）；循环引用→TypeError；50MB 返回值→output 终止 |
| X01–X11 资源耗尽 | ✅ 11/11 | 死循环/栈溢出/内存膨胀/正则回溯/Promise 洪水均在 timeoutMs+500ms 内终止（timeout/memory/scriptError/output） |
| S01–S15 SDK 边界 | ✅ 15/15 | 路径穿越全 OUT_OF_WORKSPACE/NOT_FOUND；符号链接不跟随外指；`.excelmanus` 不可见；delete→UNSUPPORTED_FEATURE；>32MB→LIMIT_EXCEEDED；SDK 暴露面恰为白名单 |
| T01 超时+在途操作取消 | ✅ | 800ms 超时命中，宿主侧 `slow.xlsx` 30s 操作收到 abort（evidence 已记录），池子立即恢复 |
| T02/T03 隔离 | ✅ | 每次运行新 runtime+context；两个并发脚本互不污染 |
| T04 100 次混合运行 | ✅ | RSS 净增长 −85MB（判据 ≤100MB），活跃 worker 回到预热池 2 |
| 公共后置条件 | ✅ | 51 例全部：金丝雀零泄露、宿主原型快照不变、哨兵目录校验和不变、哨兵端口零连接、`return 1+1`<1s、RSS ≤512MB |
| loop100k | ✅ | p50 2.7ms / p95 16.9ms（判据 ≤1000ms） |
| transfer50kRows | ✅ | 5 万行×6 列单次 SDK 往返 p50 39.5ms / p95 65.1ms（≤1000ms），列求和结果正确 |
| coldStart | ✅ | 预热池 p50 0.66ms / p95 1.3ms；冷启（新 worker+wasm+runtime+ctx+eval）p50 53.6ms / p95 56ms（≤300ms） |

结果文件：`results/cases.json`（每例期望/实际/耗时/各项后置条件）、`results/bench.json`。

## 架构（与 docs/08 §4 的偏离见下）

- **主线程 `Sandbox`**（`src/sandbox.ts`）：worker 预热池 2（=最大并发），其余排队；
  每次运行向 worker 发 `run` 消息；主线程持有真实 SDK 宿主实现并回包；
  超时看门狗 = `timeoutMs + 250ms` 宽限，到点 `worker.terminate()` 并 abort 该脚本
  所有在途宿主操作（T01 证据由此产生）。
- **worker**（`src/worker.ts`）：加载 `@jitl/quickjs-wasmfile-release-sync`，
  每次运行 `newRuntime`+`newContext`（T02/T03 隔离）；`setMemoryLimit(256MB)`、
  `setMaxStackSize(1MB)`、`setInterruptHandler(>deadline)`；脚本包装为
  `(async () => {…})()`；手动循环 `executePendingJobs()` + `getPromiseState()`
  + `setImmediate` 泵到顶层 promise 结算。
- **SDK 桥**：guest 侧 `__call` 先用 VM 内 `JSON.stringify` 序列化参数（getter 在
  VM 内执行、可被中断，S10），`__sdk_call_raw` 同步返回 `ctx.newPromise()` 的
  handle；宿主结果以 JSON 字符串回填并在 VM 内 `JSON.parse`（P02/P03/S15）。
  注入的全局面恰好为 `files{find,manage,readText,writeText}`、`wb{read,analyze,edit,export}`、
  `console{log}`（S13 实测精确匹配）。
- **路径校验**（`src/sdk-host.ts`）：拒绝 NUL、URL 编码穿越（两轮解码）、
  `file:`/任意 scheme/盘符、`\`→`/` 规范化后拒绝绝对路径与 `..` 逃逸；
  `fs.realpath` 必须落在工作区 realpath 内（S04 外指符号链接被拒）；
  `.excelmanus/` 前缀一律 NOT_FOUND。

## 环境

- macOS arm64（Apple Silicon），Node v24.1.0（原生 TS 类型剥离直跑 `.ts`），pnpm workspace。
- `quickjs-emscripten@0.32.0` + `@jitl/quickjs-wasmfile-release-sync@0.32.0`
  （2026-02-16 发布，满足 7 天规则；许可证 MIT）。
- **x64 与 Windows 未验证**：本机无 x86_64 运行时（`arch -x86_64` → `Bad CPU type in executable`），
  亦无 Windows 环境。QuickJS wasm 与 worker_threads 均为跨平台机制，预期可移植（推测）。

## 偏离（相对 docs/08 §4）

1. **同步变体替代 asyncify**。docs/08 §4 写"异步变体"，实际用 `release-sync` +
   宿主 Promise 桥。原因（已实验证实）：asyncify 的宿主函数只能在
   `evalCodeAsync`/`callFunction` 顶层入口挂起；脚本 `await` 之后从 pending
   Promise job 里再调宿主函数时无法正确挂起（挂死/未决 promise/释放后访问），
   私有 FFI `QTS_ExecutePendingJob_MaybeAsync` 属私有 API 不可用于结论。
   客户可见语义不变：宿主函数返回 Promise、脚本内 `await`。
2. **`setMaxStackSize` 取 1MB**。实测 wasm 构建实际栈小于 8MB：设为 8MB 会让
   `stack_top - limit` 越界导致**任何 eval 立刻报 stack overflow**；1MB 足够
   正常代码且能兜住递归（X02 在 6ms 内报 InternalError）。
3. **`SharedArrayBuffer` 在注入 SDK 时被删除**。该 QuickJS 构建把它暴露为全局
   （无 `Atomics`），G05 判据要求 undefined；在每次运行的 SDK 注入段
   `delete globalThis.SharedArrayBuffer`（裸上下文枚举基线不受影响，G10 仍成立）。
4. **memory/output 终止后回收 worker**。wasm 线性内存只涨不缩：X04 单例曾使
   宿主进程 RSS +1.26GB（逻辑上限 256MB 之外的 wasm 增长与保留）。命中
   `terminated: memory|output` 的 worker 直接 `terminate()` 释放并由池补位；
   回收后 RSS 回落，后置条件通过。
5. **许可证检查失败（既有问题，非本 spike 引入）**。`pnpm check:licenses` 报
   `buffers`(Unknown)、`chainsaw`/`traverse`(MIT/X11)、`pako`(MIT AND Zlib)
   不在白名单；`pnpm why` 证实全部来自 `spikes/univer-formula` 的 `exceljs`
   传递依赖（`jszip→pako`、`unzipper→binary→chainsaw→traverse`）。QuickJS 相关
   包全为 MIT。**已处理**：负责人决定白名单加 `Zlib`、`MIT/X11` 视同 MIT、
   `buffers@0.1.1` 列为版本精确例外（`scripts/check-licenses.ts`），门禁恢复全绿。

## 影响架构的意外发现

- **`ctx.resolvePromise(p)` 不驱动 job 队列**（docs 的坑位复现）：用它等待顶层
  promise 会永久挂住；必须自循环 `executePendingJobs()` + `getPromiseState()`。
- **`QuickJSDeferredPromise.dispose()` 会连 `handle` 一起释放**：先 `dispose()`
  再 `return d.handle` 会向 guest 抛出 `QuickJSUseAfterFree`（S08/S09 曾因此
  误判）。已确认顺序：resolve → dispose resolvers，handle 交给 VM 所有权。
- **wasm 堆峰值不被 `setMemoryLimit` 限制**：逻辑限制只管 QuickJS 对象分配，
  wasm 线性内存按峰值增长且不缩——必须靠 worker 回收才能归还 RSS（偏离 4）。
- **强制 teardown 偶发 `Assertion failed: list_empty(&rt->gc_obj_list)`**
  （`JS_FreeRuntime`，stderr 一条 `Aborted(...)`）：出现在被 terminate 的
  worker 的收尾阶段，worker 本就销毁，池子自动补位，无功能影响；日志噪音。
- **worker 内宿主侧 V8 错误可被观测为脚本错误**：X10（4MB 深括号 JSON.parse）
  使 `ctx.dump` 递归触发 `Maximum call stack size exceeded`，被兜为
  `HostInternalError` → scriptError，判据仍通过；如需可再收窄 dump 深度（推测）。
- **灾难性正则回溯（X08）确实靠 `worker.terminate()` 兜底**：VM 中断回调覆盖
  不到 regexp 引擎内部，看门狗在 timeoutMs+250ms 处杀线程，仍在判据窗口内。
- **审阅发现并修复：悬空符号链接写逃逸**。初版 `assertInsideRealpath` 对叶子
  realpath 得 ENOENT（悬空链接）后退到父目录校验即放行，`writeFileSync` 随后
  跟随链接把文件写到了工作区外（已实测复现：`evil.txt -> 界外/pwned.txt` +
  `writeText` → 界外文件被创建）。修复：realpath 报 ENOENT 的每一级先做
  `lstatSync`，若是（悬空）符号链接直接 OUT_OF_WORKSPACE；只有 lstat 也
  ENOENT 才继续向上。`writeText`/`manage copy|move|mkdir` 全部经
  `resolveWorkspacePath`，同一条校验全覆盖。回归用例见 `src/extra-cases.ts`
  （E01–E04，5 例全过，含"界内有效链接可写"的防过度拒绝例）。
  **残余风险（TOCTOU）**：校验与写入之间链接可被并发替换；spike 场景下无可行
  触发方（脚本不直接持 fs），产品实现需按 08 §4 的"先写暂存再 rename"或
  `O_NOFOLLOW` 类手段收口。

## 复现

```bash
pnpm install
pnpm --filter @excelmanus-spike/quickjs-sandbox run cases   # → results/cases.json（51/51）+ extra-cases.json（5/5）
pnpm --filter @excelmanus-spike/quickjs-sandbox run bench   # → results/bench.json
pnpm --filter @excelmanus-spike/quickjs-sandbox run typecheck   # 通过
pnpm exec biome check spikes/quickjs-sandbox                # 0 error（13 warning：noNonNullAssertion 等风格项）
pnpm check:deps                                             # 通过（18 包无违规）
pnpm check:licenses                                         # 通过（见偏离 5）
```

判据文件 `escape-cases.json` 未做任何修改；S04/S05 fixture 按 JSON 描述在
临时目录搭建，跑完即清理；`/tmp/qjs-smoke` 实验目录已删除。
