import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { previewBackup } from "../src/backup-preview.ts";

test("backup preview reads paged CSV content without creating a live document", () => {
  const bytes = new TextEncoder().encode("地区,销量\n东,30\n西,20\n");
  const before = bytes.slice();
  const result = previewBackup("测试.csv", bytes, {});
  expect(result.kind).toBe("spreadsheet");
  if (result.kind !== "spreadsheet") throw new Error("expected spreadsheet");
  expect(result.sheets[0]).toMatchObject({ rows: 3, columns: 2 });
  expect(result.layout.cells.map((c) => c.text)).toContain("东");
  const page = previewBackup("测试.csv", bytes, { row: 2 });
  expect(page.kind === "spreadsheet" && page.layout.cells.some((c) => c.text === "西")).toBe(true);
  expect(bytes).toEqual(before);
});

test("unsupported backups explain the download fallback", () => {
  expect(previewBackup("legacy.xls", new Uint8Array(), {}).kind).toBe("unsupported");
});

test("a preview page starting inside a merged cell retains its anchor text", () => {
  const bytes = readFileSync(new URL("../../../samples/sales.xlsx", import.meta.url));
  const page = previewBackup("sales.xlsx", bytes, { column: 2 });
  expect(
    page.kind === "spreadsheet" && page.layout.cells.some((c) => c.text === "销售明细表"),
  ).toBe(true);
});
