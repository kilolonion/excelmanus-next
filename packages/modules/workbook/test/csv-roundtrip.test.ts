import { expect, test } from "vitest";
import { exportCsv, importCsv } from "../src/csv.ts";

test("comma CSV is not split on denser punctuation inside fields", () => {
  const input = "编号,备注\r\n00021,甲;乙;丙;丁\r\n00022,戊;己;庚;辛\r\n00023,壬;癸;甲;乙\r\n";
  const parsed = importCsv(new TextEncoder().encode(input), "notes.csv");
  expect(parsed.csv?.delimiter).toBe(",");
  const sheet = parsed.snapshot.sheets.s0!;
  expect(sheet.columnCount).toBe(2);
  expect(sheet.cellData?.[1]?.[0]?.v).toBe("00021");
  expect(sheet.cellData?.[1]?.[1]?.v).toBe("甲;乙;丙;丁");
  expect(new TextDecoder().decode(exportCsv(parsed.snapshot, parsed.csv))).toBe(input);
});

test.each([",", ";", "\t", "|"])(
  "%s sniffing counts logical records through escaped quotes and newlines",
  (delimiter) => {
    const input = [
      "id" + delimiter + "note",
      "0001" + delimiter + '"line 1\nline 2, ; |\nline 3"',
      "0002" + delimiter + '"a""b"',
      "0003" + delimiter + "done",
    ].join("\r\n");
    const parsed = importCsv(new TextEncoder().encode(input), "sample.csv");
    expect(parsed.csv?.delimiter).toBe(delimiter);
    expect(parsed.snapshot.sheets.s0?.cellData?.[2]?.[1]?.v).toBe('a"b');
  },
);
