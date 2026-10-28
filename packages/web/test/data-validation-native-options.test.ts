import { DataValidationErrorStyle, type IDataValidationRule } from "@univerjs/core";
import { ListValidator } from "@univerjs/sheets-data-validation";
import { expect, test } from "vitest";
import { keepEditingRoom, withEditingRoom } from "../src/lib/workbook/editing-room";

// Run Univer's real list validator; only the unused formula service has no live workbook.
const validator = Object.assign(Object.create(ListValidator.prototype) as ListValidator, {
  formulaService: { getRuleFormulaResult: async () => undefined },
});
const legacy = {
  uid: "list",
  type: "list",
  operator: "between",
  formula1: "待处理,处理中,完成,取消",
  errorStyle: "stop",
  showErrorMessage: true,
  ranges: [],
};
const cell = {
  unitId: "book",
  subUnitId: "sheet",
  row: 0,
  column: 0,
  value: "待处理",
} as Parameters<ListValidator["validator"]>[0];

test("legacy list rules accept real choices and keep the editor STOP rejection gate enabled", async () => {
  expect(await validator.validator(cell, legacy as unknown as IDataValidationRule)).toBe(false);
  const original = {
    sheets: {},
    resources: [
      { name: "SHEET_DATA_VALIDATION_PLUGIN", data: JSON.stringify({ sheet: [legacy] }) },
    ],
  };
  const normalized = withEditingRoom(original);
  const rule = JSON.parse(normalized.resources![0]!.data).sheet[0] as IDataValidationRule;
  expect(rule.errorStyle).toBe(DataValidationErrorStyle.STOP);
  expect(rule.showErrorMessage).toBe(true);
  expect(await validator.validator(cell, rule)).toBe(true);
  expect(await validator.validator({ ...cell, value: "无效选项" }, rule)).toBe(false);
  expect(JSON.parse(original.resources[0]!.data).sheet[0]).toEqual(legacy);
});

test("replayed legacy rules normalize without mutating the remote revision", () => {
  const params = { rule: { ...legacy } };
  const mapped = keepEditingRoom(
    {} as Parameters<typeof keepEditingRoom>[0],
    "data-validation.mutation.addRule",
    params,
  ) as typeof params;
  expect(mapped.rule.errorStyle).toBe(DataValidationErrorStyle.STOP);
  expect(mapped.rule.operator).toBeUndefined();
  expect(params.rule).toEqual(legacy);
});
