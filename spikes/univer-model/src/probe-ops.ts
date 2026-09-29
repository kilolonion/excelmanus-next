// 冒烟：每个 op 跑一遍，报告 ok/fail + 发出的 mutation id

import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, OPS, type OpCtx } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const boot = bootUniver();
attachRecorder(boot);
const prng = createPrng(42);
const { snapshot, sheets } = genSmallSnapshot("wb-smoke", prng);
const book = createBook(boot, snapshot);

const ctx: OpCtx = {
  boot,
  unitId: book.unitId,
  prng,
  sheets: sheets.map((s) => ({ id: s.id, name: s.name, rowCount: s.rows, colCount: s.cols })),
  merges: new Map(),
  dvRules: [],
  cfRuleIds: [],
  hiddenRows: new Map(),
  hiddenCols: new Map(),
  frozenSheets: new Set(),
  filterSheets: new Map(),
  seqId: 0,
  opIndex: 0,
};

for (const op of OPS) {
  ctx.opIndex += 1;
  try {
    const res = await op.run(ctx);
    console.log(
      `${res.opType.padEnd(22)} ok=${res.ok}${res.threw ? ` THREW:${res.threw.slice(0, 120)}` : ""} muts=[${res.mutationIds.join(",")}] ser=${res.paramsSerializable}`,
    );
  } catch (e) {
    console.log(`${op.type.padEnd(22)} CRASH ${(e as Error).message?.slice(0, 160)}`);
  }
}
await boot.dispose();
process.exit(0);
