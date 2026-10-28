import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { namesOf } from "../src/defined-names.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource, setRulesResource } from "../src/rule-codec.ts";
import { importXlsx } from "../src/xlsx.ts";

test.each(["Sheet1!A2:A3", "Sheet1!$A$2:$A$3"])(
  "named validation source %s compiles and replaces by name",
  (range) => {
    const snapshot = importCsv(new TextEncoder().encode("状态\n进行中\n已完成"), "a.csv").snapshot;
    const op = ChangeOp.parse({ op: "name.set", name: "StatusChoices", range });
    const compiled = compileOps({ snapshot, unitId: snapshot.id }, [op, op]);
    expect(compiled.commands).toHaveLength(2);
    expect(compiled.commands[0]).toMatchObject({
      id: "formula.mutation.set-defined-name",
      params: { name: "StatusChoices", formulaOrRefString: "'Sheet1'!$A$2:$A$3" },
    });
    expect(compiled.commands[0]!.params.id).toBe(compiled.commands[1]!.params.id);
    expect(namesOf(snapshot)).toEqual({});
  },
);

test.each(["='选项'!$A$1:$A$3", "=StatusChoices"])(
  "list source %s survives reopening and a later validation edit",
  (formula1) => {
    const original = importXlsx(
      minimalXlsx(importCsv(new TextEncoder().encode("状态\n进行中\n"), "a.csv").snapshot),
      "a.xlsx",
    );
    const book = structuredClone(original.snapshot);
    const sid = book.sheetOrder[0]!;
    setRulesResource(book, DV_RESOURCE, {
      [sid]: [
        {
          uid: "status",
          type: "list",
          formula1,
          ranges: [{ startRow: 1, endRow: 10, startColumn: 0, endColumn: 0 }],
          showDropDown: true,
        },
      ],
    });
    const once = importXlsx(exportXlsx(original, book), "a.xlsx");
    expect(rulesResource(once.snapshot, DV_RESOURCE)[sid]?.[0]?.formula1).toBe(formula1);
    const edited = structuredClone(once.snapshot);
    const rules = rulesResource(edited, DV_RESOURCE);
    rules[sid]![0]!.error = "请选择状态";
    setRulesResource(edited, DV_RESOURCE, rules);
    const twice = importXlsx(exportXlsx(once, edited), "a.xlsx");
    expect(rulesResource(twice.snapshot, DV_RESOURCE)[sid]?.[0]?.formula1).toBe(formula1);
  },
);

test("solid conditional fills export without a competing indexed background color", () => {
  const original = importXlsx(
    minimalXlsx(importCsv(new TextEncoder().encode("金额\n800\n"), "a.csv").snapshot),
    "a.xlsx",
  );
  const book = structuredClone(original.snapshot);
  const sid = book.sheetOrder[0]!;
  setRulesResource(book, CF_RESOURCE, {
    [sid]: [
      {
        cfId: "amount-red",
        ranges: [{ startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 }],
        rule: {
          type: "highlightCell",
          subType: "number",
          operator: "greaterThan",
          value: 500,
          style: { bg: { rgb: "#FFC7CE" } },
        },
      },
    ],
  });
  const bytes = exportXlsx(original, book);
  const xml = strFromU8(unzipSync(bytes)["xl/styles.xml"]!);
  const dxfs = xml.match(/<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/)?.[1];
  expect(dxfs).toContain('<fgColor rgb="FFFFC7CE"/>');
  expect(dxfs).not.toContain("<bgColor");
  const reopened = importXlsx(bytes, "a.xlsx");
  expect(rulesResource(reopened.snapshot, CF_RESOURCE)[sid]?.[0]?.rule.style.bg.rgb).toBe(
    "#FFC7CE",
  );
});
