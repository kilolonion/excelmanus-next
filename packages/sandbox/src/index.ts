// QuickJS 沙箱执行池（ADR 0001：同步 release 变体 + worker_threads + 宿主 Promise 桥）。
// 与 SDK 业务无关；路径/权限校验由宿主（SandboxHost）负责。

export {
  type RunOptions,
  type RunOutcome,
  type SandboxHost,
  SandboxPool,
  SdkCallError,
} from "./pool.ts";
