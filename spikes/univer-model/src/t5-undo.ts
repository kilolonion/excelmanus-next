// T5 逆操作：对每条命令从 UndoRedoService 取该 unitId 的 undoMutations，
// 序列结束后按操作倒序回放（JSON 往返），比较与序列前快照一致性；测捕获/回放代价。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, type OpResult, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate } from "./lib/stats.ts";
import { bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const SEQ_COUNT = Number(process.env.T5_SEQS ?? 200);
const BASE_SEED = Number(process.env.T5_SEED ?? 55110033);
const MIN_OPS = 20;
const MAX_OPS = 50;

interface UndoItem {
  unitID: string;
  undoMutations: CapturedMutation[];
  redoMutations: CapturedMutation[];
}
interface UndoServiceInternal {
  _undoStacks: Map<string, UndoItem[]>;
}

interface OpInverse {
  opIndex: number;
  opType: string;
  changedState: boolean; // 该 op 是否产生了 mutation（无 mutation 则无状态变化）
  inverse: CapturedMutation[]; // JSON 可序列化的逆 mutation
}

interface SeqOutcome {
  seq: number;
  seed: number;
  restored: boolean;
  diffCount: number;
  appliedInverse: number;
  failedInverse: number;
  suspects: Array<{ opIndex: number; opType: string }>;
  diffs?: unknown;
}

async function main() {
  const t0 = Date.now();
  const perOpType: Record<string, { total: number; withUndoItem: number; mutated: number }> = {};
  const seqResults: SeqOutcome[] = [];
  let captureMs = 0;
  let applyMs = 0;
  let inverseBytes = 0;
  let totalOps = 0;
  let totalWithUndo = 0;

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const boot = bootUniver();
    attachRecorder(boot);
    const unitId = `wb-t5-${seq}`;
    const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x77aa));
    const book = createBook(boot, snapshot);
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
    const snap0 = normalizeSnapshot(book.save());
    const opCount = MIN_OPS + Math.floor(prng.next() * (MAX_OPS - MIN_OPS + 1));
    const inverses: OpInverse[] = [];

    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const prevDepth =
        (boot.undoRedo as unknown as UndoServiceInternal)._undoStacks.get(unitId)?.length ?? 0;
      const res: OpResult = await pickOp(prng).run(ctx);
      totalOps += 1;
      const tc = performance.now();
      // 一条命令可能推入多个 undo item（本体 + 拦截器）：取新增的整段
      const stack = (boot.undoRedo as unknown as UndoServiceInternal)._undoStacks.get(unitId) ?? [];
      const newItems = stack.slice(prevDepth);
      const grew = newItems.length > 0;
      // 逆序回放同一次操作内推入的多个 item（后入先撤）
      const inverse = grew
        ? (JSON.parse(
            JSON.stringify([...newItems].reverse().flatMap((it) => it.undoMutations)),
          ) as CapturedMutation[])
        : [];
      captureMs += performance.now() - tc;
      inverseBytes += JSON.stringify(inverse).length;
      const st = getOrCreate(perOpType, res.opType, () => ({
        total: 0,
        withUndoItem: 0,
        mutated: 0,
      }));
      st.total += 1;
      if (res.mutations.length > 0) st.mutated += 1;
      if (inverse.length > 0) st.withUndoItem += 1;
      if (inverse.length > 0) totalWithUndo += 1;
      inverses.push({
        opIndex: i,
        opType: res.opType,
        changedState: res.mutations.length > 0,
        inverse,
      });
      mutationList.length = 0;
    }

    // 倒序回放逆操作（JSON 往返已在捕获时完成）
    const ta = performance.now();
    let appliedInverse = 0;
    let failedInverse = 0;
    for (let i = inverses.length - 1; i >= 0; i--) {
      for (const m of inverses[i]?.inverse ?? []) {
        let ok = false;
        try {
          ok = await boot.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)));
        } catch {
          ok = false;
        }
        if (ok) appliedInverse += 1;
        else failedInverse += 1;
      }
    }
    applyMs += performance.now() - ta;

    const diffs = deepDiff(snap0, normalizeSnapshot(book.save()), [], []);
    const suspects = inverses
      .filter((iv) => iv.changedState && iv.inverse.length === 0)
      .map((iv) => ({ opIndex: iv.opIndex, opType: iv.opType }));
    seqResults.push({
      seq,
      seed,
      restored: diffs.length === 0,
      diffCount: diffs.length,
      appliedInverse,
      failedInverse,
      suspects,
      diffs: diffs.length > 0 ? diffs.slice(0, 10) : undefined,
    });
    if (diffs.length > 0 && seqResults.filter((s) => !s.restored).length <= 10) {
      console.log(
        `seq ${seq} NOT restored (${diffs.length} diffs):`,
        JSON.stringify(diffs.slice(0, 4)),
      );
    }
    mutationList.length = 0;
    await boot.dispose();
    if ((seq + 1) % 50 === 0)
      console.log(`t5 seq ${seq + 1}/${SEQ_COUNT} elapsed=${Date.now() - t0}ms`);
  }

  const restored = seqResults.filter((s) => s.restored).length;
  const result = {
    meta: {
      test: "T5-undo",
      sequences: SEQ_COUNT,
      baseSeed: BASE_SEED,
      node: process.version,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    },
    summary: {
      sequencesRestored: restored,
      sequencesTotal: SEQ_COUNT,
      restoreRate: restored / SEQ_COUNT,
      totalOps,
      opsWithUndoItem: totalWithUndo,
      captureMsTotal: captureMs,
      applyMsTotal: applyMs,
      inverseBytesTotal: inverseBytes,
      failedInverseOps: seqResults.reduce((a, s) => a + s.failedInverse, 0),
    },
    perOpType,
    failures: seqResults.filter((s) => !s.restored).slice(0, 40),
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t5-undo.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 1));
  process.exit(0);
}

await main();
