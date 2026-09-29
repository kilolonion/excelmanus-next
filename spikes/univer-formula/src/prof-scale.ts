// 诊断：单输入增量重算耗时随行数/依赖形态的缩放。
// 变体：full = 与 recalc-bench 相同；noAbs = 去掉 $O$1；noAgg = 去掉 N1 汇总；chain = 仅 C 列一条公式。
import type { IWorkbookData } from "@univerjs/core";
import { subscribeCalcDone } from "./lib/calc.ts";
import { bootUniver } from "./lib/univer-node.ts";

type Variant = "full" | "noAbs" | "noAgg" | "noAbsNoAgg" | "single";

function snap(rows: number, v: Variant): IWorkbookData {
  const abs = v === "full" || v === "noAgg" ? "+$O$1" : "";
  const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
  for (let r = 0; r < rows; r++) {
    const n = r + 1;
    const row: Record<number, Record<string, unknown>> = { 0: { v: r % 97 }, 1: { v: r % 13 } };
    row[2] = { f: `=A${n}+B${n}${abs}` };
    if (v !== "single") {
      row[3] = { f: `=C${n}*2` };
      row[4] = { f: `=D${n}-A${n}` };
      row[5] = { f: `=IF(E${n}>0,E${n},0)` };
      row[6] = { f: `=ROUND(F${n}/3,2)` };
      row[7] = { f: `=G${n}+B${n}` };
      row[8] = { f: `=MAX(H${n},C${n})` };
      row[9] = { f: `=I${n}-D${n}` };
      row[10] = { f: `=IF(J${n}>0,"pos","neg")` };
      row[11] = { f: `=LEN(K${n})+J${n}` };
    }
    cellData[r] = row;
  }
  const r0 = cellData[0] ?? {};
  if (v === "full" || v === "noAbs") r0[13] = { f: `=SUM(L1:L${rows})` };
  r0[14] = { v: 0 };
  return {
    id: "wb",
    name: "p",
    sheetOrder: ["s"],
    appVersion: "0.0.0",
    styles: {},
    sheets: { s: { id: "s", name: "S", rowCount: rows + 10, columnCount: 16, cellData } },
  } as unknown as IWorkbookData;
}

const rows = Number(process.env.ROWS ?? 10000);
const variant = (process.env.VARIANT ?? "full") as Variant;
const boot = bootUniver();
const w0 = subscribeCalcDone(boot, 600000, 2_000_000_000);
const t0 = performance.now();
boot.univerAPI.createWorkbook(snap(rows, variant));
await w0.promise;
const loadMs = performance.now() - t0;
const samples: number[] = [];
for (let k = 0; k < 3; k++) {
  const w = subscribeCalcDone(boot, 600000);
  await boot.commandService.executeCommand("sheet.command.set-range-values", {
    unitId: "wb",
    subUnitId: "s",
    range: {
      startRow: Math.floor(rows / 2),
      startColumn: 0,
      endRow: Math.floor(rows / 2),
      endColumn: 0,
    },
    value: { v: 1000 + k },
  });
  const r = await w.promise;
  samples.push(Math.round(r.ms));
}
console.log(JSON.stringify({ rows, variant, loadMs: Math.round(loadMs), incrMs: samples }));
process.exit(0);
