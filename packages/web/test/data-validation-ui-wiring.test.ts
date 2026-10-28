import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("../src/components/excel/UniverSheet.tsx", import.meta.url),
  "utf8",
);

test("workbook editor registers data validation UI with styles and Chinese locale", () => {
  expect(source).toContain(
    'import { UniverSheetsDataValidationUIPlugin } from "@univerjs/sheets-data-validation-ui"',
  );
  expect(source).toContain('import "@univerjs/sheets-data-validation-ui/lib/index.css"');
  expect(source).toContain('import dvZhCN from "@univerjs/sheets-data-validation-ui/locale/zh-CN"');
  expect(source).toMatch(
    /plugins:\s*\[[\s\S]*?UniverSheetsDataValidationPlugin,\s*UniverSheetsDataValidationUIPlugin,/,
  );
  expect(source).toMatch(/mergeLocales\([^)]*dvZhCN/);
});
