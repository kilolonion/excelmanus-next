import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";
test("axis.size accepts pixels alias only with pixel mode and compiles to the same command", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("n\n1\n"), "a.csv");
  const input = {
    op: "axis.size",
    sheet: snapshot.sheetOrder[0],
    axis: "cols",
    at: 1,
    count: 1,
    mode: "pixels",
  };
  const run = (fields: object) =>
    compileOps({ snapshot, unitId: snapshot.id }, [ChangeOp.parse({ ...input, ...fields })])
      .commands[0]?.params;
  expect(run({ pixels: 140 })).toEqual(run({ value: 140 }));
  expect(ChangeOp.safeParse({ ...input, value: 140, pixels: 120 }).success).toBe(false);
  expect(ChangeOp.safeParse({ ...input, mode: "scale", pixels: 140 }).success).toBe(false);
  expect(ChangeOp.safeParse({ ...input }).success).toBe(false);
  expect(ChangeOp.safeParse({ ...input, mode: "scale", value: 1.5 }).success).toBe(true);
  expect(ChangeOp.safeParse({ ...input, mode: "auto" }).success).toBe(true);
});
