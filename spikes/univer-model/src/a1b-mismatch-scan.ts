// A1b-1b 补充：t3-replay.json 的 mismatches 截断到前 50 条，filter 资源漂移
// 只保留到 3 例。本脚本用相同种子/生成器重放 1000 序列（无任何传输修补），
// 只记录 diff 落在 resources.* 的不一致（完整枚举，不截断），供根因分析取例。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { type Booted, bootUniver, createBook } from "./lib/univer-node.ts";

const SEQ_COUNT = 1000;
const BASE_SEED = 20260929;
const MIN_OPS = 20;
const MAX_OPS = 50;

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
  const resourceMismatches: Array<Record<string, unknown>> = [];
  let sequencesOk = 0;
  let totalMismatch = 0;
  const t0 = Date.now();

  for (let seq = 0; seq < SEQ_COUNT; seq++) {
    const seed = BASE_SEED + seq;
    const prng = createPrng(seed);
    const unitId = `wb-scan-${seq}`;
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
    let diffed = false;
    for (let i = 0; i < opCount; i++) {
      ctx.opIndex = i;
      const op = pickOp(prng);
      const res = await op.run(ctx);
      for (const m of res.mutations) {
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
        diffed = true;
        totalMismatch += 1;
        if (diffs.some((d) => d.path.includes("resources"))) {
          resourceMismatches.push({
            seqIndex: seq,
            seed,
            opIndex: i,
            opType: res.opType,
            commandId: res.commandId,
            diffs: diffs.slice(0, 3),
          });
        }
        break;
      }
    }
    if (!diffed) sequencesOk += 1;
    disposeUnit(bootA, unitId);
    disposeUnit(bootB, unitId);
    await bootA.dispose();
    await bootB.dispose();
    mutationList.length = 0;
    if ((seq + 1) % 200 === 0)
      console.log(
        `seq ${seq + 1}/${SEQ_COUNT} resMismatch=${resourceMismatches.length} ${Date.now() - t0}ms`,
      );
  }

  const out = {
    meta: { test: "A1b-resource-mismatch-scan", baseSeed: BASE_SEED, elapsedMs: Date.now() - t0 },
    summary: { sequencesOk, totalMismatch, resourceMismatch: resourceMismatches.length },
    resourceMismatches,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-mismatch-scan.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary));
  process.exit(0);
}

await main();
