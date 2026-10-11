// A2-2b：50,000 行 × (2 输入列 + 10 公式列) + 汇总公式的增量重算基准。
// 每个测量阶段在独立子进程中跑（PHASE env），编排模式不带 PHASE 时依次 spawn。
//   p1: 载入含公式快照 → 全量首次计算耗时 + 峰值 RSS（5 次）
//   p2: A25000 连改 20 次 → command→calc-done 耗时 + JS 参考实现校验 C..L/N1
//   p3: O1 改 5 次 → ~50 万公式全量依赖重算
//   p4: L1 改常量 5 次 → 只影响 N1 的汇总依赖成本
//   p5: 10,000 次单单元格写值（A 列随机行）→ 命令返回 vs 计算结束 两套延迟

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData, UniverInstanceType } from "@univerjs/core";
import { getSessionService, subscribeCalcDone } from "./lib/calc.ts";
import { createPrng } from "./lib/prng.ts";
import { statsOf } from "./lib/stats.ts";
import { bootUniver } from "./lib/univer-node.ts";

const ROWS = 50000;
const SEED = 20260929;
const UNIT = "wb-calc";

// ── 快照与参考实现 ──

function genSnapshot(seed: number): { snap: IWorkbookData; a: number[]; b: number[] } {
  const prng = createPrng(seed);
  const a: number[] = [];
  const b: number[] = [];
  const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
  for (let r = 0; r < ROWS; r++) {
    const av = Math.round(prng.next() * 2000 - 1000) / 10;
    const bv = Math.round(prng.next() * 2000 - 1000) / 10;
    a.push(av);
    b.push(bv);
    const row = r + 1;
    cellData[r] = {
      0: { v: av },
      1: { v: bv },
      2: { f: `=A${row}+B${row}+$O$1` },
      3: { f: `=C${row}*2` },
      4: { f: `=D${row}-A${row}` },
      5: { f: `=IF(E${row}>0,E${row},0)` },
      6: { f: `=ROUND(F${row}/3,2)` },
      7: { f: `=G${row}+B${row}` },
      8: { f: `=MAX(H${row},C${row})` },
      9: { f: `=I${row}-D${row}` },
      10: { f: `=IF(J${row}>0,"pos","neg")` },
      11: { f: `=LEN(K${row})+J${row}` },
    };
  }
  const row0 = cellData[0] ?? {};
  cellData[0] = row0;
  row0[13] = { f: `=SUM(L1:L${ROWS})` }; // N1
  row0[14] = { v: 0 }; // O1
  const snap = {
    id: UNIT,
    name: "bench",
    sheetOrder: ["calc"],
    appVersion: "0.0.0",
    styles: {},
    sheets: {
      calc: {
        id: "calc",
        name: "Calc",
        rowCount: ROWS + 10,
        columnCount: 16,
        cellData,
      },
    },
  } as unknown as IWorkbookData;
  return { snap, a, b };
}

// JS 参考实现：给定 a,b,o 算 C..L
function refRow(av: number, bv: number, o: number) {
  const c = av + bv + o;
  const d = c * 2;
  const e = d - av;
  const f = e > 0 ? e : 0;
  const g = Math.round((f / 3) * 100) / 100;
  const h = g + bv;
  const i = Math.max(h, c);
  const j = i - d;
  const k = j > 0 ? "pos" : "neg";
  const l = k.length + j;
  return { c, d, e, f, g, h, i, j, k, l };
}

function rss() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

function getCell(boot: ReturnType<typeof bootUniver>, r: number, c: number) {
  const unit = (boot.injector as { get(t: unknown): unknown }).get(IUniverInstanceService) as {
    getUnit(
      id: string,
      t: number,
    ): {
      getSheetBySheetId(sid: string): { getCell(r: number, c: number): Record<string, unknown> };
    };
  };
  const wb = unit.getUnit(UNIT, UniverInstanceType.UNIVER_SHEET);
  const ws = wb.getSheetBySheetId("calc");
  return ws.getCell(r, c);
}

const NO_IDLE = 2_000_000_000;

async function writeCell(
  boot: ReturnType<typeof bootUniver>,
  r: number,
  c: number,
  value: Record<string, unknown>,
) {
  const w = subscribeCalcDone(boot, 120000);
  const t0 = performance.now();
  const ok = await boot.commandService.executeCommand("sheet.command.set-range-values", {
    unitId: UNIT,
    subUnitId: "calc",
    range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
    value,
  });
  const cmdMs = performance.now() - t0;
  const wr = await w.promise;
  return { ok, cmdMs, calcMs: wr.ms, outcome: wr.outcome };
}

// ── 各阶段 ──

async function phase1() {
  const out: {
    ms: number;
    startDelayMs: number;
    rss: number;
    peak: number;
  }[] = [];
  for (let k = 0; k < 5; k++) {
    const boot = bootUniver();
    const { snap } = genSnapshot(SEED);
    // 载入计算是延迟调度的（不会同步启动）：关闭 idle 判定，等首个 session 完成
    const w = subscribeCalcDone(boot, 300000, NO_IDLE);
    const t0 = performance.now();
    const book = boot.univerAPI.createWorkbook(snap);
    // 轮询记录 session 实际开始时刻
    let startDelay = -1;
    const session = getSessionService(boot);
    const poll = setInterval(() => {
      if (startDelay < 0 && session.state.started) startDelay = performance.now() - t0;
    }, 50);
    const wr = await w.promise;
    clearInterval(poll);
    const ms = performance.now() - t0;
    out.push({ ms, startDelayMs: startDelay, rss: rss(), peak: rss() });
    void book;
    await boot.dispose();
    if (global.gc) global.gc();
    console.log(
      `p1 #${k}: total=${ms.toFixed(0)}ms startDelay=${startDelay.toFixed(0)}ms outcome=${wr.outcome} rss=${rss()}MB`,
    );
  }
  return out;
}

async function phase2() {
  const boot = bootUniver();
  const { snap, a, b } = genSnapshot(SEED);
  const w = subscribeCalcDone(boot, 300000, NO_IDLE);
  const book = boot.univerAPI.createWorkbook(snap);
  await w.promise;
  const prng = createPrng(SEED ^ 0x5eed);
  const samples: number[] = [];
  const cmdSamples: number[] = [];
  const failures: string[] = [];
  let n1Prev = sumL(a, b, 0);
  for (let k = 0; k < 20; k++) {
    const newA = Math.round(prng.next() * 4000 - 2000) / 10;
    a[24999] = newA;
    const r = await writeCell(boot, 24999, 0, { v: newA });
    samples.push(r.calcMs);
    cmdSamples.push(r.cmdMs);
    // 校验 C..L
    const exp = refRow(newA, b[24999] ?? 0, 0);
    const got = Array.from({ length: 10 }, (_, c) => getCell(boot, 24999, c + 2)?.v);
    const want = [exp.c, exp.d, exp.e, exp.f, exp.g, exp.h, exp.i, exp.j, exp.k, exp.l];
    const okRow = want.every((x, i) =>
      typeof x === "string" ? got[i] === x : Math.abs((got[i] as number) - x) < 1e-6,
    );
    if (!okRow) failures.push(`k${k} row: want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
    // N1 校验（O1=0 不变）
    const n1New = sumL(a, b, 0);
    const n1Got = getCell(boot, 0, 13)?.v as number;
    if (Math.abs(n1Got - n1New) > 1e-4)
      failures.push(`k${k} N1: want=${n1New} got=${n1Got} (prev=${n1Prev})`);
    n1Prev = n1New;
    void book;
  }
  await boot.dispose();
  return { calcMs: statsOf(samples), cmdMs: statsOf(cmdSamples), failures };
}

function sumL(a: number[], b: number[], o: number) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += refRow(a[i] ?? 0, b[i] ?? 0, o).l;
  return s;
}

async function phase3() {
  const boot = bootUniver();
  const { snap } = genSnapshot(SEED);
  const w = subscribeCalcDone(boot, 300000, NO_IDLE);
  boot.univerAPI.createWorkbook(snap);
  await w.promise;
  const samples: number[] = [];
  const cmdSamples: number[] = [];
  for (const o of [1, -1, 0.5, 100, -7.25]) {
    const r = await writeCell(boot, 0, 14, { v: o });
    samples.push(r.calcMs);
    cmdSamples.push(r.cmdMs);
    console.log(
      `p3 O1=${o}: cmd=${r.cmdMs.toFixed(1)}ms calc=${r.calcMs.toFixed(0)}ms ${r.outcome}`,
    );
  }
  await boot.dispose();
  return { calcMs: statsOf(samples), cmdMs: statsOf(cmdSamples) };
}

async function phase4() {
  const boot = bootUniver();
  const { snap } = genSnapshot(SEED);
  const w = subscribeCalcDone(boot, 300000, NO_IDLE);
  boot.univerAPI.createWorkbook(snap);
  await w.promise;
  const samples: number[] = [];
  const cmdSamples: number[] = [];
  for (const v of [42, 0, -3.5, 1000, 7]) {
    const r = await writeCell(boot, 0, 11, { v });
    samples.push(r.calcMs);
    cmdSamples.push(r.cmdMs);
    console.log(
      `p4 L1=${v}: cmd=${r.cmdMs.toFixed(1)}ms calc=${r.calcMs.toFixed(0)}ms ${r.outcome}`,
    );
  }
  await boot.dispose();
  return { calcMs: statsOf(samples), cmdMs: statsOf(cmdSamples) };
}

async function phase5() {
  const boot = bootUniver();
  const { snap } = genSnapshot(SEED);
  const w = subscribeCalcDone(boot, 300000, NO_IDLE);
  boot.univerAPI.createWorkbook(snap);
  await w.promise;
  const prng = createPrng(SEED ^ 0xbeef);
  const cmd: number[] = [];
  const calc: number[] = [];
  let timeouts = 0;
  let idle = 0;
  // 10k 次按 ~7s/次的实测单次重算成本需 ~20h 不可行；默认 60 次采样同分布，
  // 报告里以单次成本×10000 外推并明确标注（偏离说明）。
  const N = Number(process.env.A2_WRITES ?? 60);
  for (let i = 0; i < N; i++) {
    const r = Math.floor(prng.next() * ROWS);
    const v = Math.round(prng.next() * 2000 - 1000) / 10;
    const res = await writeCell(boot, r, 0, { v });
    cmd.push(res.cmdMs);
    calc.push(res.calcMs);
    if (res.outcome === "timeout") timeouts += 1;
    if (res.outcome === "idle") idle += 1;
    if ((i + 1) % 2000 === 0) console.log(`p5 ${i + 1}/${N} rss=${rss()}MB`);
  }
  await boot.dispose();
  return {
    n: N,
    cmdReturn: statsOf(cmd),
    calcComplete: statsOf(calc),
    timeouts,
    idleCount: idle,
    peakRssMB: rss(),
  };
}

async function runPhase(p: string) {
  switch (p) {
    case "p1":
      return { phase: "p1-full-calc", data: await phase1() };
    case "p2":
      return { phase: "p2-single-input", data: await phase2() };
    case "p3":
      return { phase: "p3-global-param", data: await phase3() };
    case "p4":
      return { phase: "p4-aggregate-only", data: await phase4() };
    case "p5":
      return { phase: "p5-10k-writes", data: await phase5() };
  }
  throw new Error(`unknown phase ${p}`);
}

const PHASE = process.env.A2_PHASE;
if (PHASE) {
  const out = await runPhase(PHASE);
  console.log(`RESULT:${JSON.stringify(out)}`);
  process.exit(0);
} else {
  const results: Record<string, unknown> = {};
  for (const p of ["p1", "p2", "p3", "p4", "p5"]) {
    const t0 = Date.now();
    const stdout = execFileSync(process.execPath, ["--expose-gc", "src/recalc-bench.ts"], {
      encoding: "utf8",
      env: { ...process.env, A2_PHASE: p },
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) {
      console.log(`phase ${p}: NO RESULT\n${stdout.slice(-2000)}`);
      continue;
    }
    const parsed = JSON.parse(line.slice(7)) as { phase: string; data: unknown };
    results[parsed.phase] = parsed.data;
    console.log(`phase ${p} done in ${Date.now() - t0}ms`);
  }
  const out = {
    meta: {
      test: "A2-2b-recalc",
      rows: ROWS,
      formulaCols: 10,
      formulasTotal: ROWS * 10 + 1,
      seed: SEED,
      node: process.version,
      ts: new Date().toISOString(),
    },
    ...results,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/recalc.json", JSON.stringify(out, null, 2));
  console.log("written results/recalc.json");
  process.exit(0);
}
