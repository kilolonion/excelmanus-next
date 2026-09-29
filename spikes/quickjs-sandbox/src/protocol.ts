// worker_threads 消息协议与共享常量。

export type TerminationReason = "timeout" | "memory" | "output";

export type Outcome =
  | { kind: "ok"; valueJson: string }
  | { kind: "scriptError"; name: string; message: string; stack?: string }
  | { kind: "terminated"; reason: TerminationReason; detail?: string };

export interface RunRequest {
  type: "run";
  runId: number;
  code: string;
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  /** true 时不注入 SDK 全局（用于枚举空上下文基线） */
  bare?: boolean;
}

export interface RunDone {
  type: "done";
  runId: number;
  outcome: Outcome;
  stdout: string;
  stats: { sdkCalls: number; sdkWaitMs: number };
}

export interface SdkCallMsg {
  type: "sdkCall";
  runId: number;
  callId: number;
  ns: string;
  method: string;
  argsJson: string;
}

export interface SdkResultMsg {
  type: "sdkResult";
  callId: number;
  envelopeJson: string;
}

export interface ReadyMsg {
  type: "ready";
}

export type WorkerToMain = ReadyMsg | SdkCallMsg | RunDone;
export type MainToWorker = RunRequest | SdkResultMsg;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
// 注意：wasm 构建的实际栈小于此值时 setMaxStackSize 会立即误判溢出，
// 实测 RELEASE_SYNC 的 wasm 栈可容纳 1MB 上限（8MB 必炸）。
export const DEFAULT_STACK_BYTES = 1 * 1024 * 1024;
export const MAX_RETURN_BYTES = 1 * 1024 * 1024;
export const MAX_SDK_BYTES = 32 * 1024 * 1024;
export const MAX_IN_FLIGHT_SDK = 64;
export const STDOUT_MAX_LINES = 200;
export const STDOUT_MAX_BYTES = 64 * 1024;
