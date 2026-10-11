// A1b-1d U2：分叉式 dryRun 量化。
//  Phase A 成本：在 50k×20 与 200k×30 活文档上，连续 FORKS 次
//    save() → 临时 workbook → 在临时实例上应用一批 mutation → save() 读结果 → disposeUnit。
//    记录 save/create/apply/dispose 耗时与 RSS 轨迹（暴露 GC 后看是否回落）。
//  Phase B 正确性：抽 FORK_SEQ 个 T3 序列，同一初始快照上
//    B-live 复现全部 mutation（带传输修补），temp=fork(live 初始快照) 复现同样 mutation，
//    比较 temp.save() 与 B-live.save()（同一严格比较器+归一化）。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genLargeSnapshot, genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { statsOf } from "./lib/stats.ts";
import { fixupMutationForTransport, reconcileFilterResource } from "./lib/transport.ts";
import { type Booted, bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const FORKS = Number(process.env.A1B_FORKS ?? 20);
const FORK_SEQ = Number(process.env.A1B_FORK_SEQS ?? 100);
const BASE_SEED = 20260929;

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

function rss() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

async function phaseCost() {
  const out: Record<string, unknown> = {};
  for (const spec of [
    { name: "50k×20", rows: 50000, cols: 20 },
    { name: "200k×30", rows: 200000, cols: 30 },
  ]) {
    const boot = bootUniver();
    attachRecorder(boot);
    // 同一 Univer 实例内 unitId 唯一——分叉放第二个 Univer 实例（mutation 可原样复用）
    const bootT = bootUniver();
    const { snapshot } = genLargeSnapshot(`wb-fork-${spec.name}`, spec.rows, spec.cols, 20260929);
    const book = createBook(boot, snapshot);
    const liveRss0 = rss();
    console.log(`${spec.name}: live doc rss=${liveRss0}MB`);
    const saveMs: number[] = [];
    const createMs: number[] = [];
    const applyMs: number[] = [];
    const disposeMs: number[] = [];
    const rssTrace: number[] = [];
    let peak = liveRss0;
    for (let k = 0; k < FORKS; k++) {
      const t0 = performance.now();
      const snap = book.save() as IWorkbookData;
      const t1 = performance.now();
      const temp = createBook(bootT, snap);
      const tempId = temp.unitId;
      const t2 = performance.now();
      // dryRun 等效负载：100 次写值 mutation（模拟一次提交的变更量）
      for (let i = 0; i < 100; i++) {
        await bootT.commandService.executeCommand("sheet.mutation.set-range-values", {
          unitId: tempId,
          subUnitId: Object.keys(snap.sheets ?? {})[0],
          cellValue: { [k]: { 0: { v: i } } },
        });
      }
      const read = temp.save();
      const t3 = performance.now();
      disposeUnit(bootT, tempId);
      const t4 = performance.now();
      saveMs.push(t1 - t0);
      createMs.push(t2 - t1);
      applyMs.push(t3 - t2);
      disposeMs.push(t4 - t3);
      if (global.gc) global.gc();
      const r = rss();
      rssTrace.push(r);
      if (r > peak) peak = r;
      void read;
    }
    out[spec.name] = {
      liveRssMB: liveRss0,
      peakRssMB: peak,
      rssTraceEnd: rssTrace.slice(-5),
      saveMs: statsOf(saveMs),
      createMs: statsOf(createMs),
      applyMs: statsOf(applyMs),
      disposeMs: statsOf(disposeMs),
      rssDeltaLastVsFirst:
        rssTrace.length >= 2 ? (rssTrace[rssTrace.length - 1] ?? 0) - (rssTrace[0] ?? 0) : 0,
      rssTrace,
    };
    disposeUnit(boot, book.unitId);
    await boot.dispose();
    await bootT.dispose();
    mutationList.length = 0;
    const o = out[spec.name] as
      | {
          saveMs: { p50: number };
          createMs: { p50: number };
          disposeMs: { p50: number };
          rssDeltaLastVsFirst: number;
        }
      | undefined;
    console.log(
      `${spec.name}: save=${o?.saveMs.p50.toFixed(0) ?? "?"}ms create=${o?.createMs.p50.toFixed(0) ?? "?"}ms dispose=${o?.disposeMs.p50.toFixed(0) ?? "?"}ms peak=${peak}MB rssΔ=${o?.rssDeltaLastVsFirst ?? "?"}MB`,
    );
  }
  return out;
}

async function phaseCorrect() {
  let equal = 0;
  const diffsExamples: string[] = [];
  const failLogs: string[] = [];
  for (let seq = 0; seq < FORK_SEQ; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-fc-${seq}`;
    const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));
    // createWorkbook 会保留对传入对象内部结构的引用，A 端后续 mutation 会污染
    // 调用方手里的 snapshot——fork 必须在创建前深拷贝定影（已实测：不复制定影
    // 会让 temp 初始状态混入 A 的中途状态，insert-sheet 撞 id 全部 false）。
    const snapshotT = JSON.parse(JSON.stringify(snapshot)) as IWorkbookData;
    const bootA = bootUniver();
    attachRecorder(bootA);
    const bookA = createBook(bootA, snapshot);
    const bootB = bootUniver();
    const bookB = createBook(bootB, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);
    const bootT = bootUniver();

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
    const opCount = 20 + Math.floor(prng.next() * 31);
    const allMutations: CapturedMutation[] = [];
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const op = pickOp(prng);
      const res = await op.run(ctx);
      allMutations.push(
        ...res.mutations.map((m) => ({
          id: m.id,
          params: JSON.parse(JSON.stringify(m.params)),
        })),
      );
    }
    // B-live 复现（等价于 T3-fixed 的 B 端）
    for (const m of allMutations) {
      const fixed = fixupMutationForTransport(m, bookA.save() as IWorkbookData, "styles-subset");
      const okL = await bootB.commandService.executeCommand(
        fixed.mutation.id,
        JSON.parse(JSON.stringify(fixed.mutation.params)),
        { fromCollab: true },
      );
      if (!okL && failLogs.length < 5)
        failLogs.push(`seq${seq} LIVE ${fixed.mutation.id} ok=false`);
    }
    const rec = reconcileFilterResource(
      bookA.save() as IWorkbookData,
      bookB.save() as IWorkbookData,
      unitId,
    );
    for (const m of rec) {
      await bootB.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
      });
    }
    // temp = fork(初始快照) 到独立实例，放同一批 mutation（unitId 相同，params 原样）
    const temp = createBook(bootT, JSON.parse(JSON.stringify(snapshotT)) as IWorkbookData);
    for (const m of allMutations) {
      const fixed = fixupMutationForTransport(m, bookA.save() as IWorkbookData, "styles-subset");
      let okM = false;
      try {
        okM = await bootT.commandService.executeCommand(
          fixed.mutation.id,
          JSON.parse(JSON.stringify(fixed.mutation.params)),
          { fromCollab: true },
        );
      } catch (e) {
        console.log(
          `temp replay FAIL seq${seq} unit=${unitId} temp=${temp.unitId} ${fixed.mutation.id}: ${(e as Error).message}`,
        );
        break;
      }
      if (!okM && failLogs.length < 5) failLogs.push(`seq${seq} ${fixed.mutation.id} ok=false`);
    }
    const rec2 = reconcileFilterResource(
      bookA.save() as IWorkbookData,
      temp.save() as IWorkbookData,
      unitId,
    );
    for (const m of rec2) {
      await bootT.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
      });
    }
    const diffs = deepDiff(normalizeSnapshot(bookB.save()), normalizeSnapshot(temp.save()), [], []);
    if (diffs.length === 0) equal += 1;
    else if (diffsExamples.length < 5) {
      diffsExamples.push(
        `seq${seq}: ${diffs
          .slice(0, 3)
          .map((d) => d.path)
          .join(",")}`,
      );
    }
    disposeUnit(bootT, temp.unitId);
    disposeUnit(bootA, unitId);
    disposeUnit(bootB, unitId);
    await bootA.dispose();
    await bootB.dispose();
    await bootT.dispose();
    mutationList.length = 0;
    if ((seq + 1) % 25 === 0) console.log(`correct ${seq + 1}/${FORK_SEQ} equal=${equal}`);
  }
  return { equal, total: FORK_SEQ, diffsExamples, failLogs };
}

async function main() {
  console.log("=== Phase A: 分叉成本（含 20 次 RSS 轨迹）===");
  const cost = process.env.A1B_SKIP_COST ? {} : await phaseCost();
  console.log("=== Phase B: temp 实例结果 vs B-live 等价性 ===");
  const correct = await phaseCorrect();
  const result = {
    meta: {
      test: "A1b-U2-forked-dryRun",
      forks: FORKS,
      correctnessSeqs: FORK_SEQ,
      node: process.version,
      ts: new Date().toISOString(),
    },
    cost,
    correctness: correct,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-fork.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ correctness: `${correct.equal}/${correct.total}` }));
  process.exit(0);
}

await main();
