// 沙箱 worker：QuickJS 同步 release 变体（wasm）+ 宿主 Promise 桥。
// 每个脚本 = 新 runtime + 新 context（运行间完全隔离）。
// SDK 桥：沙箱内 __call() 先在 VM 里 JSON.stringify 参数（getter 在 VM 内执行、
// 受中断回调约束），__sdk_call_raw 返回一个宿主 deferred promise；宿主响应经
// postMessage 回来后 resolve，executePendingJobs 泵回脚本。

import { parentPort } from "node:worker_threads";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  RELEASE_SYNC,
} from "quickjs-emscripten";
import {
  MAX_IN_FLIGHT_SDK,
  MAX_RETURN_BYTES,
  MAX_SDK_BYTES,
  type MainToWorker,
  type Outcome,
  type RunDone,
  type RunRequest,
  STDOUT_MAX_BYTES,
  STDOUT_MAX_LINES,
} from "./protocol.ts";

const bridgeSource = `{
  const __raw = globalThis.__sdk_call_raw;
  const __log = globalThis.__console_log;
  delete globalThis.__sdk_call_raw;
  delete globalThis.__console_log;
  // 硬化：该 QuickJS 构建暴露了 SharedArrayBuffer（G05 要求其为 undefined），
  // 沙箱全局面不允许共享内存原语，删除之
  delete globalThis.SharedArrayBuffer;
  const __call = (ns, m, args) =>
    __raw(ns, m, JSON.stringify(args === undefined ? null : args)).then((r) => {
      const d = JSON.parse(r);
      if (d.ok) return d.value;
      const e = new Error(d.error.message);
      e.code = d.error.code;
      throw e;
    });
  const __fmt = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; }
    catch { return String(v); }
  };
  globalThis.files = {
    find: (q) => __call("files", "find", q ?? {}),
    manage: (p) => __call("files", "manage", p),
    readText: (p) => __call("files", "readText", { path: p }),
    writeText: (p, c) => __call("files", "writeText", { path: p, content: c }),
  };
  globalThis.wb = {
    read: (p) => __call("wb", "read", p),
    analyze: (p) => __call("wb", "analyze", p),
    edit: (p) => __call("wb", "edit", p),
    export: (p) => __call("wb", "export", p),
  };
  globalThis.console = { log: (...a) => { __log(a.map(__fmt).join(" ")); } };
}`;

// 在 VM 内 JSON.stringify 返回值（toJSON/Proxy 陷阱都在 VM 内执行、受中断约束），
// 宿主侧只接收字符串并做 1MB 上限判定
const serializeResultSource = `(() => {
  try {
    const s = JSON.stringify(globalThis.__sandbox_ret);
    return { s: s === undefined ? null : s };
  } catch (e) {
    return { e: String((e && e.message) || e) };
  }
})()`;

class StdoutRing {
  private lines: string[] = [];
  private bytes = 0;
  push(line: string): void {
    if (line.length > STDOUT_MAX_BYTES) line = line.slice(0, STDOUT_MAX_BYTES);
    this.lines.push(line);
    this.bytes += line.length + 1;
    while (this.lines.length > STDOUT_MAX_LINES || this.bytes > STDOUT_MAX_BYTES) {
      const dropped = this.lines.shift()!;
      this.bytes -= dropped.length + 1;
    }
  }
  text(): string {
    return this.lines.join("\n");
  }
}

interface ErrorDescription {
  name?: string;
  message?: string;
  stack?: string;
}

// 错误栈/消息返回前清除宿主路径痕迹（G12）：保留无目录分隔符的沙箱文件名
// （script.js / bridge.js），其余带路径分隔符的 token 一律替换
function sanitizeHostPaths(text: string): string {
  return text.replace(/\S*(?:\/|\\)\S*/g, (m) =>
    /^(?:script|bridge)\.js(?::\d+)?$/.test(m) ? m : "<host-path>",
  );
}

function describeError(ctx: QuickJSContext, h: QuickJSHandle | undefined): ErrorDescription {
  if (!h) return { name: "UnknownError", message: "<missing error handle>" };
  try {
    if (ctx.typeof(h) === "object") {
      const read = (key: string): string | undefined => {
        const p = ctx.getProp(h, key);
        try {
          const t = ctx.typeof(p);
          if (t === "string") return ctx.getString(p);
          if (t === "undefined") return undefined;
          const d = ctx.dump(p);
          return d === undefined ? undefined : String(d);
        } finally {
          p.dispose();
        }
      };
      return {
        name: read("name"),
        message: read("message"),
        stack: read("stack"),
      };
    }
    const d = ctx.dump(h);
    return { name: "ThrownValue", message: String(d) };
  } catch {
    return { name: "UnknownError", message: "<error description failed>" };
  }
}

function classifyError(d: ErrorDescription, pastDeadline: boolean): Outcome {
  const text = `${d.name ?? ""} ${d.message ?? ""}`;
  if (/out of memory|allocation failed|memory limit/i.test(text)) {
    return { kind: "terminated", reason: "memory", detail: text.slice(0, 200) };
  }
  if (pastDeadline || /interrupted/i.test(text)) {
    return { kind: "terminated", reason: "timeout" };
  }
  return {
    kind: "scriptError",
    name: d.name ?? "Error",
    message: d.message ?? "",
    stack: d.stack ? sanitizeHostPaths(d.stack) : undefined,
  };
}

interface PendingCall {
  deferred: QuickJSDeferredPromise;
  t0: number;
}

interface ActiveRun {
  req: RunRequest;
  ctx: QuickJSContext;
  rt: QuickJSRuntime;
  pending: Map<number, PendingCall>;
  stdout: StdoutRing;
  stats: { sdkCalls: number; sdkWaitMs: number };
  callSeq: number;
}

let active: ActiveRun | undefined;

const modPromise: Promise<QuickJSWASMModule> = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);

function onSdkResult(callId: number, envelopeJson: string): void {
  const a = active;
  if (!a) return;
  const p = a.pending.get(callId);
  if (!p) return;
  a.pending.delete(callId);
  a.stats.sdkWaitMs += performance.now() - p.t0;
  const s = a.ctx.newString(envelopeJson);
  p.deferred.resolve(s);
  s.dispose();
  p.deferred.dispose();
}

function errorEnvelope(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

async function runScript(mod: QuickJSWASMModule, req: RunRequest): Promise<RunDone> {
  const stdout = new StdoutRing();
  const rt = mod.newRuntime();
  const deadline = Date.now() + req.timeoutMs;
  const pending = new Map<number, PendingCall>();
  const ctx = rt.newContext();
  const stats = { sdkCalls: 0, sdkWaitMs: 0 };
  const a: ActiveRun = { req, ctx, rt, pending, stdout, stats, callSeq: 0 };
  active = a;

  let outcome: Outcome;
  try {
    rt.setMemoryLimit(req.memoryBytes);
    rt.setMaxStackSize(req.stackBytes);
    rt.setInterruptHandler(() => Date.now() > deadline);

    if (!req.bare) {
      const rawFn = ctx.newFunction("__sdk_call_raw", (nsH, mH, aH) => {
        const ns = ctx.getString(nsH);
        const method = ctx.getString(mH);
        const argsJson = ctx.getString(aH);
        stats.sdkCalls++;
        const d = ctx.newPromise();
        const rejectNow = (code: string, message: string) => {
          // 注意：QuickJSDeferredPromise.dispose() 会连 handle 一起释放，
          // 这里不能把 handle 释放后再返回——resolve() 已释放 resolvers，
          // promise handle 随 context teardown 回收即可
          const s = ctx.newString(errorEnvelope(code, message));
          d.resolve(s);
          s.dispose();
          return d.handle;
        };
        if (argsJson.length > MAX_SDK_BYTES) {
          return rejectNow("LIMIT_EXCEEDED", "SDK call args exceed 32MB");
        }
        if (pending.size >= MAX_IN_FLIGHT_SDK) {
          return rejectNow("LIMIT_EXCEEDED", "too many in-flight SDK calls (max 64)");
        }
        const callId = a.callSeq++;
        pending.set(callId, { deferred: d, t0: performance.now() });
        d.settled.then(() => {
          try {
            rt.executePendingJobs();
          } catch {
            // 泵失败由主循环兜住；这里只负责尽快唤醒队列
          }
        });
        parentPort!.postMessage({
          type: "sdkCall",
          runId: req.runId,
          callId,
          ns,
          method,
          argsJson,
        });
        return d.handle;
      });
      ctx.setProp(ctx.global, "__sdk_call_raw", rawFn);
      rawFn.dispose();

      const logFn = ctx.newFunction("__console_log", (sH) => {
        stdout.push(ctx.getString(sH));
      });
      ctx.setProp(ctx.global, "__console_log", logFn);
      logFn.dispose();

      const bridge = ctx.evalCode(bridgeSource, "bridge.js");
      if ("error" in bridge) {
        const d = describeError(ctx, bridge.error);
        outcome = {
          kind: "scriptError",
          name: "InternalBridgeError",
          message: d.message ?? "bridge setup failed",
        };
        bridge.dispose();
        return finish(outcome, a);
      }
      bridge.dispose();
    }

    const wrapped = `(async () => {\n${req.code}\n})()`;
    const evalRes = ctx.evalCode(wrapped, "script.js");
    try {
      if ("error" in evalRes) {
        const d = describeError(ctx, evalRes.error);
        outcome = classifyError(d, Date.now() > deadline);
      } else {
        const promiseHandle = evalRes.value;
        let pumpError: ErrorDescription | undefined;
        let settled: "fulfilled" | "rejected" | undefined;
        let resultHandle: QuickJSHandle | undefined;
        let errorHandle: QuickJSHandle | undefined;
        for (;;) {
          const jr = rt.executePendingJobs();
          if ("error" in jr) {
            pumpError = describeError(ctx, jr.error);
            jr.dispose();
            break;
          }
          jr.dispose();
          const st = ctx.getPromiseState(promiseHandle);
          if (st.type === "fulfilled") {
            settled = "fulfilled";
            resultHandle = st.value;
            break;
          }
          if (st.type === "rejected") {
            settled = "rejected";
            errorHandle = st.error;
            break;
          }
          if (Date.now() > deadline) {
            break;
          }
          await new Promise((r) => setImmediate(r));
        }
        if (settled === "fulfilled" && resultHandle) {
          ctx.setProp(ctx.global, "__sandbox_ret", resultHandle);
          resultHandle.dispose();
          const ser = ctx.evalCode(serializeResultSource, "script.js");
          try {
            if ("error" in ser) {
              const d = describeError(ctx, ser.error);
              outcome = classifyError(d, true);
            } else {
              const dumped = ctx.dump(ser.value) as { s?: string | null; e?: string };
              if (typeof dumped.e === "string") {
                outcome = { kind: "scriptError", name: "TypeError", message: dumped.e };
              } else if (typeof dumped.s === "string" && dumped.s.length > MAX_RETURN_BYTES) {
                outcome = {
                  kind: "terminated",
                  reason: "output",
                  detail: "return value exceeds 1MB",
                };
              } else {
                outcome = { kind: "ok", valueJson: dumped.s ?? "null" };
              }
            }
          } finally {
            ser.dispose();
          }
        } else if (settled === "rejected" && errorHandle) {
          const d = describeError(ctx, errorHandle);
          errorHandle.dispose();
          outcome = classifyError(d, Date.now() > deadline);
        } else if (pumpError) {
          outcome = classifyError(pumpError, Date.now() > deadline);
        } else {
          outcome = { kind: "terminated", reason: "timeout" };
        }
      }
    } finally {
      evalRes.dispose();
    }
  } catch (e) {
    outcome = {
      kind: "scriptError",
      name: "HostInternalError",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  return finish(outcome, a);
}

function finish(outcome: Outcome, a: ActiveRun): RunDone {
  const { ctx, rt, pending, stdout } = a;
  // 清结算：把未完成的 SDK 调用以 abort 错误结清，泵干 job 队列后释放 ctx/rt。
  // 若清理过程中 wasm assert 使 worker 崩溃，主线程按 worker 退出路径重启即可。
  for (const [, p] of pending) {
    try {
      const s = ctx.newString(errorEnvelope("INTERNAL", "run ended before response"));
      p.deferred.resolve(s);
      s.dispose();
      p.deferred.dispose();
    } catch {
      // 清理期失败不做处理
    }
  }
  pending.clear();
  try {
    rt.executePendingJobs();
  } catch {
    // 同上
  }
  try {
    ctx.dispose();
    rt.dispose();
  } catch {
    // 同上
  }
  active = undefined;
  return {
    type: "done",
    runId: a.req.runId,
    outcome,
    stdout: stdout.text(),
    stats: a.stats,
  };
}

async function main(): Promise<void> {
  const mod = await modPromise;
  parentPort!.on("message", (msg: MainToWorker) => {
    if (msg.type === "sdkResult") {
      onSdkResult(msg.callId, msg.envelopeJson);
      return;
    }
    if (msg.type === "run") {
      void runScript(mod, msg)
        .then((done) => parentPort!.postMessage(done))
        .catch((e) => {
          const done: RunDone = {
            type: "done",
            runId: msg.runId,
            outcome: {
              kind: "scriptError",
              name: "HostInternalError",
              message: e instanceof Error ? e.message : String(e),
            },
            stdout: "",
            stats: { sdkCalls: 0, sdkWaitMs: 0 },
          };
          parentPort!.postMessage(done);
        });
    }
  });
  parentPort!.postMessage({ type: "ready" });
}

void main();
