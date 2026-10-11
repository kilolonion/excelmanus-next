// T5b 逐操作回滚：每个 op 执行后立即回放其 undoMutations，与 op 前快照比对。
// 用于定位"哪类操作的逆操作不完整"。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate } from "./lib/stats.ts";
import { bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const SEQ_COUNT = Number(process.env.T5B_SEQS ?? 30);
const BASE_SEED = Number(process.env.T5B_SEED ?? 31173);

interface UndoItem {
  undoMutations: CapturedMutation[];
}
interface UndoServiceInternal {
  _undoStacks: Map<string, UndoItem[]>;
}

async function main() {
  const t0 = Date.now();
  const perOp: Record<
    string,
    {
      total: number;
      mutated: number;
      hasInverse: number;
      restored: number;
      failed: number;
      examples: string[];
    }
  > = {};
  const invApplyFail: Record<string, number> = {};
  let cases = 0;

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const boot = bootUniver();
    attachRecorder(boot);
    const unitId = `wb-t5b-${seq}`;
    const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x33cc));
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
    const opCount = 25 + Math.floor(prng.next() * 26);
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const svc = boot.undoRedo as unknown as UndoServiceInternal;
      const prevDepth = svc._undoStacks.get(unitId)?.length ?? 0;
      const before = normalizeSnapshot(book.save());
      const res = await pickOp(prng).run(ctx);
      if (res.mutations.length === 0) {
        mutationList.length = 0;
        continue;
      }
      const stack = svc._undoStacks.get(unitId) ?? [];
      const newItems = stack.slice(prevDepth);
      const grew = newItems.length > 0;
      const inverse = grew
        ? (JSON.parse(
            JSON.stringify([...newItems].reverse().flatMap((it) => it.undoMutations)),
          ) as CapturedMutation[])
        : [];
      const st = getOrCreate(perOp, res.opType, () => ({
        total: 0,
        mutated: 0,
        hasInverse: 0,
        restored: 0,
        failed: 0,
        examples: [],
      }));
      st.total += 1;
      st.mutated += 1;
      if (inverse.length > 0) st.hasInverse += 1;
      cases += 1;
      let applyFail = false;
      for (const m of inverse) {
        try {
          const ok = await boot.commandService.executeCommand(
            m.id,
            JSON.parse(JSON.stringify(m.params)),
          );
          if (!ok) {
            applyFail = true;
            invApplyFail[`${res.opType}:${m.id}:false`] =
              (invApplyFail[`${res.opType}:${m.id}:false`] ?? 0) + 1;
          }
        } catch (e) {
          applyFail = true;
          const key = `${res.opType}:${m.id}:${(e as Error).message?.slice(0, 60)}`;
          invApplyFail[key] = (invApplyFail[key] ?? 0) + 1;
        }
      }
      mutationList.length = 0;
      const diffs = deepDiff(before, normalizeSnapshot(book.save()), [], []);
      if (diffs.length === 0) st.restored += 1;
      else {
        st.failed += 1;
        if (st.examples.length < 3) {
          st.examples.push(
            `seq${seq} op${i} inv=${inverse.length} applyFail=${applyFail} diffs=${JSON.stringify(diffs.slice(0, 3))}`,
          );
        }
      }
    }
    mutationList.length = 0;
    await boot.dispose();
    console.log(`t5b seq ${seq + 1}/${SEQ_COUNT} elapsed=${Date.now() - t0}ms`);
  }

  const result = {
    meta: { test: "T5b-perop", seqs: SEQ_COUNT, cases, elapsedMs: Date.now() - t0 },
    perOp,
    invApplyFail,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t5b-perop.json", JSON.stringify(result, null, 2));
  for (const [k, v] of Object.entries(perOp).sort()) {
    console.log(
      `${k.padEnd(22)} mutated=${v.mutated} inv=${v.hasInverse} restored=${v.restored}/${v.mutated}${v.failed ? " FAIL" : ""}`,
    );
  }
  console.log("applyFail keys:", invApplyFail);
  process.exit(0);
}

await main();
