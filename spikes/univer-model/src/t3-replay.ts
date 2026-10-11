// T3 复现一致性：A（“前端”）执行命令捕获 mutation → JSON 往返 → B（“服务端”）fromCollab 复现。
// 逐操作比对两份 workbook.save() 快照，首个不一致即停并记录最小前缀。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, type IgnoreRule, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, type OpResult, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { getOrCreate } from "./lib/stats.ts";
import { type Booted, bootUniver, createBook, replayMutations } from "./lib/univer-node.ts";

const SEQ_COUNT = Number(process.env.T3_SEQS ?? 1000);
const BASE_SEED = Number(process.env.T3_SEED ?? 20260929);
const MIN_OPS = 20;
const MAX_OPS = 50;

// 显式忽略清单（必须逐条在 REPORT 中说明观察到的差异与理由）。
// 初始为空——先跑小规模找出真实差异，再回来填清单。
export const IGNORE: IgnoreRule[] = JSON.parse(process.env.T3_IGNORE ?? "[]").map(
  (re: string) => (path: string[]) => new RegExp(re).test(path.join(".")),
);

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

interface OpStats {
  executed: number;
  ok: number;
  failed: number;
  threw: number;
  causedDiff: number;
  failureReasons: Record<string, number>;
}

interface Mismatch {
  seqIndex: number;
  seed: number;
  opIndex: number;
  opType: string;
  commandId: string;
  diffs: Array<{ path: string; a: unknown; b: unknown }>;
}

async function main() {
  const opStats: Record<string, OpStats> = {};
  const mutationIdsSeen: Record<string, number> = {};
  const mismatches: Mismatch[] = [];
  const unserializable: Array<{ seq: number; op: number; type: string }> = [];
  let sequencesOk = 0;
  let replayedMutations = 0;
  let replayFailures = 0;
  let totalOps = 0;
  const t0 = Date.now();

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-t3-${seq}`;
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
      const st = getOrCreate(
        opStats,
        res.opType,
        (): OpStats => ({
          executed: 0,
          ok: 0,
          failed: 0,
          threw: 0,
          causedDiff: 0,
          failureReasons: {},
        }),
      );
      st.executed += 1;
      if (res.threw) {
        st.threw += 1;
        st.failed += 1;
        const key = res.threw.slice(0, 120);
        st.failureReasons[key] = (st.failureReasons[key] ?? 0) + 1;
      } else if (!res.ok) {
        st.failed += 1;
        st.failureReasons["returned false"] = (st.failureReasons["returned false"] ?? 0) + 1;
      } else st.ok += 1;
      if (!res.paramsSerializable) unserializable.push({ seq, op: i, type: res.opType });
      for (const m of res.mutations) {
        mutationIdsSeen[m.id] = (mutationIdsSeen[m.id] ?? 0) + 1;
      }

      // 复现该操作产生的全部 mutation
      const rep = await replayMutations(bootB, res.mutations);
      replayedMutations += rep.okCount + rep.failures.length;
      replayFailures += rep.failures.length;

      // 逐操作比对——定位首个分叉操作
      const diffs = deepDiff(
        normalizeSnapshot(bookA.save()),
        normalizeSnapshot(bookB.save()),
        [],
        IGNORE,
      );
      if (diffs.length > 0) {
        mismatches.push({
          seqIndex: seq,
          seed,
          opIndex: i,
          opType: res.opType,
          commandId: res.commandId,
          diffs: diffs.slice(0, 30),
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

    if ((seq + 1) % 50 === 0)
      console.log(
        `seq ${seq + 1}/${SEQ_COUNT} ok=${sequencesOk} mismatches=${mismatches.length} elapsed=${Date.now() - t0}ms`,
      );
  }

  // ── 负对照：比较器必须报出差异 ──
  const bootA = bootUniver();
  const bootB = bootUniver();
  const { snapshot: snapNeg } = genSmallSnapshot("wb-neg", createPrng(777));
  const snapNegB = JSON.parse(JSON.stringify(snapNeg)) as IWorkbookData;
  const aNeg = createBook(bootA, snapNeg);
  const bNeg = createBook(bootB, snapNegB);
  const negativeControls: Record<string, number> = {};
  {
    const sa = aNeg.save();
    const sb = bNeg.save();
    const s1 = (sb.sheets as Record<string, Record<string, unknown>>).s1 as Record<string, unknown>;
    const cd = s1.cellData as Record<string, Record<string, unknown>>;
    const firstRow = Object.keys(cd)[0] as string;
    const firstCol = Object.keys(cd[firstRow] ?? {})[0] as string;
    (
      (cd[firstRow] as Record<string, Record<string, unknown>>)[firstCol] as Record<string, unknown>
    ).v = "TAMPERED";
    negativeControls["cell-value-tamper"] = deepDiff(sa, sb, [], IGNORE).length;
    const aSheets = sa.sheets as Record<string, Record<string, unknown>>;
    const aCellData = (aSheets.s1?.cellData ?? {}) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const origV = aCellData[firstRow]?.[firstCol]?.v ?? null;
    (
      (cd[firstRow] as Record<string, Record<string, unknown>>)[firstCol] as Record<string, unknown>
    ).v = origV;
  }
  {
    const sa = aNeg.save();
    const sb = bNeg.save();
    ((sb.styles as Record<string, Record<string, unknown>>).s0 as Record<string, unknown>).bl = 0;
    negativeControls["style-tamper"] = deepDiff(sa, sb, [], IGNORE).length;
    ((sb.styles as Record<string, Record<string, unknown>>).s0 as Record<string, unknown>).bl = (
      (sa.styles as Record<string, Record<string, unknown>>).s0 as Record<string, unknown>
    ).bl;
  }
  {
    const sa = aNeg.save();
    const sb = bNeg.save();
    const s1 = (sb.sheets as Record<string, Record<string, unknown>>).s1 as Record<string, unknown>;
    s1.mergeData = [{ startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 }];
    negativeControls["merge-tamper"] = deepDiff(sa, sb, [], IGNORE).length;
  }
  // cellData 未被整体忽略的断言：改值后差异路径必须落在 cellData 上
  {
    const sa = aNeg.save();
    const sb = JSON.parse(JSON.stringify(sa)) as IWorkbookData;
    const s1 = (sb.sheets as Record<string, Record<string, unknown>>).s1 as Record<string, unknown>;
    const cd = s1.cellData as Record<string, Record<string, Record<string, unknown>>>;
    const r = Object.keys(cd)[0] as string;
    const c = Object.keys(cd[r] ?? {})[0] as string;
    (cd[r] as Record<string, Record<string, unknown>>)[c] = { v: "DIFF" };
    const d = deepDiff(sa, sb, [], IGNORE);
    negativeControls["cellData-path-assert"] = d.some((x) => x.path.includes("cellData")) ? 1 : 0;
  }
  disposeUnit(bootA, "wb-neg");
  disposeUnit(bootB, "wb-neg");
  await bootA.dispose();
  await bootB.dispose();

  const result = {
    meta: {
      test: "T3-replay",
      sequences: SEQ_COUNT,
      baseSeed: BASE_SEED,
      opsPerSeq: [MIN_OPS, MAX_OPS],
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    },
    summary: {
      sequencesOk,
      sequencesMismatch: mismatches.length,
      totalOps,
      replayedMutations,
      replayFailures,
      mutationIdsSeen,
      ignoreRules: JSON.parse(process.env.T3_IGNORE ?? "[]"),
    },
    opStats,
    unserializable,
    mismatches: mismatches.slice(0, 50),
    negativeControls,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/t3-replay.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
  console.log("negativeControls:", negativeControls);
  if (mismatches.length > 0)
    console.log("first mismatch:", JSON.stringify(mismatches[0], null, 2).slice(0, 3000));
  process.exit(mismatches.length === 0 ? 0 : 1);
}

await main();
