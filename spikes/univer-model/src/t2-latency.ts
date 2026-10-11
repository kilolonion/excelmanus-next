// T2 提交延迟：50k×20 与 200k×30 两个文档；单格写值（命令路径 vs 直跑 mutation）
// + 插/删行（上中下三档）。每文档一个 worker。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { roundStats, statsOf } from "./lib/stats.ts";

interface T2Out {
  ok: boolean;
  loadMs?: number;
  memAfter?: { rss: number; heapUsed: number };
  writeCmd?: number[];
  writeMut?: number[];
  insertRow?: Record<string, number[]>;
  removeRow?: Record<string, number[]>;
  mutationsEmitted?: number;
  memEnd?: { rss: number; heapUsed: number };
  error?: string;
}

function runWorker(
  rows: number,
  cols: number,
  seed: number,
  writeN: number,
  rowOpN: number,
): Promise<T2Out> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./worker-harness.ts", import.meta.url), {
      workerData: { kind: "t2", rows, cols, seed, writeN, rowOpN },
      resourceLimits: { maxOldGenerationSizeMb: 6144, maxYoungGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      void w.terminate();
      resolve({ ok: false, error: "timeout 600s" });
    }, 600_000);
    w.once("message", (m: T2Out) => {
      clearTimeout(timer);
      resolve(m);
    });
    w.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message.slice(0, 300) });
    });
    w.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve({ ok: false, error: `worker exit code=${code}` });
    });
  });
}

async function main() {
  const writeN = Number(process.env.T2_WRITE_N ?? 10_000);
  const rowOpN = Number(process.env.T2_ROW_OP_N ?? 99); // 每档 33
  const specs = [
    { name: "b-50kx20", rows: 50_000, cols: 20 },
    { name: "a-200kx30", rows: 200_000, cols: 30 },
  ];
  const out: Record<string, unknown> = {
    meta: {
      test: "T2-latency",
      writeN,
      rowOpN,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      ts: new Date().toISOString(),
      note: "单位 ms；worker resourceLimits maxOldGenerationSizeMb=6144",
    },
    docs: {} as Record<string, unknown>,
  };

  for (const spec of specs) {
    const r = await runWorker(spec.rows, spec.cols, 2077, writeN, rowOpN);
    if (!r.ok) {
      (out.docs as Record<string, unknown>)[spec.name] = { ok: false, error: r.error };
      console.log(`${spec.name}: FAILED ${r.error}`);
      continue;
    }
    (out.docs as Record<string, unknown>)[spec.name] = {
      ok: true,
      loadMs: r.loadMs,
      memAfter: r.memAfter,
      memEnd: r.memEnd,
      mutationsEmitted: r.mutationsEmitted,
      writeCmdMs: roundStats(statsOf(r.writeCmd ?? [])),
      writeMutMs: roundStats(statsOf(r.writeMut ?? [])),
      insertRowMs: Object.fromEntries(
        Object.entries(r.insertRow ?? {}).map(([k, v]) => [k, roundStats(statsOf(v))]),
      ),
      removeRowMs: Object.fromEntries(
        Object.entries(r.removeRow ?? {}).map(([k, v]) => [k, roundStats(statsOf(v))]),
      ),
    };
    console.log(
      `${spec.name}: writeCmd p99=${(out.docs as Record<string, { writeCmdMs: { p99: number } }>)[spec.name]?.writeCmdMs.p99}ms`,
    );
  }

  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t2-latency.json", JSON.stringify(out, null, 2));
  console.log("done");
  process.exit(0);
}

await main();
