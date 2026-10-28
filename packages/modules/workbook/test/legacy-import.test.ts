import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { read, utils, write } from "xlsx";
import { importLegacyFile } from "../src/legacy-import.ts";
import { importXlsx } from "../src/xlsx.ts";

test.each(["biff8", "xlsb"] as const)(
  "imports %s into a new xlsx without changing source",
  (bookType) => {
    const root = mkdtempSync(join(tmpdir(), "legacy-import-"));
    try {
      const wb = utils.book_new();
      const sheet = utils.aoa_to_sheet([
        ["项目", "数量"],
        ["苹果", 2],
        ["合计", 2],
      ]);
      sheet.B3 = { t: "n", v: 2, f: "SUM(B2:B2)", z: "0.00" };
      sheet["!merges"] = [{ s: { r: 4, c: 0 }, e: { r: 4, c: 1 } }];
      utils.book_append_sheet(wb, sheet, "明细");
      const source = bookType === "xlsb" ? "sample.xlsb" : "sample.xls";
      const bytes = write(wb, { bookType, type: "buffer" });
      writeFileSync(join(root, source), bytes);
      const result = importLegacyFile(root, source, "imported.xlsx");
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(readFileSync(join(root, source))).toEqual(Buffer.from(bytes));
      const output = read(readFileSync(join(root, result.path)), { type: "buffer", cellNF: true });
      expect(output.Sheets["明细"]?.A2?.v).toBe("苹果");
      const sourceBook = read(Buffer.from(bytes), { type: "buffer", cellFormula: true });
      expect(output.Sheets["明细"]?.B3?.f).toBe(sourceBook.Sheets["明细"]?.B3?.f);
      expect(output.Sheets["明细"]?.B3?.v).toBe(2);
      expect(output.Sheets["明细"]?.B3?.z).toBe("0.00");
      expect(output.Sheets["明细"]?.["!merges"]).toHaveLength(1);
      expect(
        importXlsx(readFileSync(join(root, result.path)), result.path).snapshot.sheetOrder,
      ).toHaveLength(1);
      expect(() => importLegacyFile(root, source, "imported.xlsx")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
