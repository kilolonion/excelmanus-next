// 宿主主线程侧：worker 预热池 + 排队 + 墙钟超时兜底（worker.terminate()）。
// worker 自身用 VM 中断回调 + 泵循环 deadline 处理绝大多数超时；
// 线程级 terminate 兜底 VM 忙在不可中断原生代码（如灾难性正则回溯）的场景。

import { Worker } from "node:worker_threads";
import {
  DEFAULT_MEMORY_BYTES,
  DEFAULT_STACK_BYTES,
  DEFAULT_TIMEOUT_MS,
  type MainToWorker,
  type Outcome,
  type RunDone,
  type WorkerToMain,
} from "./protocol.ts";
import type { EvidenceLog, SdkHost } from "./sdk-host.ts";

export interface RunOptions {
  timeoutMs?: number;
  /** 每次运行独立的宿主 SDK 宿主（绑定各自的工作区） */
  sdkHost: SdkHost;
  /** 在途宿主操作被取消的证据记录（T01 用） */
  evidence?: EvidenceLog;
  /** 跳过 SDK 注入（用于枚举空 QuickJS 上下文基线） */
  bare?: boolean;
}

export interface RunOutcome {
  outcome: Outcome;
  stdout: string;
  stats: { sdkCalls: number; sdkWaitMs: number };
  /** 从发起 runScript 到拿到结果（含 terminate 的墙钟） */
  durationMs: number;
  /** worker 自报 / 宿主 terminate / worker 崩溃 */
  via: "worker" | "terminate" | "crash";
}

export interface SandboxOptions {
  /** 预热池大小（同时也是最大并发脚本数；其余排队） */
  poolSize?: number;
  memoryBytes?: number;
  stackBytes?: number;
  /** worker 自报超时之外的兜底宽限（须落在判据 +500ms 内） */
  terminateGraceMs?: number;
}

interface RunJob {
  code: string;
  opts: RunOptions;
  resolve: (r: RunOutcome) => void;
}

interface RunState {
  runId: number;
  job: RunJob;
  startedAt: number;
  timer: NodeJS.Timeout;
  abort: AbortController;
  inFlight: Set<number>;
  done: boolean;
}

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

export class Sandbox {
  private workers = new Set<PoolWorker>();
  private queue: RunJob[] = [];
  private runs = new Map<number, { worker: PoolWorker; state: RunState }>();
  private nextRunId = 1;
  private poolSize: number;
  private memoryBytes: number;
  private stackBytes: number;
  private terminateGraceMs: number;
  private disposed = false;

  constructor(opts: SandboxOptions = {}) {
    this.poolSize = opts.poolSize ?? 2;
    this.memoryBytes = opts.memoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.stackBytes = opts.stackBytes ?? DEFAULT_STACK_BYTES;
    this.terminateGraceMs = opts.terminateGraceMs ?? 250;
  }

  get activeWorkerCount(): number {
    let n = 0;
    for (const w of this.workers) if (w.state !== "dead") n++;
    return n;
  }

  async warmup(): Promise<void> {
    this.ensureSpawn();
    await Promise.all([...this.workers].map((w) => w.ready));
  }

  runScript(code: string, opts: RunOptions): Promise<RunOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ code, opts, resolve });
      this.dispatch();
    });
  }

  private ensureSpawn(): void {
    if (this.disposed) return;
    let alive = 0;
    for (const w of this.workers) if (w.state !== "dead") alive++;
    // 池子补到 poolSize；有排队时也不过量（maxConcurrent == poolSize）
    while (alive < this.poolSize) {
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
      this.assign(w, job);
    }
  }

  private assign(w: PoolWorker, job: RunJob): void {
    const runId = this.nextRunId++;
    const timeoutMs = job.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    w.state = "busy";
    const abort = new AbortController();
    const state: RunState = {
      runId,
      job,
      startedAt: performance.now(),
      abort,
      inFlight: new Set(),
      done: false,
      timer: setTimeout(() => {
        void this.forceTerminate(w, runId);
      }, timeoutMs + this.terminateGraceMs),
    };
    this.runs.set(runId, { worker: w, state });
    w.send({
      type: "run",
      runId,
      code: job.code,
      timeoutMs,
      memoryBytes: this.memoryBytes,
      stackBytes: this.stackBytes,
      bare: job.opts.bare,
    });
  }

  private async forceTerminate(w: PoolWorker, runId: number): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec || rec.state.done) return;
    // 先 abort 该脚本所有在途宿主操作（T01 证据点），再 terminate
    rec.state.abort.abort();
    const durationMs = performance.now() - rec.state.startedAt;
    rec.state.done = true;
    this.runs.delete(runId);
    rec.state.job.resolve({
      outcome: { kind: "terminated", reason: "timeout" },
      stdout: "",
      stats: { sdkCalls: 0, sdkWaitMs: 0 },
      durationMs,
      via: "terminate",
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
      state.inFlight.add(m.callId);
      const evidence = rec.state.job.opts.evidence;
      void rec.state.job.opts.sdkHost
        .handle(m.ns, m.method, m.argsJson, {
          signal: state.abort.signal,
          evidence: evidence ?? [],
          runId: m.runId,
        })
        .then((envelopeJson: string) => {
          state.inFlight.delete(m.callId);
          if (!state.done && w.state === "busy") {
            w.send({ type: "sdkResult", callId: m.callId, envelopeJson });
          }
        })
        .catch((e: unknown) => {
          state.inFlight.delete(m.callId);
          if (!state.done && w.state === "busy") {
            w.send({
              type: "sdkResult",
              callId: m.callId,
              envelopeJson: JSON.stringify({
                ok: false,
                error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) },
              }),
            });
          }
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
      rec.state.job.resolve({
        outcome: m.outcome,
        stdout: m.stdout,
        stats: m.stats,
        durationMs: performance.now() - rec.state.startedAt,
        via: "worker",
      });
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

  private onWorkerDead(w: PoolWorker): void {
    // worker 崩溃（wasm abort / V8 OOM）：找到它身上的 run 并按崩溃收尾
    for (const [runId, rec] of this.runs) {
      if (rec.worker === w && !rec.state.done) {
        rec.state.done = true;
        clearTimeout(rec.state.timer);
        rec.state.abort.abort();
        this.runs.delete(runId);
        // 只有证据显示 OOM 才记 memory；其余崩溃如实写进 detail，
        // reason 只能取判据词表内的类别，用 timeout 兜底
        const oom =
          (w.lastError as NodeJS.ErrnoException | undefined)?.code === "ERR_WORKER_OUT_OF_MEMORY";
        const errMsg = w.lastError ? `; error=${w.lastError.message}` : "";
        rec.state.job.resolve({
          outcome: {
            kind: "terminated",
            reason: oom ? "memory" : "timeout",
            detail: `worker crashed (exitCode=${w.exitCode ?? "?"}${errMsg})`,
          },
          stdout: "",
          stats: { sdkCalls: 0, sdkWaitMs: 0 },
          durationMs: performance.now() - rec.state.startedAt,
          via: "crash",
        });
      }
    }
    this.workers.delete(w);
    this.ensureSpawn();
    this.dispatch();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const job of queued) {
      job.resolve({
        outcome: { kind: "terminated", reason: "timeout", detail: "sandbox disposed" },
        stdout: "",
        stats: { sdkCalls: 0, sdkWaitMs: 0 },
        durationMs: 0,
        via: "terminate",
      });
    }
    for (const rec of this.runs.values()) {
      clearTimeout(rec.state.timer);
      rec.state.abort.abort();
    }
    this.runs.clear();
    await Promise.all([...this.workers].map((w) => w.terminate().catch(() => {})));
    this.workers.clear();
  }
}
