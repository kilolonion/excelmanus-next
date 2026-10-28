import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { minimalXlsx, exportXlsx } from "../src/checkpoint.ts";
import { importXlsx } from "../src/xlsx.ts";
import { preservedMetadata } from "../src/objects.ts";
test("preserved note catalogue reads xml:space and rich text runs", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const parts = {
    "xl/comments1.xml": encode(
      '<comments><commentList><comment ref="A1"><text><t xml:space="preserve">待复核\n第二行</t></text></comment><comment ref="B2"><text><r><t xml:space="preserve">甲 </t></r><r><t>乙</t></r></text></comment></commentList></comments>',
    ),
  };
  expect(preservedMetadata(parts).comments.map((c) => c.text)).toEqual(["待复核\n第二行", "甲 乙"]);
});
test("notes survive XLSX roundtrip, editing and removal without changing cells", () => {
  const snap = importCsv(new TextEncoder().encode("a,b\n1,2"), "qa.csv").snapshot;
  const sid = snap.sheetOrder[0]!;
  snap.sheets[sid]!.custom = {
    excelmanusObjects: {
      charts: [],
      images: [],
      notes: [{ ref: "A1", text: "  中文 < & >\n第二行  ", author: "测试" }],
    },
  };
  const first = importXlsx(minimalXlsx(snap), "qa.xlsx");
  const id = first.snapshot.sheetOrder[0]!;
  expect((first.snapshot.sheets[id]!.custom?.excelmanusObjects as any)?.notes).toEqual([
    { ref: "A1", text: "  中文 < & >\n第二行  ", author: "测试" },
  ]);
  const changed = structuredClone(first.snapshot);
  (changed.sheets[id]!.custom!.excelmanusObjects as any).notes[0].text = "改后的备注";
  const second = importXlsx(exportXlsx(first, changed), "qa.xlsx");
  expect((second.snapshot.sheets[id]!.custom?.excelmanusObjects as any).notes[0].text).toBe(
    "改后的备注",
  );
  (changed.sheets[id]!.custom!.excelmanusObjects as any).notes = [];
  const third = importXlsx(exportXlsx(second, changed), "qa.xlsx");
  expect((third.snapshot.sheets[id]!.custom?.excelmanusObjects as any)?.notes ?? []).toEqual([]);
  expect(third.snapshot.sheets[id]!.cellData).toEqual(first.snapshot.sheets[id]!.cellData);
});
