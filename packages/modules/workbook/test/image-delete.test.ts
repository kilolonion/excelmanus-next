import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { minimalXlsx, exportXlsx } from "../src/checkpoint.ts";
import { importXlsx } from "../src/xlsx.ts";
import { objectsOf } from "../src/objects.ts";
test("image deletion removes only its drawing and undo restores original anchor bytes", () => {
  const snap = importCsv(new TextEncoder().encode("a,b\n1,2"),"qa.csv").snapshot;
  const id = snap.sheetOrder[0]!;
  snap.sheets[id]!.custom = {excelmanusObjects:{charts:[],images:[{id:"pic",title:"测试",anchor:"E2",width:100,height:100,mediaType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII="}]}};
  const imported = importXlsx(minimalXlsx(snap),"qa.xlsx");
  const sid = imported.snapshot.sheetOrder[0]!;
  const original = structuredClone(imported.snapshot);
  const deleted = structuredClone(original);
  deleted.sheets[sid]!.custom = {excelmanusObjects:{charts:[],images:[]}};
  const out = importXlsx(exportXlsx(imported,deleted),"qa.xlsx");
  expect(objectsOf(out.snapshot.sheets[sid]).images).toHaveLength(0);
  const restored = importXlsx(exportXlsx(out,original,deleted),"qa.xlsx");
  expect(objectsOf(restored.snapshot.sheets[sid]).images).toEqual(objectsOf(original.sheets[sid]).images);
});
