// 打印每种 mutation id 的 params 骨架（供写集规则推导用）

import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const b = bootUniver();
attachRecorder(b);
const { snapshot, sheets } = genSmallSnapshot("wb-x", createPrng(7));
const book = createBook(b, snapshot);
const ctx: OpCtx = {
  boot: b,
  unitId: book.unitId,
  prng: createPrng(11),
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
const seen = new Map<string, unknown>();
function skeleton(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object" || depth > 4) return v === null ? null : typeof v;
  if (Array.isArray(v)) return v.length ? [skeleton(v[0], depth + 1), `…x${v.length}`] : [];
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).slice(0, 8)) out[k] = skeleton(o[k], depth + 1);
  if (Object.keys(o).length > 8) out["…"] = `${Object.keys(o).length} keys`;
  return out;
}
for (let i = 0; i < 500; i++) {
  ctx.opIndex = i;
  try {
    await pickOp(ctx.prng).run(ctx);
  } catch {
    /* ignore */
  }
  for (const m of mutationList) if (!seen.has(m.id)) seen.set(m.id, m.params);
  mutationList.length = 0;
  if (seen.size >= 60) break;
}
for (const [id, p] of [...seen.entries()].sort()) {
  console.log("==", id, "::", JSON.stringify(skeleton(p)).slice(0, 500));
}
await b.dispose();
process.exit(0);
