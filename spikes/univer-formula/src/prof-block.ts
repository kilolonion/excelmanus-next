// 重算进行中时，同一实例上的小提交/事件循环延迟。
import type { IWorkbookData } from "@univerjs/core";
import { subscribeCalcDone } from "./lib/calc.ts";
import { bootUniver } from "./lib/univer-node.ts";

const rows = Number(process.env.ROWS ?? 50000);
const cellData: Record<number, Record<number, Record<string, unknown>>> = {};
for (let r = 0; r < rows; r++) {
  const n = r + 1;
  const row: Record<number, Record<string, unknown>> = { 0: { v: r % 97 }, 1: { v: r % 13 } };
  const fs = [
    `=A${n}+B${n}`,
    `=C${n}*2`,
    `=D${n}-A${n}`,
    `=IF(E${n}>0,E${n},0)`,
    `=ROUND(F${n}/3,2)`,
    `=G${n}+B${n}`,
    `=MAX(H${n},C${n})`,
    `=I${n}-D${n}`,
    `=IF(J${n}>0,"pos","neg")`,
    `=LEN(K${n})+J${n}`,
  ];
  fs.forEach((f, c) => {
    row[c + 2] = { f };
  });
  cellData[r] = row;
}
const boot = bootUniver();
const w0 = subscribeCalcDone(boot, 600000, 2_000_000_000);
boot.univerAPI.createWorkbook({
  id: "wb",
  name: "p",
  sheetOrder: ["s"],
  appVersion: "0",
  styles: {},
  sheets: { s: { id: "s", name: "S", rowCount: rows + 10, columnCount: 16, cellData } },
} as unknown as IWorkbookData);
await w0.promise;
const lags: number[] = [];
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  lags.push(now - last - 10);
  last = now;
}, 10);
const w = subscribeCalcDone(boot, 600000);
const t0 = performance.now();
await boot.commandService.executeCommand("sheet.command.set-range-values", {
  unitId: "wb",
  subUnitId: "s",
  range: { startRow: 10, startColumn: 0, endRow: 10, endColumn: 0 },
  value: { v: 999 },
});
await new Promise((r) => setTimeout(r, 200));
const t1 = performance.now();
await boot.commandService.executeCommand("sheet.command.set-range-values", {
  unitId: "wb",
  subUnitId: "s",
  range: { startRow: 20, startColumn: 14, endRow: 20, endColumn: 14 },
  value: { v: 1 },
});
const midCmdMs = performance.now() - t1;
const r = await w.promise;
clearInterval(tick);
lags.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    rows,
    calcMs: Math.round(r.ms),
    sinceFirstCmd: Math.round(performance.now() - t0),
    midCalcCmdMs: +midCmdMs.toFixed(2),
    maxLoopLagMs: Math.round(lags.at(-1) ?? 0),
    p99LagMs: Math.round(lags[Math.floor(lags.length * 0.99)] ?? 0),
    ticks: lags.length,
  }),
);
process.exit(0);
