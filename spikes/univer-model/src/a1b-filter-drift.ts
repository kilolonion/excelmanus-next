// A1b-1b：filter 资源漂移根因对照实验。
// 对 t3-replay.json 中 remove-cols/insert-cols/remove-rows 引发的全部发散例：
//  记录 A 侧 culprit 操作期间发出的全部 mutation（i）；
//  分别用 {fromCollab:true} / 无选项 / 原命令重放 / enableSyncSwitch=false 四种方式在 B 复现（ii/iv）；
//  最后与 A 的 save() 做同一严格比较。
// （iii）源码阅读结论直接写进 REPORT-A1b.md。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { IConfigService, IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { type Booted, bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const SHEETS_FILTER_PLUGIN_CONFIG_KEY = "sheets-filter.config";

type Mode = "collab" | "plain" | "command" | "syncoff";

interface OpRec {
  opType: string;
  commandId: string;
  params: Record<string, unknown>;
  mutations: CapturedMutation[];
  ok: boolean;
}

// 确定性重放某个序列的 0..opIndex（含）操作，记录每一步的 params+mutations
async function recordSeq(seed: number, seqIndex: number, opIndex: number) {
  const unitId = `wb-a1b-${seqIndex}`;
  const prng = createPrng(seed);
  const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));
  const bootA = bootUniver();
  attachRecorder(bootA);
  const bookA = createBook(bootA, snapshot);
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
  const ops: OpRec[] = [];
  for (let i = 0; i <= opIndex; i++) {
    ctx.opIndex = i;
    const op = pickOp(prng);
    const res = await op.run(ctx);
    ops.push({
      opType: res.opType,
      commandId: res.commandId,
      params: JSON.parse(JSON.stringify(res.params)) as Record<string, unknown>,
      mutations: JSON.parse(JSON.stringify(res.mutations)) as CapturedMutation[],
      ok: res.ok,
    });
  }
  return { bootA, bookA, ops, unitId };
}

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

async function replayOnB(
  ops: OpRec[],
  snapshot: IWorkbookData,
  mode: Mode,
  culpritIndex: number,
): Promise<{ boot: Booted; save(): IWorkbookData }> {
  const boot = bootUniver();
  if (mode === "syncoff") {
    // 在插件控制器实例化前写入配置（控制器按 unit 生命周期创建）
    const cfg = (
      boot.injector as { get(t: unknown): { setConfig(k: string, v: unknown): void } }
    ).get(IConfigService);
    cfg.setConfig(SHEETS_FILTER_PLUGIN_CONFIG_KEY, {
      enableSyncSwitch: { defaultValue: false },
    });
  }
  const book = createBook(boot, JSON.parse(JSON.stringify(snapshot)));
  for (let i = 0; i <= culpritIndex; i++) {
    const rec = ops[i] as OpRec;
    if (mode === "command" && i === culpritIndex) {
      // 命令重放：B 端执行原始命令（其自身控制器应做相同的资源联动）
      await boot.commandService.executeCommand(
        rec.commandId,
        JSON.parse(JSON.stringify(rec.params)),
      );
      continue;
    }
    for (const m of rec.mutations) {
      const params = JSON.parse(JSON.stringify(m.params));
      const opts = mode === "collab" || mode === "syncoff" ? { fromCollab: true } : undefined;
      await boot.commandService.executeCommand(m.id, params, opts);
    }
  }
  return { boot, save: () => book.save() };
}

async function main() {
  const t3 = JSON.parse(readFileSync("results/t3-replay.json", "utf8")) as {
    mismatches: Array<{ seqIndex: number; seed: number; opIndex: number; opType: string }>;
  };
  const cases = t3.mismatches.filter((m) => m.opType !== "copy-sheet");
  console.log(
    `cases: ${cases.map((c) => `${c.opType}@seq${c.seqIndex}/op${c.opIndex}`).join(", ")}`,
  );

  const out: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const { bootA, bookA, ops, unitId } = await recordSeq(c.seed, c.seqIndex, c.opIndex);
    const culprit = ops[c.opIndex] as OpRec;
    const aSnap = normalizeSnapshot(bookA.save());
    const emittedIds = culprit.mutations.map((m) => m.id);
    const filterRelated = emittedIds.filter((id) => /filter|hide|visib/i.test(id));

    const perMode: Record<string, unknown> = {};
    for (const mode of ["collab", "plain", "command", "syncoff"] as Mode[]) {
      // B 从"初始快照"重放前缀，而非拷贝 A 当前态
      const { snapshot: initSnap } = genSmallSnapshot(unitId, createPrng(c.seed ^ 0x9e37));
      const { boot, save } = await replayOnB(ops, initSnap, mode, c.opIndex);
      const diffs = deepDiff(aSnap, normalizeSnapshot(save()), [], []);
      perMode[mode] = {
        diffs: diffs.length,
        sample: diffs.slice(0, 4).map((d) => d.path),
      };
      disposeUnit(boot, unitId);
      await boot.dispose();
      mutationList.length = 0;
    }
    out.push({
      seqIndex: c.seqIndex,
      seed: c.seed,
      opIndex: c.opIndex,
      opType: c.opType,
      commandId: culprit.commandId,
      emittedMutations: emittedIds,
      filterRelatedEmitted: filterRelated,
      perMode,
    });
    console.log(
      `seq${c.seqIndex} ${c.opType}: emitted=[${emittedIds.join(",")}] modes=${Object.entries(
        perMode,
      )
        .map(([k, v]) => `${k}:${(v as { diffs: number }).diffs}`)
        .join(" ")}`,
    );
    disposeUnit(bootA, unitId);
    await bootA.dispose();
    mutationList.length = 0;
  }

  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-filter-drift.json", JSON.stringify({ cases: out }, null, 2));
  process.exit(0);
}

await main();
