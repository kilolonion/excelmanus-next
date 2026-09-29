// T1 载入：每个规格 × 5 次全新 worker；RSS≤1.5GB 下的最大单元格数用二分行数逼近。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { roundStats, statsOf } from "./lib/stats.ts";

const TRIALS = Number(process.env.T1_TRIALS ?? 5);
const RSS_LIMIT_MB = 1500;

interface T1Out {
  ok: boolean;
  genMs?: number;
  createMs?: number;
  saveMs?: number;
  loadMs?: number;
  memBefore?: { rss: number; heapUsed: number };
  memAfter?: { rss: number; heapUsed: number };
  error?: string;
}

function runWorker(rows: number, cols: number, seed: number): Promise<T1Out> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./worker-harness.ts", import.meta.url), {
      workerData: { kind: "t1", rows, cols, seed },
      resourceLimits: { maxOldGenerationSizeMb: 6144, maxYoungGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      void w.terminate();
      resolve({ ok: false, error: "timeout 300s" });
    }, 300_000);
    w.once("message", (m: T1Out) => {
      clearTimeout(timer);
      resolve(m);
    });
    w.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message.slice(0, 300) });
    });
    w.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve({ ok: false, error: `worker exit code=${code} (可能 OOM)` });
    });
  });
}

async function trial(rows: number, cols: number, seed: number) {
  const t0 = Date.now();
  const r = await runWorker(rows, cols, seed);
  return { ...r, wallMs: Date.now() - t0 };
}

// 二分子进程版：worker_threads 共享进程 RSS，用真实子进程才能得到该文档自己的 RSS。
import { execFile } from "node:child_process";

function runChild(rows: number, cols: number, seed: number): Promise<T1Out> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--expose-gc", "src/worker-harness.ts", JSON.stringify({ kind: "t1", rows, cols, seed })],
      { cwd: process.cwd(), timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const line = stdout.trim().split("\n").at(-1) ?? "";
        try {
          resolve(JSON.parse(line) as T1Out);
        } catch {
          resolve({
            ok: false,
            error: `child: ${err?.message ?? "no-json"} ${line.slice(0, 200)}`,
          });
        }
      },
    );
    void child;
  });
}

async function main() {
  const specs = [
    { name: "a", rows: 200_000, cols: 30 },
    { name: "b", rows: 50_000, cols: 20 },
  ];
  const results: Record<string, unknown> = {
    meta: {
      test: "T1-load",
      trials: TRIALS,
      rssLimitMB: RSS_LIMIT_MB,
      workerLimits: { maxOldGenerationSizeMb: 6144, maxYoungGenerationSizeMb: 512 },
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      ts: new Date().toISOString(),
    },
    specs: {} as Record<string, unknown>,
    maxCells: {} as Record<string, unknown>,
  };

  for (const spec of specs) {
    const runs: T1Out[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = await trial(spec.rows, spec.cols, 1000 + i);
      runs.push(r);
      console.log(
        `${spec.name} trial${i}: ok=${r.ok} loadMs=${r.loadMs} rssAfter=${r.memAfter?.rss}MB heap=${r.memAfter?.heapUsed}MB ${r.error ?? ""}`,
      );
    }
    const okRuns = runs.filter((r) => r.ok);
    (results.specs as Record<string, unknown>)[spec.name] = {
      rows: spec.rows,
      cols: spec.cols,
      cells: spec.rows * spec.cols,
      loadMs: roundStats(
        statsOf(okRuns.map((r) => r.loadMs ?? NaN).filter((n) => Number.isFinite(n))),
      ),
      createMs: roundStats(
        statsOf(okRuns.map((r) => r.createMs ?? NaN).filter((n) => Number.isFinite(n))),
      ),
      saveMs: roundStats(
        statsOf(okRuns.map((r) => r.saveMs ?? NaN).filter((n) => Number.isFinite(n))),
      ),
      rssAfterMB: roundStats(
        statsOf(okRuns.map((r) => r.memAfter?.rss ?? NaN).filter((n) => Number.isFinite(n))),
      ),
      heapAfterMB: roundStats(
        statsOf(okRuns.map((r) => r.memAfter?.heapUsed ?? NaN).filter((n) => Number.isFinite(n))),
      ),
      okCount: okRuns.length,
      errors: runs.filter((r) => !r.ok).map((r) => r.error),
      runs,
    };
  }

  // (c) 二分：cols=30，RSS≤1.5GB 且载入成功的最大行数
  let lo = 50_000;
  let hi = 2_000_000;
  const curve: Array<{
    rows: number;
    cells: number;
    ok: boolean;
    loadMs?: number;
    rss?: number;
    heap?: number;
    error?: string;
  }> = [];
  while (hi - lo > 20_000) {
    const mid = Math.floor((lo + hi) / 2 / 10_000) * 10_000;
    const r = await runChild(mid, 30, 4242);
    const rss = r.memAfter?.rss ?? 1e9;
    const ok = Boolean(r.ok) && rss <= RSS_LIMIT_MB;
    curve.push({
      rows: mid,
      cells: mid * 30,
      ok,
      loadMs: r.loadMs,
      rss: r.memAfter?.rss,
      heap: r.memAfter?.heapUsed,
      error: r.error,
    });
    console.log(
      `bisect rows=${mid} ok=${ok} loadMs=${r.loadMs} rss=${r.memAfter?.rss}MB ${r.error ?? ""}`,
    );
    if (ok) lo = mid;
    else hi = mid;
  }
  results.maxCells = {
    cols: 30,
    maxRowsOk: lo,
    maxCells: lo * 30,
    rssLimitMB: RSS_LIMIT_MB,
    curve,
  };

  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t1-load.json", JSON.stringify(results, null, 2));
  console.log("done");
  process.exit(0);
}

await main();
