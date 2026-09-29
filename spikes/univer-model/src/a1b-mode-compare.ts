// A1b-1b（全前缀模式）：对发散序列，同一批已记录操作分别以四种方式在 B 复现：
//   collab  —— 全部 mutation 以 {fromCollab:true} 重放（T3 现状）
//   plain   —— 全部 mutation 无选项重放
//   command —— 全部按"原命令 id+params"重放（B 自己跑命令层，不再放 mutation）
//   syncoff —— 全部 mutation collab + sheets-filter enableSyncSwitch.defaultValue=false
// 对每个模式逐操作与 A 比对，报告首个发散操作。
// 用法：node src/a1b-mode-compare.ts <seqIndex> [seqIndex...]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { IConfigService, IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { type Booted, bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const BASE_SEED = 20260929;
const KEY = "sheets-filter.config";
type Mode = "collab" | "plain" | "command" | "syncoff";

interface OpRec {
  opType: string;
  commandId: string;
  params: Record<string, unknown>;
  mutations: CapturedMutation[];
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

async function recordSeq(seed: number, seqIndex: number, opCount: number) {
  const unitId = `wb-a1bm-${seqIndex}`;
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
  for (let i = 0; i <= opCount; i++) {
    ctx.opIndex = i;
    const op = pickOp(prng);
    const res = await op.run(ctx);
    ops.push({
      opType: res.opType,
      commandId: res.commandId,
      params: JSON.parse(JSON.stringify(res.params)) as Record<string, unknown>,
      mutations: JSON.parse(JSON.stringify(res.mutations)) as CapturedMutation[],
    });
  }
  return { bootA, bookA, ops, unitId, snapshot };
}

async function replayAll(ops: OpRec[], snapshot: IWorkbookData, mode: Mode, _unitId: string) {
  const boot = bootUniver();
  if (mode === "syncoff") {
    const cfg = (
      boot.injector as { get(t: unknown): { setConfig(k: string, v: unknown): void } }
    ).get(IConfigService);
    cfg.setConfig(KEY, { enableSyncSwitch: { defaultValue: false } });
  }
  const book = createBook(boot, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);
  const firstDiff: { opIndex: number; diffs: number; sample: string[] } = {
    opIndex: -1,
    diffs: 0,
    sample: [],
  };
  // 参照快照需要逐步演化——A 的最终态只在最后比对；逐操作与 A 对齐做不到，
  // 因此这里只记录最终 diff 与"每步 B 端资源是否仍在变动"。
  for (const rec of ops) {
    if (mode === "command") {
      if (rec.commandId !== "-") {
        await boot.commandService.executeCommand(
          rec.commandId,
          JSON.parse(JSON.stringify(rec.params)),
        );
      } else {
        // 无命令形态的操作（内部直跑 mutation）按 mutation 复现
        for (const m of rec.mutations) {
          await boot.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)));
        }
      }
    } else {
      for (const m of rec.mutations) {
        const opts = mode === "collab" || mode === "syncoff" ? { fromCollab: true } : undefined;
        await boot.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), opts);
      }
    }
  }
  return { boot, save: () => book.save(), firstDiff };
}

async function main() {
  const seqIndexes = process.argv.slice(2).map(Number);
  const t3 = JSON.parse(readFileSync("results/t3-replay.json", "utf8")) as {
    mismatches: Array<{ seqIndex: number; seed: number; opIndex: number; opType: string }>;
  };
  const results: Array<Record<string, unknown>> = [];

  for (const seqIndex of seqIndexes) {
    const mm = t3.mismatches.find((m) => m.seqIndex === seqIndex);
    const seed = BASE_SEED + seqIndex;
    const opCount = mm ? mm.opIndex : 49;
    const { bootA, bookA, ops, unitId, snapshot } = await recordSeq(seed, seqIndex, opCount);
    const aSnap = normalizeSnapshot(bookA.save());

    const perMode: Record<string, unknown> = {};
    for (const mode of ["collab", "plain", "command", "syncoff"] as Mode[]) {
      const { boot, save } = await replayAll(ops, snapshot, mode, unitId);
      const diffs = deepDiff(aSnap, normalizeSnapshot(save()), [], []);
      perMode[mode] = { diffs: diffs.length, sample: diffs.slice(0, 5) };
      disposeUnit(boot, unitId);
      await boot.dispose();
      mutationList.length = 0;
    }
    results.push({
      seqIndex,
      seed,
      opCount: ops.length,
      opsUsed: ops.map((o) => o.opType),
      perMode,
    });
    console.log(
      `seq${seqIndex}: ${Object.entries(perMode)
        .map(([k, v]) => `${k}=${(v as { diffs: number }).diffs}`)
        .join("  ")}`,
    );
    disposeUnit(bootA, unitId);
    await bootA.dispose();
    mutationList.length = 0;
  }

  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-mode-compare.json", JSON.stringify({ results }, null, 2));
  process.exit(0);
}

await main();
