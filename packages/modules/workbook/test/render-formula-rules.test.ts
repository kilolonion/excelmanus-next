import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { conditionalPaint } from "../src/render-conditions.ts";
import { renderRuleFormula } from "../src/render-rule-formula.ts";
import { CF_RESOURCE, setRulesResource } from "../src/rule-codec.ts";

test("formula highlights track row references, blank guards and live values", () => {
  const sheet = {
    id: "s",
    cellData: {
      1: { 2: { v: "进行中" }, 4: { v: 1000 }, 5: { v: 1200 } },
      2: { 2: { v: "已完成" }, 4: { v: 800 }, 5: { v: 750 } },
    },
  } as unknown as IWorksheetData;
  const book = { sheets: { s: sheet } } as unknown as IWorkbookData;
  setRulesResource(book, CF_RESOURCE, {
    s: [
      {
        ranges: [{ startRow: 1, endRow: 99, startColumn: 5, endColumn: 5 }],
        rule: {
          type: "highlightCell",
          subType: "formula",
          value: '=AND($F2<>"",$E2<>"",$F2>$E2)',
          style: { bg: { rgb: "#ff0000" } },
        },
      },
      {
        ranges: [{ startRow: 1, endRow: 99, startColumn: 0, endColumn: 5 }],
        rule: {
          type: "highlightCell",
          subType: "formula",
          value: '=$C2="已完成"',
          style: { bg: { rgb: "#00ff00" } },
        },
      },
    ],
  });
  const warnings: string[] = [];
  const paint = conditionalPaint(book, sheet, warnings);
  expect(paint(1, 5, 1200).style?.bg.rgb).toBe("#ff0000");
  for (let c = 0; c < 6; c++)
    expect(paint(2, c, sheet.cellData?.[2]?.[c]?.v).style?.bg.rgb).toBe("#00ff00");
  expect(paint(3, 5, undefined).style).toBeUndefined();
  sheet.cellData![1]![5]!.v = 900;
  expect(conditionalPaint(book, sheet, [])(1, 5, 900).style).toBeUndefined();
  expect(warnings).toEqual([]);
});

test("predicate rendering respects mixed references, logical guards and unsupported expressions", () => {
  const sheet = {
    cellData: {
      0: { 0: { v: 10 } },
      1: { 0: { v: 20 }, 1: { v: 'a,b"c' } },
      2: { 1: { v: 30 }, 2: { v: 40 } },
    },
  } as unknown as IWorksheetData;
  const origin = { startRow: 1, startColumn: 0 };
  expect(renderRuleFormula("=A2>$A$1", sheet, origin)?.(2, 1)).toBe(true);
  expect(renderRuleFormula("=A$2=$A2", sheet, origin)?.(1, 0)).toBe(true);
  expect(renderRuleFormula('=OR(B2="A,B""C",NOT(A2>0))', sheet, origin)?.(1, 0)).toBe(true);
  for (const source of ["=SUM(A1:A5)>1", "='其他表'!A1>0", "=A1+1>0", "=AND(A1>0,UNKNOWN(A1))"])
    expect(renderRuleFormula(source, sheet, origin)).toBeUndefined();
});

test("ISNUMBER guards render numeric conditional highlights without losing row priority", () => {
  const sheet = {
    id: "s",
    cellData: {
      1: { 1: { v: "完成" }, 4: { v: 800 } },
      2: { 1: { v: "完成" }, 4: { v: "800" } },
      3: { 1: { v: "完成" }, 4: { v: 1, t: 3 } },
    },
  } as unknown as IWorksheetData;
  const book = { sheets: { s: sheet } } as unknown as IWorkbookData;
  setRulesResource(book, CF_RESOURCE, {
    s: [
      {
        ranges: [{ startRow: 1, endRow: 19, startColumn: 4, endColumn: 4 }],
        rule: {
          type: "highlightCell",
          subType: "formula",
          value: "=AND(ISNUMBER($E2),$E2>500)",
          style: { bg: { rgb: "#ff0000" } },
        },
      },
      {
        ranges: [{ startRow: 1, endRow: 19, startColumn: 0, endColumn: 4 }],
        rule: {
          type: "highlightCell",
          subType: "formula",
          value: '=$B2="完成"',
          style: { bg: { rgb: "#00ff00" } },
        },
      },
    ],
  });
  const warnings: string[] = [];
  const paint = conditionalPaint(book, sheet, warnings);
  expect(paint(1, 4, 800).style?.bg.rgb).toBe("#ff0000");
  expect(paint(1, 0, undefined).style?.bg.rgb).toBe("#00ff00");
  expect(paint(2, 4, "800").style?.bg.rgb).toBe("#00ff00");
  expect(paint(3, 4, true).style?.bg.rgb).toBe("#00ff00");
  expect(paint(4, 4, undefined).style).toBeUndefined();
  expect(warnings).toEqual([]);
  const origin = { startRow: 1, startColumn: 4 };
  expect(renderRuleFormula("=ISNUMBER($E2)", sheet, origin)?.(4, 4)).toBe(false);
  expect(renderRuleFormula('=ISNUMBER("800")', sheet, origin)?.(1, 4)).toBe(false);
  for (const source of ["=ISNUMBER()", "=ISNUMBER(1,2)", "=ISNUMBER(UNKNOWN(1))"])
    expect(renderRuleFormula(source, sheet, origin)).toBeUndefined();
});
