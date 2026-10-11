import type { IWorkbookData } from "@univerjs/core";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const boot = bootUniver();
const snap = {
  id: "wb-dbg",
  name: "d",
  sheetOrder: ["data", "cases"],
  appVersion: "0.0.0",
  styles: {},
  sheets: {
    data: {
      id: "data",
      name: "Data",
      rowCount: 20,
      columnCount: 15,
      cellData: { 0: { 0: { v: 5 } } },
    },
    cases: { id: "cases", name: "Cases", rowCount: 200, columnCount: 5, cellData: {} },
  },
} as unknown as IWorkbookData;
const book = createBook(boot, snap);
const sv = book.save() as IWorkbookData;
console.log(
  "unitId:",
  book.unitId,
  "sheet keys:",
  Object.keys(sv.sheets ?? {}),
  "order:",
  sv.sheetOrder,
);
for (const [k, v] of Object.entries(sv.sheets ?? {}))
  console.log(
    " sheet",
    k,
    "-> id:",
    (v as { id: string }).id,
    "name:",
    (v as { name: string }).name,
  );
const ok = await boot.commandService.executeCommand("sheet.command.set-range-values", {
  unitId: "wb-dbg",
  subUnitId: "cases",
  range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
  value: { f: "=SUM(Data!A1:A10)" },
});
console.log("cmd ok:", ok);
await new Promise((r) => setTimeout(r, 500));
const sv2 = book.save() as IWorkbookData;
console.log(
  "cases cellData:",
  JSON.stringify((sv2.sheets?.cases as { cellData?: unknown })?.cellData ?? null).slice(0, 400),
);
process.exit(0);
