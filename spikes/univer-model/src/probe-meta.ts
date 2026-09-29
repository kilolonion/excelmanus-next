import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const b = bootUniver();
attachRecorder(b);
const { snapshot } = genSmallSnapshot("wb-p", createPrng(1));
createBook(b, snapshot);
await b.commandService.executeCommand("sheet.command.set-row-height", {
  unitId: "wb-p",
  subUnitId: "s1",
  value: 40,
  ranges: [{ startRow: 3, endRow: 5, startColumn: 0, endColumn: 0 }],
});
await b.commandService.executeCommand("sheet.command.set-worksheet-col-width", {
  unitId: "wb-p",
  subUnitId: "s1",
  value: 120,
  ranges: [{ startRow: 0, endRow: 0, startColumn: 2, endColumn: 4 }],
});
for (const m of mutationList) console.log(m.id, JSON.stringify(m.params).slice(0, 220));
process.exit(0);
