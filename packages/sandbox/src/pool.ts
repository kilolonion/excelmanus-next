// 宿主主线程侧：worker 预热池 + 排队 + 墙钟超时兜底（worker.terminate()）。
// worker 自身用 VM 中断回调 + 泵循环 deadline 处理绝大多数超时；
// 线程级 terminate 兜底 VM 忙在不可中断原生代码（如灾难性正则回溯）的场景。

import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_MEMORY_BYTES,
  DEFAULT_STACK_BYTES,
  MAX_SDK_BYTES,
  type MainToWorker,
  type RunDone,
  TERMINATE_GRACE_MS,
  type WireOutcome,
  type WorkerToMain,
} from "./wire.ts";

/** 宿主侧 SDK 实现：抛 SdkCallError 会在脚本里变成可捕获的 Error（name="SdkError"）。 */
export interface SandboxHost {
  call(ns: string, method: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

/** 宿主抛出的业务错误：code/message 原样进入脚本里的 SdkError。 */
export class SdkCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SdkCallError";
    this.code = code;
  }
}

export interface RunOptions {
  /** TS 或 JS 源码；内部用 node:module 的 stripTypeScriptTypes 去类型（保持行列位置） */
  code: string;
  timeoutMs: number;
  memoryBytes?: number;
  /** 注入的全局对象与方法名清单，如 { wb: ["read","edit"], files: [...] } */
  namespaces: Record<string, readonly string[]>;
  /** 取消 → 终止运行（worker 销毁 + 在途宿主调用 abort） */
  signal?: AbortSignal;
  /** 跳过 SDK 全局注入（测试用：枚举空上下文基线） */
  bare?: boolean;
}

export type RunOutcome =
  | { kind: "ok"; value: unknown; stdout: string; stats: { sdkCalls: number } }
  | {
      kind: "scriptError";
      name: string;
      message: string;
      /** 用户源码行号（去掉包装函数偏移） */
      line?: number;
      stack?: string;
      stdout: string;
    }
  | {
      kind: "terminated";
      reason: "timeout" | "memory" | "output" | "cancelled" | "crash";
      detail?: string;
      stdout: string;
    };

interface RunJob {
  code: string;
  opts: RunOptions;
  host: SandboxHost;
  resolve: (r: RunOutcome) => void;
  onAbort?: () => void;
}

interface RunState {
  runId: number;
  job: RunJob;
  timer: NodeJS.Timeout;
  /** abort 该脚本所有在途宿主操作 */
  abort: AbortController;
  /** 传给宿主调用的复合信号（运行中止 ∪ 用户取消） */
  callSignal: AbortSignal;
  done: boolean;
}

const cancelledOutcome = (detail?: string): RunOutcome => ({
  kind: "terminated",
  reason: "cancelled",
  ...(detail ? { detail } : {}),
  stdout: "",
});

class PoolWorker {
  worker: Worker;
  state: "starting" | "idle" | "busy" | "dead" = "starting";
  ready: Promise<void>;
  exitCode: number | undefined;
  lastError: Error | undefined;
  private markReady!: () => void;
  private onMessage: (w: PoolWorker, m: WorkerToMain) => void;
  private onDead: (w: PoolWorker) => void;

  constructor(
    onMessage: (w: PoolWorker, m: WorkerToMain) => void,
    onDead: (w: PoolWorker) => void,
  ) {
    this.onMessage = onMessage;
    this.onDead = onDead;
    this.ready = new Promise((r) => {
      this.markReady = r;
    });
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      // execArgv 清空：worker 只需要原生类型剥离 + node_modules 解析，
      // 不继承宿主进程（vitest 等）的 loader/execArgv
      execArgv: [],
      // 第二道防线：限制 worker 的 V8 堆（QuickJS wasm 内存在堆外由 setMemoryLimit 管）
      resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 },
    });
    this.worker.on("message", (m: WorkerToMain) => {
      if (m.type === "ready") {
        this.state = "idle";
        this.markReady();
        return;
      }
      this.onMessage(this, m);
    });
    this.worker.on("error", (e) => {
      this.lastError = e;
      this.die();
    });
    this.worker.on("exit", (code) => {
      this.exitCode = code;
      this.die();
    });
  }

  send(msg: MainToWorker): void {
    this.worker.postMessage(msg);
  }

  die(): void {
    if (this.state !== "dead") {
      this.state = "dead";
      this.onDead(this);
    }
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
    this.die();
  }
}

export class SandboxPool {
  private workers = new Set<PoolWorker>();
  private queue: RunJob[] = [];
  private runs = new Map<number, { worker: PoolWorker; state: RunState }>();
  private nextRunId = 1;
  private readonly size: number;
  private closed = false;

  constructor(opts: { size?: number } = {}) {
    this.size = opts.size ?? 2;
    this.ensureSpawn();
  }

  run(opts: RunOptions, host: SandboxHost): Promise<RunOutcome> {
    if (this.closed) return Promise.resolve(cancelledOutcome("sandbox closed"));
    // 去类型在宿主线程完成：语法错误在进 worker 前暴露，行列位置保持不变。
    // 先包 async IIFE 再剥离：让顶层 return/await 合法；包装占一行，
    // 栈行号 -1 即用户行号（worker 侧 extractLine 依赖此约定）
    let code: string;
    try {
      code = stripTypeScriptTypes(`(async () => {\n${opts.code}\n})()`, {
        mode: "strip",
      });
    } catch (e) {
      return Promise.resolve({
        kind: "scriptError",
        name: "SyntaxError",
        message: e instanceof Error ? e.message : String(e),
        stdout: "",
      });
    }
    if (opts.signal?.aborted) return Promise.resolve(cancelledOutcome());
    return new Promise((resolve) => {
      const job: RunJob = { code, opts, host, resolve };
      if (opts.signal) {
        const onAbort = () => {
          job.onAbort = undefined;
          const i = this.queue.indexOf(job);
          if (i >= 0) {
            this.queue.splice(i, 1);
            resolve(cancelledOutcome());
          }
          // 运行中的取消由 assign 里挂到 RunState 的监听器负责
        };
        job.onAbort = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(job);
      this.dispatch();
    });
  }

  private ensureSpawn(): void {
    if (this.closed) return;
    let alive = 0;
    for (const w of this.workers) if (w.state !== "dead") alive++;
    while (alive < this.size) {
      this.spawn();
      alive++;
    }
    for (const w of [...this.workers]) {
      if (w.state === "dead") this.workers.delete(w);
    }
  }

  private spawn(): void {
    const w = new PoolWorker(
      (pw, m) => this.onWorkerMessage(pw, m),
      (pw) => this.onWorkerDead(pw),
    );
    this.workers.add(w);
    void w.ready.then(() => this.dispatch());
  }

  private idleWorker(): PoolWorker | undefined {
    for (const w of this.workers) if (w.state === "idle") return w;
    return undefined;
  }

  private dispatch(): void {
    this.ensureSpawn();
    while (this.queue.length > 0) {
      const w = this.idleWorker();
      if (!w) return;
      const job = this.queue.shift()!;
      if (job.onAbort && job.opts.signal?.aborted) {
        // 入队到派发之间被取消
        job.opts.signal.removeEventListener("abort", job.onAbort);
        job.onAbort = undefined;
        job.resolve(cancelledOutcome());
        continue;
      }
      this.assign(w, job);
    }
  }

  private assign(w: PoolWorker, job: RunJob): void {
    const runId = this.nextRunId++;
    w.state = "busy";
    const abort = new AbortController();
    const signals = [abort.signal, ...(job.opts.signal ? [job.opts.signal] : [])];
    const state: RunState = {
      runId,
      job,
      abort,
      callSignal: AbortSignal.any(signals),
      done: false,
      timer: setTimeout(() => {
        void this.forceTerminate(w, runId, "timeout");
      }, job.opts.timeoutMs + TERMINATE_GRACE_MS),
    };
    this.runs.set(runId, { worker: w, state });
    // 运行中取消：abort 在途宿主调用 + 销毁 worker
    if (job.opts.signal) {
      job.opts.signal.removeEventListener("abort", job.onAbort!);
      job.opts.signal.addEventListener(
        "abort",
        () => {
          void this.forceTerminate(w, runId, "cancelled");
        },
        { once: true },
      );
    }
    job.onAbort = undefined;
    w.send({
      type: "run",
      runId,
      code: job.code,
      timeoutMs: job.opts.timeoutMs,
      memoryBytes: job.opts.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      stackBytes: DEFAULT_STACK_BYTES,
      namespaces: Object.fromEntries(
        Object.entries(job.opts.namespaces).map(([k, v]) => [k, [...v]]),
      ),
      bare: job.opts.bare,
    });
  }

  private async forceTerminate(
    w: PoolWorker,
    runId: number,
    reason: "timeout" | "cancelled",
  ): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec || rec.state.done) return;
    rec.state.abort.abort();
    rec.state.done = true;
    this.runs.delete(runId);
    rec.state.job.resolve({
      kind: "terminated",
      reason,
      stdout: "",
    });
    await w.terminate();
    this.ensureSpawn();
    this.dispatch();
  }

  private onWorkerMessage(w: PoolWorker, m: WorkerToMain): void {
    if (m.type === "sdkCall") {
      const rec = this.runs.get(m.runId);
      if (!rec) return;
      const { state } = rec;
      let args: unknown;
      try {
        args = JSON.parse(m.argsJson);
      } catch {
        args = null;
      }
      void rec.state.job.host
        .call(m.ns, m.method, args, state.callSignal)
        .then((value) => this.respond(w, state, m.callId, { ok: true, value }))
        .catch((e: unknown) => {
          const error =
            e instanceof SdkCallError
              ? { code: e.code, message: e.message }
              : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
          this.respond(w, state, m.callId, { ok: false, error });
        });
      return;
    }
    if (m.type === "done") {
      const rec = this.runs.get(m.runId);
      if (!rec || rec.state.done) return;
      rec.state.done = true;
      clearTimeout(rec.state.timer);
      // 该脚本在途的宿主操作不再有用，取消它们（worker 侧 run 已结束，响应无人认领）
      rec.state.abort.abort();
      this.runs.delete(m.runId);
      rec.state.job.resolve(this.toOutcome(m));
      // wasm 线性内存只涨不缩：memory/output 终止意味着该 worker 的堆已到峰值，
      // 回收整个 worker 释放内存，由 ensureSpawn 补位
      const recycle =
        m.outcome.kind === "terminated" &&
        (m.outcome.reason === "memory" || m.outcome.reason === "output");
      if (recycle) {
        void w.terminate();
      } else if (w.state === "busy") {
        w.state = "idle";
        this.dispatch();
      }
    }
  }

  private respond(
    w: PoolWorker,
    state: RunState,
    callId: number,
    envelope:
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string } },
  ): void {
    if (state.done || w.state !== "busy") return;
    let envelopeJson: string;
    try {
      envelopeJson = JSON.stringify(
        envelope.ok ? { ok: true, value: envelope.value ?? null } : envelope,
      );
    } catch {
      envelopeJson = JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message: "SDK response is not JSON-serializable" },
      });
    }
    if (envelopeJson.length > MAX_SDK_BYTES) {
      envelopeJson = JSON.stringify({
        ok: false,
        error: { code: "LIMIT_EXCEEDED", message: "SDK response exceeds 32MB" },
      });
    }
    w.send({ type: "sdkResult", callId, envelopeJson });
  }

  private toOutcome(m: RunDone): RunOutcome {
    const o: WireOutcome = m.outcome;
    if (o.kind === "ok") {
      let value: unknown = null;
      try {
        value = JSON.parse(o.valueJson);
      } catch {
        // VM 侧 JSON.stringify 的产物必然可解析；防御性兜底
      }
      return { kind: "ok", value, stdout: m.stdout, stats: m.stats };
    }
    if (o.kind === "scriptError") {
      return {
        kind: "scriptError",
        name: o.name,
        message: o.message,
        ...(o.line !== undefined ? { line: o.line } : {}),
        ...(o.stack !== undefined ? { stack: o.stack } : {}),
        stdout: m.stdout,
      };
    }
    return {
      kind: "terminated",
      reason: o.reason,
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
      stdout: m.stdout,
    };
  }

  private onWorkerDead(w: PoolWorker): void {
    for (const [runId, rec] of this.runs) {
      if (rec.worker === w && !rec.state.done) {
        rec.state.done = true;
        clearTimeout(rec.state.timer);
        rec.state.abort.abort();
        this.runs.delete(runId);
        const oom =
          (w.lastError as NodeJS.ErrnoException | undefined)?.code === "ERR_WORKER_OUT_OF_MEMORY";
        const errMsg = w.lastError ? `; error=${w.lastError.message}` : "";
        rec.state.job.resolve({
          kind: "terminated",
          reason: oom ? "memory" : "crash",
          detail: `worker crashed (exitCode=${w.exitCode ?? "?"}${errMsg})`,
          stdout: "",
        });
      }
    }
    this.workers.delete(w);
    this.ensureSpawn();
    this.dispatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const job of queued) {
      if (job.opts.signal && job.onAbort) {
        job.opts.signal.removeEventListener("abort", job.onAbort);
      }
      job.resolve(cancelledOutcome("sandbox closed"));
    }
    for (const rec of this.runs.values()) {
      clearTimeout(rec.state.timer);
      rec.state.abort.abort();
      if (!rec.state.done) {
        rec.state.done = true;
        rec.state.job.resolve(cancelledOutcome("sandbox closed"));
      }
    }
    this.runs.clear();
    await Promise.all([...this.workers].map((w) => w.terminate().catch(() => {})));
    this.workers.clear();
  }
}
