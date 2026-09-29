// A1b-1b 深挖：seq388 —— 逐操作比对 B_collab，定位首个发散操作，并打印该操作
// 发出的全部 mutation、A/B 两侧 filter 资源内容差异。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { type Booted, bootUniver, createBook } from "./lib/univer-node.ts";

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

async function main() {
  const t3 = JSON.parse(readFileSync("results/t3-replay.json", "utf8")) as {
    mismatches: Array<{ seqIndex: number; seed: number; opIndex: number; opType: string }>;
  };
  const target = t3.mismatches.find((m) => m.seqIndex === 388);
  if (!target) throw new Error("seq388 not found");
  const { seed, seqIndex, opIndex } = target;
  const unitId = `wb-a1b-${seqIndex}`;
  const prng = createPrng(seed);
  const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));

  const bootA = bootUniver();
  attachRecorder(bootA);
  const bookA = createBook(bootA, snapshot);
  const bootB = bootUniver();
  const bookB = createBook(bootB, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);

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
    seqId: seqIndex,
    opIndex: 0,
  };

  const findings: Array<Record<string, unknown>> = [];
  let prevB = bookB.save();
  for (let i = 0; i <= opIndex; i++) {
    ctx.opIndex = i;
    const op = pickOp(prng);
    const res = await op.run(ctx);
    // B 端 collab 复现
    for (const m of res.mutations) {
      await bootB.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
      });
    }
    const aSnap = normalizeSnapshot(bookA.save());
    const bSnap = normalizeSnapshot(bookB.save());
    const diffs = deepDiff(aSnap, bSnap, [], []);
    if (diffs.length > 0) {
      // 首个发散操作：打印 mutation 列表 + A/B filter 资源全文对比 + B 上一操作资源
      const resA = (bookA.save().resources ?? []) as Array<{ name: string; data: string }>;
      const resB = (bookB.save().resources ?? []) as Array<{ name: string; data: string }>;
      const prevResB = (prevB.resources ?? []) as Array<{ name: string; data: string }>;
      const fa = resA.find((r) => r.name === "SHEET_FILTER_PLUGIN");
      const fb = resB.find((r) => r.name === "SHEET_FILTER_PLUGIN");
      const fp = prevResB.find((r) => r.name === "SHEET_FILTER_PLUGIN");
      findings.push({
        firstDiffOpIndex: i,
        opType: res.opType,
        commandId: res.commandId,
        opParams: res.params,
        emittedMutations: res.mutations.map((m) => ({
          id: m.id,
          paramsPreview: JSON.stringify(m.params).slice(0, 300),
        })),
        diffsSample: diffs.slice(0, 6),
        filterResourceA: fa?.data,
        filterResourceB: fb?.data,
        filterResourceBPrev: fp?.data,
      });

      // 修复验证 1：把 A 的最终 filter ref 作为"对账 mutation"补发给 B
      const refA = (JSON.parse(fa?.data ?? "{}") as Record<string, { ref: unknown }>).s2?.ref;
      if (refA) {
        await bootB.commandService.executeCommand(
          "sheet.mutation.set-filter-range",
          {
            unitId,
            subUnitId: "s2",
            range: refA,
            filteredOutRows: [],
          },
          { fromCollab: true },
        );
        const after = deepDiff(aSnap, normalizeSnapshot(bookB.save()), [], []);
        (findings[0] as Record<string, unknown>).afterReconcileSetFilterRange = {
          diffs: after.length,
          sample: after.slice(0, 4).map((d) => d.path),
        };
      }
      // 修复验证 2：以 onlyLocal 重放本操作（跳过 B 侧 extend 监听），再补对账
      const bookB2 = bootB;
      void bookB2;
      break;
    }
    prevB = bookB.save();
  }

  console.log(JSON.stringify(findings, null, 1).slice(0, 6000));
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-drift-deep.json", JSON.stringify(findings, null, 2));
  disposeUnit(bootA, unitId);
  disposeUnit(bootB, unitId);
  await bootA.dispose();
  await bootB.dispose();
  process.exit(0);
}

await main();
