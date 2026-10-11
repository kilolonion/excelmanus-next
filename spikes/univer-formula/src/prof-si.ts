import type { IWorkbookData } from "@univerjs/core";
import { subscribeCalcDone } from "/Users/jiangwenxuan/Desktop/excelmanus-next/spikes/univer-formula/src/lib/calc.ts";
import { bootUniver } from "/Users/jiangwenxuan/Desktop/excelmanus-next/spikes/univer-formula/src/lib/univer-node.ts";

const rows = Number(process.env.ROWS ?? 10000);
const fs = [
  "=A1+B1",
  "=C1*2",
  "=D1-A1",
  "=IF(E1>0,E1,0)",
  "=ROUND(F1/3,2)",
  "=G1+B1",
  "=MAX(H1,C1)",
  "=I1-D1",
  '=IF(J1>0,"pos","neg")',
  "=LEN(K1)+J1",
];
const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
for (let r = 0; r < rows; r++) {
  const row: Record<number, Record<string, unknown>> = { 0: { v: r % 97 }, 1: { v: r % 13 } };
  for (let c = 0; c < 10; c++) row[c + 2] = r === 0 ? { f: fs[c], si: `s${c}` } : { si: `s${c}` };
  cellData[r] = row;
}
const snap = {
  id: "wb",
  name: "p",
  sheetOrder: ["s"],
  appVersion: "0.0.0",
  styles: {},
  sheets: { s: { id: "s", name: "S", rowCount: rows + 10, columnCount: 16, cellData } },
} as unknown as IWorkbookData;
const boot = bootUniver();
const w0 = subscribeCalcDone(boot, 600000, 2_000_000_000);
boot.univerAPI.createWorkbook(snap);
await w0.promise;
const out: number[] = [];
const mid = Math.floor(rows / 2);
for (let k = 0; k < 3; k++) {
  const w = subscribeCalcDone(boot, 600000);
  await boot.commandService.executeCommand("sheet.command.set-range-values", {
    unitId: "wb",
    subUnitId: "s",
    range: { startRow: mid, startColumn: 0, endRow: mid, endColumn: 0 },
    value: { v: 1000 + k },
  });
  out.push(Math.round((await w.promise).ms));
}
const ws = boot.univerAPI.getActiveWorkbook()!.getSheetBySheetId("s")!;
const got = ws.getRange(mid, 2, 1, 10).getValues()[0];
const a = 1002,
  b = mid % 13,
  c = a + b,
  d = c * 2,
  e = d - a,
  f = e > 0 ? e : 0,
  g = Math.round((f / 3) * 100) / 100,
  h = g + b,
  i = Math.max(h, c),
  j = i - d;
console.log(
  JSON.stringify({
    rows,
    si: true,
    incrMs: out,
    row: got,
    expect: [c, d, e, f, g, h, i, j, j > 0 ? "pos" : "neg", 3 + j],
  }),
);
process.exit(0);
