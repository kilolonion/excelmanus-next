// A1b-1c：T3 重跑（同 1000 种子），复现链路加入传输层修补：
//   R-styles-subset —— insert-sheet 补 styles 子集（lib/transport.ts）
//   R-filter-reconcile —— 每操作后对账 SHEET_FILTER_PLUGIN 资源，漂移则补发 set-filter-range
// 每步在 B 上跑悬空样式引用检测（通用，覆盖全部 mutation id）。
// 比较器与归一化规则与 T3 完全一致（不新增）。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, type OpResult, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate } from "./lib/stats.ts";
import {
  findDanglingStyleRefs,
  fixupMutationForTransport,
  reconcileFilterResource,
} from "./lib/transport.ts";
import { type Booted, bootUniver, createBook } from "./lib/univer-node.ts";

const SEQ_COUNT = Number(process.env.T3_SEQS ?? 1000);
const BASE_SEED = Number(process.env.T3_SEED ?? 20260929);
const MIN_OPS = 20;
const MAX_OPS = 50;

function disposeUnit(boot: Booted, unitId: string): void {
  try {
    const svc = (boot.injector as { get(t: unknown): { disposeUnit(id: string): boolean } }).get(
      IUniverInstanceService,
    );
    svc.disposeUnit(unitId);
  } catch {
    /* spike 容忍 */
  }
}

async function main() {
  const opStats: Record<
    string,
    {
      executed: number;
      ok: number;
      failed: number;
      causedDiff: number;
      danglingAttributed: number;
    }
  > = {};
  const mismatches: Array<Record<string, unknown>> = [];
  const danglingByMutation: Record<string, number> = {};
  const fixupStats = { insertSheetFixed: 0, stylesBytes: 0, filterReconcile: 0, reconcileOps: 0 };
  let sequencesOk = 0;
  let replayedMutations = 0;
  let replayFailures = 0;
  let totalOps = 0;
  const t0 = Date.now();

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-t3f-${seq}`;
    const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));
    const snapshotB = JSON.parse(JSON.stringify(snapshot)) as IWorkbookData;

    const bootA = bootUniver();
    attachRecorder(bootA);
    const bootB = bootUniver();
    const bookA = createBook(bootA, snapshot);
    const bookB = createBook(bootB, snapshotB);

    const ctx: OpCtx = {
      boot: bootA,
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

    const opCount = MIN_OPS + Math.floor(prng.next() * (MAX_OPS - MIN_OPS + 1));
    let seqDiffed = false;
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const op = pickOp(prng);
      const res: OpResult = await op.run(ctx);
      totalOps += 1;
      const st = getOrCreate(opStats, res.opType, () => ({
        executed: 0,
        ok: 0,
        failed: 0,
        causedDiff: 0,
        danglingAttributed: 0,
      }));
      st.executed += 1;
      if (res.ok) st.ok += 1;
      else st.failed += 1;

      // 复现：逐条 fixup + fromCollab
      const senderSnap = bookA.save() as Parameters<typeof fixupMutationForTransport>[1];
      for (const m of res.mutations) {
        const fixed = fixupMutationForTransport(m, senderSnap, "styles-subset");
        if (fixed.fixups.length > 0) {
          fixupStats.insertSheetFixed += 1;
          fixupStats.stylesBytes += fixed.addedBytes;
        }
        const ok = await bootB.commandService.executeCommand(
          fixed.mutation.id,
          JSON.parse(JSON.stringify(fixed.mutation.params)),
          { fromCollab: true },
        );
        replayedMutations += 1;
        if (!ok) replayFailures += 1;
        // 悬空样式引用检测（归因到当前 mutation id）
        const dangling = findDanglingStyleRefs(
          bookB.save() as Parameters<typeof findDanglingStyleRefs>[0],
        );
        if (dangling.length > 0) {
          danglingByMutation[m.id] = (danglingByMutation[m.id] ?? 0) + dangling.length;
          st.danglingAttributed += 1;
        }
      }
      // R-filter-reconcile：对账 filter 资源，漂移则补发
      const reconcile = reconcileFilterResource(
        bookA.save() as Parameters<typeof reconcileFilterResource>[0],
        bookB.save() as Parameters<typeof reconcileFilterResource>[0],
        unitId,
      );
      fixupStats.reconcileOps += reconcile.length > 0 ? 1 : 0;
      for (const m of reconcile) {
        fixupStats.filterReconcile += 1;
        await bootB.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
          fromCollab: true,
        });
      }

      const diffs = deepDiff(
        normalizeSnapshot(bookA.save()),
        normalizeSnapshot(bookB.save()),
        [],
        [],
      );
      if (diffs.length > 0) {
        mismatches.push({
          seqIndex: seq,
          seed,
          opIndex: i,
          opType: res.opType,
          commandId: res.commandId,
          diffs: diffs.slice(0, 20),
        });
        st.causedDiff += 1;
        seqDiffed = true;
        break;
      }
    }
    if (!seqDiffed) sequencesOk += 1;

    disposeUnit(bootA, unitId);
    disposeUnit(bootB, unitId);
    await bootA.dispose();
    await bootB.dispose();
    mutationList.length = 0;

    if ((seq + 1) % 100 === 0)
      console.log(
        `seq ${seq + 1}/${SEQ_COUNT} ok=${sequencesOk} mismatches=${mismatches.length} elapsed=${Date.now() - t0}ms`,
      );
  }

  const result = {
    meta: {
      test: "A1b-T3-fixed",
      sequences: SEQ_COUNT,
      baseSeed: BASE_SEED,
      transportRules: ["styles-subset(insert-sheet)", "filter-reconcile(SHEET_FILTER_PLUGIN)"],
      node: process.version,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    },
    summary: {
      sequencesOk,
      sequencesMismatch: mismatches.length,
      totalOps,
      replayedMutations,
      replayFailures,
      fixupStats,
      danglingByMutation,
    },
    opStats,
    mismatches: mismatches.slice(0, 50),
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-t3-fixed.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
  process.exit(mismatches.length === 0 ? 0 : 1);
}

await main();
