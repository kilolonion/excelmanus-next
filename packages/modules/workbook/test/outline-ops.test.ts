import { AXIS_GROUP_MUTATION, AxisGroupMutation } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { bootUniver, createBook, MutationCapture } from "../src/engine.ts";
import { makeInverse } from "../src/inverse.ts";
import { ChangeOp, compileOps, transformChangeOp, transformMutation } from "../src/ops.ts";

const collapse = {
  op: "axis.collapse",
  sheet: "Sheet1",
  axis: "rows",
  at: 9,
  count: 1,
  collapsed: false,
};

test("collapse has its own bounded operation and mutation map, independent of hidden and level", () => {
  expect(ChangeOp.safeParse(collapse).success).toBe(true);
  expect(ChangeOp.safeParse({ ...collapse, hidden: false }).success).toBe(false);
  expect(ChangeOp.safeParse({ ...collapse, at: 0 }).success).toBe(false);
  expect(ChangeOp.safeParse({ ...collapse, count: 10001 }).success).toBe(false);
  expect(
    AxisGroupMutation.safeParse({
      unitId: "book",
      subUnitId: "sheet",
      axis: "rows",
      collapsed: { 8: false },
    }).success,
  ).toBe(true);
  expect(
    AxisGroupMutation.safeParse({ unitId: "book", subUnitId: "sheet", axis: "rows" }).success,
  ).toBe(false);
});

test("collapse compiles and rebases both public operations and direct metadata mutations", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("值\n1"), "outline.csv");
  const sid = snapshot.sheetOrder[0]!;
  const op = ChangeOp.parse({ ...collapse, sheet: sid });
  const result = compileOps({ snapshot, unitId: snapshot.id }, [op]);
  expect(result.commands).toEqual([
    {
      id: AXIS_GROUP_MUTATION,
      params: { unitId: snapshot.id, subUnitId: sid, axis: "rows", collapsed: { 8: false } },
    },
  ]);
  const structure = [{ sheetId: sid, kind: "insertRows" as const, index: 1, count: 2 }];
  expect(transformChangeOp(op, structure, () => sid)).toMatchObject({ at: 11 });
  expect(
    transformMutation(
      {
        id: AXIS_GROUP_MUTATION,
        params: {
          unitId: snapshot.id,
          subUnitId: sid,
          axis: "rows",
          levels: { 2: 1, 3: 2 },
          collapsed: { 8: false },
        },
      },
      structure,
    ),
  ).toMatchObject({ params: { levels: { 4: 1, 5: 2 }, collapsed: { 10: false } } });
});

test("collapse mutation preserves nested levels, independent hiding and custom through undo and replay", async () => {
  const { snapshot } = importCsv(new TextEncoder().encode("值\n1"), "outline.csv");
  const sid = snapshot.sheetOrder[0]!;
  const sheet = snapshot.sheets[sid]!;
  sheet.rowData = {
    2: { hd: 1, custom: { excelmanusOutlineLevel: 1, vendor: "keep" } },
    3: { hd: 1, custom: { excelmanusOutlineLevel: 2 } },
    8: { hd: 1, custom: { excelmanusOutlineLevel: 1, excelmanusCollapsed: true, vendor: "keep" } },
    11: { hd: 1 },
  };
  sheet.columnData = {
    4: { hd: 1, custom: { excelmanusOutlineLevel: 2, excelmanusCollapsed: true, vendor: "col" } },
  };
  const boot = bootUniver();
  try {
    const book = createBook(boot, snapshot);
    const before = book.workbook.save();
    const capture = new MutationCapture(boot);
    capture.begin();
    for (const axis of ["rows", "cols"]) {
      expect(
        await boot.executeCommand(AXIS_GROUP_MUTATION, {
          unitId: book.unitId,
          subUnitId: sid,
          axis,
          collapsed: { [axis === "rows" ? 8 : 4]: false },
        }),
      ).toBe(true);
    }
    const mutations = capture.end();
    const after = book.workbook.save();
    expect(after.sheets[sid]?.rowData?.[8]).toMatchObject({
      hd: 1,
      custom: { excelmanusOutlineLevel: 1, vendor: "keep" },
    });
    expect(after.sheets[sid]?.rowData?.[8]?.custom).not.toHaveProperty("excelmanusCollapsed");
    expect(after.sheets[sid]?.columnData?.[4]?.custom).toEqual({
      excelmanusOutlineLevel: 2,
      vendor: "col",
    });
    expect(after.sheets[sid]?.rowData?.[2]).toEqual(before.sheets[sid]?.rowData?.[2]);
    expect(after.sheets[sid]?.rowData?.[3]).toEqual(before.sheets[sid]?.rowData?.[3]);
    expect(after.sheets[sid]?.rowData?.[11]).toEqual(before.sheets[sid]?.rowData?.[11]);
    const { inverse } = makeInverse(before, after, mutations, book.unitId);
    for (const mutation of inverse) await boot.executeCommand(mutation.id, mutation.params);
    expect(book.workbook.save().sheets[sid]?.rowData?.[8]).toEqual(
      before.sheets[sid]?.rowData?.[8],
    );
    expect(book.workbook.save().sheets[sid]?.columnData?.[4]).toEqual(
      before.sheets[sid]?.columnData?.[4],
    );
    for (const mutation of mutations) await boot.executeCommand(mutation.id, mutation.params);
    expect(book.workbook.save().sheets[sid]?.rowData?.[8]).toEqual(after.sheets[sid]?.rowData?.[8]);
    expect(
      await boot.executeCommand(AXIS_GROUP_MUTATION, {
        unitId: book.unitId,
        subUnitId: sid,
        axis: "cols",
        collapsed: { 4: true, 16384: true },
      }),
    ).toBe(false);
    expect(book.workbook.save().sheets[sid]?.columnData?.[4]).toEqual(
      after.sheets[sid]?.columnData?.[4],
    );
  } finally {
    await boot.dispose();
  }
}, 60000);

test("rows inserted outside a group are blank, visible and use default metadata rather than the summary row", async () => {
  const { snapshot } = importCsv(new TextEncoder().encode("值\n1"), "outline.csv");
  const sid = snapshot.sheetOrder[0]!;
  const sheet = snapshot.sheets[sid]!;
  sheet.rowCount = 20;
  sheet.rowData = {
    7: { hd: 1, custom: { excelmanusOutlineLevel: 2 } },
    8: { h: 48, hd: 1, custom: { excelmanusCollapsed: true, vendor: "summary" } },
    9: { h: 36, custom: { vendor: "following" } },
  };
  sheet.cellData![8] = { 0: { v: "汇总" } };
  sheet.cellData![9] = { 0: { v: "之后" } };
  const boot = bootUniver();
  try {
    const book = createBook(boot, snapshot);
    const before = book.workbook.save();
    const compiled = compileOps({ snapshot: before, unitId: book.unitId }, [
      ChangeOp.parse({ op: "rows.insert", sheet: sid, at: 10, count: 2 }),
    ]);
    for (const command of compiled.commands)
      expect(await boot.executeCommand(command.id, command.params)).toBe(true);
    const after = book.workbook.save().sheets[sid]!;
    for (const row of [9, 10]) {
      expect(after.rowData?.[row] ?? {}).toEqual({});
      expect(after.cellData?.[row] ?? {}).toEqual({});
    }
    expect(after.rowData?.[8]).toEqual(before.sheets[sid]?.rowData?.[8]);
    expect(after.rowData?.[11]).toEqual(before.sheets[sid]?.rowData?.[9]);
    expect(after.cellData?.[11]?.[0]?.v).toBe("之后");
  } finally {
    await boot.dispose();
  }
}, 60000);
