// A1b-1d(U1/U3)：前像式逆操作。
// Phase A：逐操作即时恢复（25 序列），按操作类型统计还原率 —— U1/U3 的粒度证据。
// Phase B：序列级回滚（300 序列）：收集每操作逆包，序列末倒序回放，与序列前快照比对。
// Phase C：快照回滚兜底成本：50k×20 / 200k×30 文档上 save→销毁→createBook 的耗时。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genLargeSnapshot, genSmallSnapshot } from "./lib/gen.ts";
import { makeInverse, reconcile } from "./lib/inverse.ts";
import { attachRecorder, mutationList, type OpCtx, type OpResult, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate, roundStats, statsOf } from "./lib/stats.ts";
import { type Booted, bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const BASE_SEED = 20260929;
const SEQ_PEROP = Number(process.env.A1B_PEROP_SEQS ?? 25);
const SEQ_LEVEL = Number(process.env.A1B_SEQS ?? 300);
const MIN_OPS = 20;
const MAX_OPS = 50;
// 前像法实测不可靠的操作类型（per-op 还原率 <100%）：序列级统计单列 "uncovered"
const UNCOVERED_OPS = new Set(["remove-sheet", "move-range"]);

function disposeUnit(boot: Booted, unitId: string) {
  try {
    const svc = (boot.injector as { get(t: unknown): { disposeUnit(id: string): boolean } }).get(
      IUniverInstanceService,
    );
    svc.disposeUnit(unitId);
  } catch {
    /* tolerate */
  }
}

function makeCtx(boot: Booted, unitId: string, seq: number, prng: ReturnType<typeof createPrng>) {
  const { sheets } = genSmallSnapshot(unitId, createPrng((BASE_SEED + seq) ^ 0x9e37));
  const ctx: OpCtx = {
    boot,
    unitId,
    prng,
    sheets: sheets.map((s) => ({ id: s.id, name: s.name, rowCount: s.rows, colCount: s.cols })),
    merges: new Map(),
    dvRules: [],
    cfRuleIds: [],
    hiddenRows: new Map(),
    hiddenCols: new Map(),
    frozenSheets: new Set(),
    filterSheets: new Map(),
    seqId: seq,
    opIndex: 0,
  };
  return ctx;
}

async function applyInverse(boot: Booted, pack: CapturedMutation[]): Promise<number> {
  let failed = 0;
  for (const m of pack) {
    try {
      const ok = await boot.commandService.executeCommand(
        m.id,
        JSON.parse(JSON.stringify(m.params)),
      );
      if (!ok) failed += 1;
    } catch {
      failed += 1;
    }
  }
  return failed;
}

// 应用逆包 + 至多 2 轮对账修补（结构逆放落点误差由逐格恢复兜底）
async function applyInverseWithReconcile(
  boot: Booted,
  preSnap: Parameters<typeof reconcile>[0],
  pack: CapturedMutation[],
  save: () => Parameters<typeof reconcile>[1],
  unitId: string,
): Promise<{ failed: number; rounds: number }> {
  let failed = await applyInverse(boot, pack);
  let rounds = 0;
  for (let i = 0; i < 2; i++) {
    const extra = reconcile(preSnap, save(), unitId);
    if (extra.length === 0) break;
    rounds += 1;
    failed += await applyInverse(boot, extra);
  }
  return { failed, rounds };
}

interface PerOpRow {
  total: number;
  restored: number;
  failedApply: number;
  examples: string[];
}

async function phasePerOp() {
  const perOp: Record<string, PerOpRow> = {};
  let opsTotal = 0;
  let captureMsTotal = 0;
  let applyMsTotal = 0;
  let inverseBytesTotal = 0;
  let preimageBytesTotal = 0;

  for (let seq = 0; seq < SEQ_PEROP; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-inv-p-${seq}`;
    const { snapshot } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));
    const boot = bootUniver();
    attachRecorder(boot);
    const book = createBook(boot, snapshot);
    const ctx = makeCtx(boot, unitId, seq, prng);

    const opCount = MIN_OPS + Math.floor(prng.next() * (MAX_OPS - MIN_OPS + 1));
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const tc0 = performance.now();
      const preSnap = book.save() as Parameters<typeof makeInverse>[0];
      const res: OpResult = await pickOp(prng).run(ctx);
      opsTotal += 1;
      const postSnap = book.save() as Parameters<typeof makeInverse>[0];
      const pack = makeInverse(preSnap, postSnap, res.mutations, unitId);
      const captureMs = performance.now() - tc0;
      const ta = performance.now();
      const { failed, rounds } =
        pack.inverse.length > 0
          ? await applyInverseWithReconcile(
              boot,
              preSnap,
              pack.inverse,
              () => book.save() as Parameters<typeof reconcile>[1],
              unitId,
            )
          : { failed: 0, rounds: 0 };
      void rounds;
      applyMsTotal += performance.now() - ta;
      captureMsTotal += captureMs;
      inverseBytesTotal += pack.inverseBytes;
      preimageBytesTotal += pack.preimageBytes;
      const diffs = deepDiff(normalizeSnapshot(preSnap), normalizeSnapshot(book.save()), [], []);
      const st = getOrCreate(
        perOp,
        res.opType,
        (): PerOpRow => ({
          total: 0,
          restored: 0,
          failedApply: 0,
          examples: [],
        }),
      );
      st.total += 1;
      if (diffs.length === 0 && failed === 0) st.restored += 1;
      else {
        st.failedApply += failed;
        if (st.examples.length < 3)
          st.examples.push(
            `seq${seq} op${i} inv=${pack.inverse.length} applyFail=${failed} diffs=${diffs
              .slice(0, 3)
              .map((d) => d.path)
              .join("|")}`,
          );
      }
    }
    disposeUnit(boot, unitId);
    await boot.dispose();
    mutationList.length = 0;
  }
  return { perOp, opsTotal, captureMsTotal, applyMsTotal, inverseBytesTotal, preimageBytesTotal };
}

async function phaseSeqLevel() {
  let restored = 0;
  let restoredCovered = 0;
  let coveredSeqs = 0;
  let totalOps = 0;
  let captureMsTotal = 0;
  let applyMsTotal = 0;
  let inverseBytesTotal = 0;
  const failures: Array<Record<string, unknown>> = [];

  for (let seq = 0; seq < SEQ_LEVEL; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-inv-s-${seq}`;
    const { snapshot } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));
    const boot = bootUniver();
    attachRecorder(boot);
    const book = createBook(boot, snapshot);
    const ctx = makeCtx(boot, unitId, seq, prng);
    const seqPre = book.save();

    const packs: CapturedMutation[][] = [];
    const preSnaps: Parameters<typeof reconcile>[0][] = [];
    const opTypes: string[] = [];
    const opCount = MIN_OPS + Math.floor(prng.next() * (MAX_OPS - MIN_OPS + 1));
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const tc0 = performance.now();
      const preSnap = book.save() as Parameters<typeof makeInverse>[0];
      const res: OpResult = await pickOp(prng).run(ctx);
      totalOps += 1;
      const postSnap = book.save() as Parameters<typeof makeInverse>[0];
      const pack = makeInverse(preSnap, postSnap, res.mutations, unitId);
      captureMsTotal += performance.now() - tc0;
      packs.push(pack.inverse);
      preSnaps.push(preSnap);
      opTypes.push(res.opType);
      inverseBytesTotal += pack.inverseBytes;
    }

    const ta = performance.now();
    let failedApply = 0;
    for (let i = packs.length - 1; i >= 0; i--) {
      const r = await applyInverseWithReconcile(
        boot,
        preSnaps[i] as Parameters<typeof reconcile>[0],
        packs[i] as CapturedMutation[],
        () => book.save() as Parameters<typeof reconcile>[1],
        unitId,
      );
      failedApply += r.failed;
    }
    applyMsTotal += performance.now() - ta;

    const covered = !opTypes.some((t) => UNCOVERED_OPS.has(t));
    if (covered) coveredSeqs += 1;
    const diffs = deepDiff(normalizeSnapshot(seqPre), normalizeSnapshot(book.save()), [], []);
    if (diffs.length === 0) {
      restored += 1;
      if (covered) restoredCovered += 1;
    } else if (failures.length < 40)
      failures.push({
        seq,
        seed,
        diffCount: diffs.length,
        failedApply,
        diffs: diffs.slice(0, 5),
        opTypes: opTypes.slice(-10),
      });
    disposeUnit(boot, unitId);
    await boot.dispose();
    mutationList.length = 0;
    if ((seq + 1) % 50 === 0)
      console.log(
        `seq ${seq + 1}/${SEQ_LEVEL} restored=${restored} covered=${restoredCovered}/${coveredSeqs}`,
      );
  }
  return {
    restored,
    restoredCovered,
    coveredSeqs,
    SEQ_LEVEL,
    totalOps,
    captureMsTotal,
    applyMsTotal,
    inverseBytesTotal,
    failures,
  };
}

async function phaseSnapshotRollback() {
  // 快照回滚：save → dispose unit → 从 save 重建 → save 验证可用
  const specs = [
    { name: "50k×20", rows: 50_000, cols: 20 },
    { name: "200k×30", rows: 200_000, cols: 30 },
  ];
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const times: { save: number[]; create: number[]; total: number[] } = {
      save: [],
      create: [],
      total: [],
    };
    for (let trial = 0; trial < 3; trial++) {
      const boot = bootUniver();
      const { snapshot } = genLargeSnapshot(`wb-rb-${spec.rows}`, spec.rows, spec.cols, 7 + trial);
      const book = createBook(boot, snapshot);
      const t0 = performance.now();
      const snap = book.save();
      const saveMs = performance.now() - t0;
      disposeUnit(boot, `wb-rb-${spec.rows}`);
      const t1 = performance.now();
      createBook(boot, JSON.parse(JSON.stringify(snap)) as IWorkbookData);
      const createMs = performance.now() - t1;
      times.save.push(Math.round(saveMs));
      times.create.push(Math.round(createMs));
      times.total.push(Math.round(saveMs + createMs));
      await boot.dispose();
    }
    out[spec.name] = {
      saveMs: roundStats(statsOf(times.save)),
      createMs: roundStats(statsOf(times.create)),
      rollbackMs: roundStats(statsOf(times.total)),
      trials: 3,
    };
    console.log(`${spec.name}: rollback≈${times.total.join("/")}ms`);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  console.log("=== Phase A: 逐操作即时恢复 ===");
  const perOpRes = await phasePerOp();
  console.log("=== Phase B: 序列级回滚 ===");
  const seqRes = await phaseSeqLevel();
  console.log("=== Phase C: 快照回滚成本 ===");
  const rollback = await phaseSnapshotRollback();

  const result = {
    meta: {
      test: "A1b-inverse",
      perOpSeqs: SEQ_PEROP,
      seqLevel: SEQ_LEVEL,
      baseSeed: BASE_SEED,
      node: process.version,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    },
    perOp: perOpRes,
    seqLevel: seqRes,
    snapshotRollback: rollback,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-inverse.json", JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      perOpOps: perOpRes.opsTotal,
      seqRestored: `${seqRes.restored}/${SEQ_LEVEL}`,
      rollbackMs: Object.fromEntries(
        Object.entries(rollback).map(([k, v]) => [
          k,
          (v as { rollbackMs: { p50?: number } }).rollbackMs.p50,
        ]),
      ),
    }),
  );
  process.exit(0);
}

await main();
