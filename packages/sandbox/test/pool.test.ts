// 终止/取消/并发/行号回归（08 §4 限制表与 §7 终止项的产品化验证）

import { describe, expect, test } from "vitest";
import { type RunOutcome, type SandboxHost, SandboxPool } from "../src/index.ts";

const NS = { files: ["readText", "writeText"], wb: ["read"] } as const;

const echoHost: SandboxHost = {
  async call(ns, method, args) {
    return { ns, method, args };
  },
};

const ok = (o: RunOutcome) => (o.kind === "ok" ? o.value : undefined);

describe("SandboxPool", () => {
  test("顶层 await 与 return；SDK 桥接 console.log", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const r = await pool.run(
        {
          code: `const r = await files.readText({ path: "a.txt" });\nconsole.log("hello", 42);\nreturn r.method + ":" + r.args.path;`,
          timeoutMs: 5000,
          namespaces: NS,
        },
        echoHost,
      );
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.value).toBe("readText:a.txt");
      expect(r.stdout).toBe("hello 42");
    } finally {
      await pool.close();
    }
  });

  test("行号：JS 第 N 行 throw 报 N；TS 同", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const js = await pool.run(
        {
          code: `const a = 1;\nconsole.log(a);\nthrow new Error("boom");`,
          timeoutMs: 5000,
          namespaces: {},
        },
        echoHost,
      );
      expect(js.kind).toBe("scriptError");
      if (js.kind === "scriptError") {
        expect(js.line).toBe(3);
        expect(js.message).toBe("boom");
      }
      const ts = await pool.run(
        {
          code: `interface X { a: number }\nconst a: X = { a: 1 };\nawait Promise.resolve();\nthrow new Error("ts-boom");`,
          timeoutMs: 5000,
          namespaces: {},
        },
        echoHost,
      );
      expect(ts.kind).toBe("scriptError");
      if (ts.kind === "scriptError") {
        expect(ts.line).toBe(4);
        expect(ts.message).toBe("ts-boom");
      }
    } finally {
      await pool.close();
    }
  });

  test("终止：死循环/深递归/大分配各自受限，之后池仍可用", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const t0 = performance.now();
      const loop = await pool.run(
        { code: "while (true) {}", timeoutMs: 800, namespaces: {} },
        echoHost,
      );
      const loopMs = performance.now() - t0;
      expect(loop.kind).toBe("terminated");
      if (loop.kind === "terminated") expect(loop.reason).toBe("timeout");
      expect(loopMs).toBeLessThan(800 + 500);

      const rec = await pool.run(
        {
          code: "function f(n){ return n<=0?0:f(n-1)+f(n-1) } f(1e6)",
          timeoutMs: 10_000,
          namespaces: {},
        },
        echoHost,
      );
      expect(["scriptError", "terminated"]).toContain(rec.kind);

      const alloc = await pool.run(
        {
          code: "const a=[]; while(true) a.push(new Array(1024*1024).fill(1))",
          timeoutMs: 15_000,
          namespaces: {},
        },
        echoHost,
      );
      expect(["terminated", "scriptError"]).toContain(alloc.kind);
      if (alloc.kind === "terminated") expect(["memory", "timeout"]).toContain(alloc.reason);

      // 三个终止/错误之后同一个池还能跑成功脚本（worker 已补位、宿主存活）
      const alive = await pool.run(
        { code: "return 1+1", timeoutMs: 1000, namespaces: {} },
        echoHost,
      );
      expect(ok(alive)).toBe(2);
    } finally {
      await pool.close();
    }
  }, 60_000);

  test("取消：signal abort → cancelled，运行中与排队任务都被清", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const ctrl = new AbortController();
      const p = pool.run(
        { code: "while (true) {}", timeoutMs: 30_000, namespaces: {}, signal: ctrl.signal },
        echoHost,
      );
      const queued = pool.run(
        { code: "return 1", timeoutMs: 30_000, namespaces: {}, signal: ctrl.signal },
        echoHost,
      );
      await new Promise((r) => setTimeout(r, 150));
      ctrl.abort();
      const running = await p;
      const queuedRes = await queued;
      expect(running.kind).toBe("terminated");
      if (running.kind === "terminated") expect(running.reason).toBe("cancelled");
      expect(queuedRes.kind).toBe("terminated");
      if (queuedRes.kind === "terminated") expect(queuedRes.reason).toBe("cancelled");
      const alive = await pool.run({ code: "return 7", timeoutMs: 2000, namespaces: {} }, echoHost);
      expect(ok(alive)).toBe(7);
    } finally {
      await pool.close();
    }
  }, 15_000);

  test("并发上限：池 size=2 时同时最多 2 个脚本在跑", async () => {
    const pool = new SandboxPool({ size: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const countingHost: SandboxHost = {
      async call() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 200));
        inFlight--;
        return null;
      },
    };
    try {
      const code = `await files.readText("x"); return 1`;
      const rs = await Promise.all([
        pool.run({ code, timeoutMs: 5000, namespaces: NS }, countingHost),
        pool.run({ code, timeoutMs: 5000, namespaces: NS }, countingHost),
        pool.run({ code, timeoutMs: 5000, namespaces: NS }, countingHost),
      ]);
      expect(rs.every((r) => r.kind === "ok")).toBe(true);
      expect(maxInFlight).toBe(2);
    } finally {
      await pool.close();
    }
  }, 15_000);

  test("stdout 只保留尾部 200 行；返回值 >1MB 终止为 output", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const many = await pool.run(
        {
          code: "for (let i=0;i<300;i++) console.log('line-'+i); return 0",
          timeoutMs: 5000,
          namespaces: {},
        },
        echoHost,
      );
      expect(many.kind).toBe("ok");
      const lines = many.stdout.split("\n");
      expect(lines.length).toBe(200);
      expect(lines[0]).toBe("line-100");
      expect(lines.at(-1)).toBe("line-299");

      const big = await pool.run(
        { code: "return 'x'.repeat(2*1024*1024)", timeoutMs: 10_000, namespaces: {} },
        echoHost,
      );
      expect(big.kind).toBe("terminated");
      if (big.kind === "terminated") expect(big.reason).toBe("output");
    } finally {
      await pool.close();
    }
  }, 30_000);

  test("单次 SDK 传输 >32MB 受限", async () => {
    const pool = new SandboxPool({ size: 1 });
    try {
      const r = await pool.run(
        {
          code: `try { await files.writeText({ path: "big.txt", content: "x".repeat(40*1024*1024) }); return "NO_ERROR" } catch (e) { return e.name + ":" + e.code }`,
          timeoutMs: 30_000,
          namespaces: NS,
        },
        echoHost,
      );
      // 参数在 VM 内被 stringify，超过 32MB 由桥直接拒绝为 SdkError
      expect(ok(r)).toBe("SdkError:LIMIT_EXCEEDED");
    } finally {
      await pool.close();
    }
  }, 30_000);
});
