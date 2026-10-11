# 0001 run_script 沙箱采用 QuickJS 同步变体 + worker_threads + 宿主 Promise 桥

- 状态：已接受
- 日期：2026-09-29

## 背景

08 §3 选定 QuickJS（WASM）运行在 `worker_threads` 中，§4 写"使用异步变体，宿主函数返回 Promise"。M0 需按 08 §7 验证逃逸、终止、性能、冷启动、三平台（15 M0；附录 C T-5）。判据由负责人编写于 `spikes/quickjs-sandbox/escape-cases.json`（51 例 + 3 项性能）。证据：`spikes/quickjs-sandbox/REPORT.md`、`results/cases.json`、`results/extra-cases.json`、`results/bench.json`。

## 选项

### 选项 A：asyncify 变体（08 §4 原文）

- 优点：宿主函数可直接写成 async。
- 缺点：实测宿主函数只能在 `evalCodeAsync` 顶层入口挂起；脚本 `await` 后在 pending job 内再调用宿主函数无法挂起。绕过需调用私有 FFI（`QTS_ExecutePendingJob_MaybeAsync`）。
- 风险：依赖私有 API，升级即破。

### 选项 B：同步 release 变体 + 宿主 Promise 桥

- 做法：宿主函数同步返回 `ctx.newPromise()` 的句柄；worker 把请求 postMessage 给主线程，响应回来后 resolve，并循环 `executePendingJobs()` + `getPromiseState()` 驱动脚本。只用公开 API。
- 优点：脚本侧语义与 A 相同（宿主函数返回 Promise、`await`）；实测全部判据通过。
- 缺点：需要自写泵循环；`ctx.resolvePromise()` 不驱动 job 队列，不能使用。

## 决定

选 B。`quickjs-emscripten` 与 `@jitl/quickjs-wasmfile-release-sync` 精确锁定 0.32.0（MIT）。修订 08 §4 "异步变体"为本方案。

必须随实现一起保留的设计点（均有实测依据）：

- 每次运行新 runtime + context；预热池 2（= 并发上限），其余排队。
- 参数与返回值都在 VM 内 `JSON.stringify`（getter/toJSON/Proxy 受中断约束），宿主只收发字符串。
- 墙钟看门狗 `timeoutMs + 250ms` 到点 `worker.terminate()` 并 abort 在途宿主操作：灾难性正则回溯（X08）中断回调覆盖不到，只能靠它。
- `setMaxStackSize` 取 1 MB（8 MB 会让任何 eval 立即栈溢出）。
- 注入 SDK 时删除 `SharedArrayBuffer`（该构建默认暴露）。
- wasm 线性内存只增不减：以 memory/output 终止的 worker 直接回收补位。
- 路径校验：拒绝绝对路径/盘符/scheme/UNC/NUL/编码穿越；`realpath` 必须在工作区内；**不存在的路径段先 `lstat`，悬空符号链接一律拒绝**（spike 审阅中发现并修复的写逃逸，E01–E03b 回归）。

## 后果

- 正面：51/51 逃逸用例 + 5/5 补充用例通过；loop100k p50 2.7 ms，5 万行传输 p50 39.5 ms，冷启动 p50 53.6 ms（预热池 0.66 ms），均远低于门槛。
- 负面 / 代价：泵循环与 deferred 生命周期（`dispose()` 连带释放 handle）需要谨慎实现；强制 terminate 偶发 QuickJS `gc_obj_list` 断言日志噪音。
- 需要跟进的事项：
  - **三平台未验证**：只测了 macOS arm64；x64 与 Windows x64 放到 M3（`run_script` 所在里程碑）的 CI 矩阵，未验证前 08 §7 该项不算通过。
  - 路径校验存在 TOCTOU 残余：产品实现写入先落 `.excelmanus/tmp/` 暂存再原子 rename（08 §4 已要求），并在打开时用不跟随链接的方式。
  - worker 崩溃的终止原因目前兜底为 timeout + detail，产品实现应区分 `crash` 类别（需在 06 错误码词表登记）。

## 验收标准符合性

对应 08 §7 全部判据与 14 中 `run_script` 相关门禁：逃逸集（≥30 例，实测 51+5）全部拦截；强制终止三类（死循环/深递归/大数组）在限制内结束且宿主存活；性能与冷启动达标。判据文件与补充用例入库于 `spikes/quickjs-sandbox/`，产品 `sandbox` 包实现时直接复用为测试集。
