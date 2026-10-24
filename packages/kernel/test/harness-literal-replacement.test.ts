import { expect, test } from "vitest";
import { literalReplacementRanges } from "../src/tools.ts";
test("replacement proof requires dense literal values and resolved physical sheet", () => {
  const op = {
    op: "cells.set",
    range: "Sheet1!A1",
    values: [
      [null, 1],
      ["text", false],
    ],
  };
  expect(literalReplacementRanges([op], ["Sheet1!A1:B2"])).toEqual(["'Sheet1'!A1:B2"]);
  const sparseRows = new Array<unknown>(2);
  sparseRows[1] = [1];
  const sparseCells = new Array<unknown>(2);
  sparseCells[1] = 1;
  expect(0 in sparseRows).toBe(false);
  expect(0 in sparseCells).toBe(false);
  for (const values of [sparseRows, [sparseCells], [[{ f: "A1" }]], [["=A1"]], [[1], [2, 3]]])
    expect(literalReplacementRanges([{ ...op, values }], ["Sheet1!A1:B2"])).toEqual([]);
  expect(literalReplacementRanges([{ ...op, range: "A1" }], ["A1:B2"])).toEqual([]);
  expect(
    literalReplacementRanges([{ ...op, range: "A1" }], ["Sheet1!A1:B2", "Other!A1:B2"]),
  ).toEqual([]);
});
