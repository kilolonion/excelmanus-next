import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const b = bootUniver();
attachRecorder(b);
const { snapshot } = genSmallSnapshot("wb-mr2", createPrng(1));
createBook(b, snapshot);
const ok = await b.commandService.executeCommand("sheet.command.move-range", {
  unitId: "wb-mr2",
  subUnitId: "s1",
  fromRange: { startRow: 2, endRow: 5, startColumn: 0, endColumn: 3 },
  toRange: { startRow: 10, endRow: 13, startColumn: 0, endColumn: 3 },
});
console.log("fwd ok", ok);
for (const m of mutationList) console.log(m.id, JSON.stringify(m.params).slice(0, 300));
process.exit(0);
