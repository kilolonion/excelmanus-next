// T4 写集自检：对每次操作，比较 op 前后快照得到实际变更集，
// 校验 实际变更 ⊆ ∪deriveWriteSet(op 的全部 mutation)。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { changedCellsBetween, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate } from "./lib/stats.ts";
import { bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";
import { covers, deriveWriteSet, type WriteSet } from "./lib/writeset.ts";

const SEQ_COUNT = Number(process.env.T4_SEQS ?? 200);
const BASE_SEED = Number(process.env.T4_SEED ?? 91607007);
const MIN_OPS = 20;
const MAX_OPS = 50;

const union = (sets: WriteSet[]): WriteSet => ({
  regions: sets.flatMap((s) => s.regions),
  bookMeta: [...new Set(sets.flatMap((s) => s.bookMeta ?? []))],
  paramsOnly: sets.every((s) => s.paramsOnly),
  conservative: sets.find((s) => s.conservative)?.conservative,
  rule: "union",
});

async function main() {
  const t0 = Date.now();
  const ruleTable: Record<
    string,
    { count: number; paramsOnly: boolean; conservative?: string; rule: string }
  > = {};
  const violations: Array<{
    seq: number;
    seed: number;
    opIndex: number;
    opType: string;
    missingCells: string[];
    missingMeta: string[];
    mutationIds: string[];
  }> = [];
  let ops = 0;
  let opsChecked = 0;
  const perOpType: Record<string, { checked: number; violations: number }> = {};

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const boot = bootUniver();
    attachRecorder(boot);
    const { snapshot, sheets } = genSmallSnapshot(`wb-t4-${seq}`, createPrng(seed ^ 0x51ab));
    const book = createBook(boot, snapshot);
    const ctx: OpCtx = {
      boot,
      unitId: `wb-t4-${seq}`,
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
    const opCount = MIN_OPS + Math.floor(prng.next() * (MAX_OPS - MIN_OPS + 1));
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const before = normalizeSnapshot(book.save());
      const res = await pickOp(prng).run(ctx);
      ops += 1;
      const after = normalizeSnapshot(book.save());
      if (res.mutations.length === 0) continue; // 无 mutation 的命令无写集可推
      opsChecked += 1;
      const ws = union(res.mutations.map(deriveWriteSet));
      const changed = changedCellsBetween(before, after);
      const cov = covers(ws, changed);
      const st = getOrCreate(perOpType, res.opType, () => ({ checked: 0, violations: 0 }));
      st.checked += 1;
      if (!cov.ok) {
        st.violations += 1;
        violations.push({
          seq,
          seed,
          opIndex: i,
          opType: res.opType,
          missingCells: cov.missingCells.slice(0, 10),
          missingMeta: cov.missingMeta.slice(0, 10),
          mutationIds: res.mutationIds,
        });
      }
      for (const m of res.mutations as CapturedMutation[]) {
        const d = deriveWriteSet(m);
        const row = getOrCreate(ruleTable, m.id, () => ({
          count: 0,
          paramsOnly: d.paramsOnly,
          conservative: d.conservative,
          rule: d.rule,
        }));
        row.count += 1;
      }
    }
    mutationList.length = 0;
    await boot.dispose();
    if ((seq + 1) % 50 === 0)
      console.log(`t4 seq ${seq + 1}/${SEQ_COUNT} elapsed=${Date.now() - t0}ms`);
  }

  const result = {
    meta: {
      test: "T4-writeset",
      sequences: SEQ_COUNT,
      baseSeed: BASE_SEED,
      node: process.version,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    },
    summary: { ops, opsChecked, violations: violations.length },
    ruleTable,
    perOpType,
    violations: violations.slice(0, 40),
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t4-writeset.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary));
  if (violations.length)
    console.log(
      "first violations:",
      JSON.stringify(violations.slice(0, 5), null, 1).slice(0, 3000),
    );
  process.exit(0);
}

await main();
