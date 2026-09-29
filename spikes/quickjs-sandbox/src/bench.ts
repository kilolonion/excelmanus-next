// M0-C 性能判据：loop100k / transfer50kRows / coldStart（有、无预热池）。
// 每项多次迭代，报告 p50 / p95 / min / max。结果写 results/bench.json。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "./sandbox.ts";
import { createSdkHost } from "./sdk-host.ts";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS_DIR = path.join(PKG_DIR, "results");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function statsOf(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    min: +s[0]!.toFixed(2),
    p50: +percentile(s, 50).toFixed(2),
    p95: +percentile(s, 95).toFixed(2),
    max: +s[s.length - 1]!.toFixed(2),
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qjs-bench-"));
const ws = path.join(tmpRoot, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "a.xlsx"), "fake");
fs.writeFileSync(path.join(ws, "rows50k.xlsx"), "fake");
const sdkHost = createSdkHost(ws);

const report: Record<string, unknown> = {
  platform: { os: os.platform(), arch: os.arch(), node: process.version },
};

// ---- loop100k ----
{
  const code = "let s = 0; for (let i = 0; i < 100000; i++) s += i % 7; return s";
  const sandbox = new Sandbox({ poolSize: 2 });
  await sandbox.warmup();
  const times: number[] = [];
  let want = 0;
  for (let i = 0; i < 100000; i++) want += i % 7;
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const r = await sandbox.runScript(code, { sdkHost, timeoutMs: 10_000 });
    times.push(performance.now() - t0);
    if (r.outcome.kind !== "ok" || r.outcome.valueJson !== String(want)) {
      console.error("loop100k wrong result", r.outcome);
    }
  }
  report.loop100k = { ...statsOf(times), criterionMs: 1000, pass: statsOf(times).p95 <= 1000 };
  await sandbox.dispose();
}

// ---- transfer50kRows：一次 SDK 调用把 5 万行 × 6 列送进 VM，脚本内求和 ----
{
  const code =
    "const r = await wb.read({ path: 'rows50k.xlsx', mode: 'full' }); let s = 0; for (const row of r.data.rows) s += row[3]; return s";
  const sandbox = new Sandbox({ poolSize: 2 });
  await sandbox.warmup();
  const times: number[] = [];
  const sdkWaits: number[] = [];
  let expected: number | undefined;
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const r = await sandbox.runScript(code, { sdkHost, timeoutMs: 10_000 });
    times.push(performance.now() - t0);
    sdkWaits.push(r.stats.sdkWaitMs);
    if (r.outcome.kind === "ok") expected = Number(r.outcome.valueJson);
    if (r.outcome.kind !== "ok") console.error("transfer run failed", r.outcome);
  }
  // 校验和：sum(i*7 % 997) for i in 0..49999
  let want = 0;
  for (let i = 0; i < 50000; i++) want += (i * 7) % 997;
  report.transfer50kRows = {
    ...statsOf(times),
    hostSdkWaitMs: statsOf(sdkWaits),
    criterionMs: 1000,
    pass: statsOf(times).p95 <= 1000,
    sumMatches: expected === want,
  };
  await sandbox.dispose();
}

// ---- coldStart：有预热池 vs 无预热池 ----
{
  // 有预热池：worker + wasm module 已就绪，一次运行只付 runtime+context+eval
  const sandbox = new Sandbox({ poolSize: 2 });
  await sandbox.warmup();
  const warm: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const r = await sandbox.runScript("return 1", { sdkHost, timeoutMs: 10_000 });
    warm.push(performance.now() - t0);
    if (r.outcome.kind !== "ok") console.error("coldStart warm failed", r.outcome);
  }
  await sandbox.dispose();
  // 无预热池：每次新建 Sandbox 且不 warmup → 首次 runScript 走完整冷路径
  //（创建 worker + 加载 wasm + 建 runtime/context + eval）
  const cold: number[] = [];
  for (let i = 0; i < 10; i++) {
    const s = new Sandbox({ poolSize: 1 });
    const t0 = performance.now();
    const r = await s.runScript("return 1", { sdkHost, timeoutMs: 10_000 });
    cold.push(performance.now() - t0);
    if (r.outcome.kind !== "ok") console.error("coldStart cold failed", r.outcome);
    await s.dispose();
  }
  report.coldStart = {
    criterionMs: 300,
    withPrewarmPool: statsOf(warm),
    withoutPrewarmPool: statsOf(cold),
    pass: statsOf(warm).p95 <= 300 && statsOf(cold).p95 <= 300,
  };
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(path.join(RESULTS_DIR, "bench.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
fs.rmSync(tmpRoot, { recursive: true, force: true });
