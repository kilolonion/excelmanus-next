import { DataValidationErrorStyle } from "@univerjs/core";
import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";
import { DV_RESOURCE, rulesResource, setRulesResource } from "../src/rule-codec.ts";
import { importXlsx } from "../src/xlsx.ts";

test.each([
  DataValidationErrorStyle.STOP,
  DataValidationErrorStyle.WARNING,
  DataValidationErrorStyle.INFO,
])("error style %s roundtrips through OOXML", (errorStyle) => {
  const original = importXlsx(
    minimalXlsx(importCsv(new TextEncoder().encode("数量\n2"), "a.csv").snapshot),
    "a.xlsx",
  );
  const snapshot = structuredClone(original.snapshot);
  const sid = snapshot.sheetOrder[0]!;
  setRulesResource(snapshot, DV_RESOURCE, {
    [sid]: [
      {
        uid: "number",
        type: "whole",
        operator: "between",
        formula1: "2",
        formula2: "8",
        errorStyle,
        ranges: [{ startRow: 1, endRow: 4, startColumn: 0, endColumn: 0 }],
      },
    ],
  });
  const reopened = importXlsx(exportXlsx(original, snapshot), "a.xlsx");
  expect(rulesResource(reopened.snapshot, DV_RESOURCE)[sid]![0]!.errorStyle).toBe(errorStyle);
});

test("list validation uses Univer STOP without a numeric comparison and exports OOXML stop", () => {
  const original = importXlsx(
    minimalXlsx(importCsv(new TextEncoder().encode("状态\n待处理"), "a.csv").snapshot),
    "a.xlsx",
  );
  const snapshot = structuredClone(original.snapshot);
  const compiled = compileOps({ snapshot, unitId: snapshot.id }, [
    ChangeOp.parse({
      op: "dv.add",
      range: "A2:A5",
      type: "list",
      formula1: "待处理,完成",
      allowBlank: true,
    }),
  ]);
  const sid = snapshot.sheetOrder[0]!;
  const rule = (compiled.commands[0]!.params as { rule: Record<string, unknown> }).rule;
  setRulesResource(snapshot, DV_RESOURCE, { [sid]: [rule] });
  expect(rule.errorStyle).toBe(DataValidationErrorStyle.STOP);
  expect(rule.operator).toBeUndefined();
  const bytes = exportXlsx(original, snapshot);
  const xml = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
  expect(xml).toContain('errorStyle="stop"');
  expect(xml.match(/<dataValidation\s[^>]+>/)?.[0]).not.toContain("operator=");
  const reopened = rulesResource(importXlsx(bytes, "a.xlsx").snapshot, DV_RESOURCE)[sid]![0]!;
  expect(reopened.errorStyle).toBe(DataValidationErrorStyle.STOP);
  expect(reopened.operator).toBeUndefined();
});
