// 诊断：快照载入后公式是否真的已计算（p1 的 ~160ms 是否可信）。
import type { IWorkbookData } from "@univerjs/core";
import { getSessionService, subscribeCalcDone } from "./lib/calc.ts";
import { bootUniver } from "./lib/univer-node.ts";

const rows = Number(process.env.ROWS ?? 50000);
const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
for (let r = 0; r < rows; r++) {
  const n = r + 1;
  cellData[r] = {
    0: { v: r % 97 },
    1: { v: r % 13 },
    2: { f: `=A${n}+B${n}` },
    3: { f: `=C${n}*2` },
  };
}
const boot = bootUniver();
const w0 = subscribeCalcDone(boot, 600000, 2_000_000_000);
const t0 = performance.now();
const wb = boot.univerAPI.createWorkbook({
  id: "wb",
  name: "p",
  sheetOrder: ["s"],
  appVersion: "0",
  styles: {},
  sheets: { s: { id: "s", name: "S", rowCount: rows + 10, columnCount: 8, cellData } },
} as unknown as IWorkbookData);
const r0 = await w0.promise;
const loadMs = performance.now() - t0;
const st = getSessionService(boot).state as unknown as { progress?: unknown };
const cells = (wb.save() as IWorkbookData).sheets.s?.cellData ?? {};
const probe = [0, Math.floor(rows / 2), rows - 1].map((r) => ({
  r,
  C: cells[r]?.[2]?.v,
  D: cells[r]?.[3]?.v,
  expC: (r % 97) + (r % 13),
}));
let computed = 0;
for (let r = 0; r < rows; r++) if (cells[r]?.[3]?.v !== undefined) computed++;
console.log(
  JSON.stringify({
    rows,
    outcome: r0.outcome,
    loadMs: Math.round(loadMs),
    computedD: computed,
    progress: st.progress,
    probe,
  }),
);
process.exit(0);
