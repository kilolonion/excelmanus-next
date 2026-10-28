import type { FWorkbook } from "@univerjs/sheets/facade";
import { expect, test, vi } from "vitest";
import { keepEditingRoom, withEditingRoom } from "../src/lib/workbook/editing-room";
import { EditorMutationBatch } from "../src/lib/workbook/mutation-batch";
import { dropEditorThemeColor } from "../src/lib/workbook/univer-theme";

const values = (cellValue: unknown, trigger = "sheet.command.set-range-values") => ({
  id: "sheet.mutation.set-range-values",
  params: { trigger, cellValue },
});

test("theme cleanup copies only the row containing an editor theme color", () => {
  const untouched = Object.freeze({ 0: Object.freeze({ v: "keep", s: "style-id" }) });
  const changed = Object.freeze({
    0: Object.freeze({ v: "edit", s: { cl: { rgb: "#000000" } } }),
    1: Object.freeze({ v: "other" }),
  });
  const cells = Object.freeze({ 0: untouched, 1: changed });
  const result = dropEditorThemeColor(values(cells));
  const cleaned = result.params.cellValue as typeof cells;
  expect(cleaned[0]).toBe(untouched);
  expect(cleaned[1]).not.toBe(changed);
  expect(cleaned[1][1]).toBe(changed[1]);
  expect(cleaned[1][0]).toEqual({ v: "edit" });
  expect(changed[0].s).toEqual({ cl: { rgb: "#000000" } });
});

test("ordinary values and explicit formatting retain the original mutation", () => {
  const cells = {
    0: {
      0: { v: 1 },
      1: null,
      2: { s: "named" },
      3: { s: { cl: { rgb: "#123456" } } },
      4: { s: { cl: { rgb: "#000000" }, bl: 1 } },
    },
  };
  const mutation = values(cells);
  expect(dropEditorThemeColor(mutation)).toBe(mutation);
  const paste = values({ 0: { 0: { s: { cl: { rgb: "#000000" } } } } }, "sheet.command.paste");
  expect(dropEditorThemeColor(paste)).toBe(paste);
});

test("non-size remote mutations never create a worksheet facade", () => {
  const lookup = vi.fn(() => null);
  const workbook = { getSheetBySheetId: lookup } as unknown as FWorkbook;
  for (const id of [
    "sheet.mutation.set-range-values",
    "sheet.mutation.insert-row",
    "sheet.mutation.set-style",
    "excelmanus.mutation.set-sheet-objects",
  ]) {
    const params = { subUnitId: "s", cellValue: { 0: { 0: { v: 1 } } } };
    expect(keepEditingRoom(workbook, id, params)).toBe(params);
  }
  expect(lookup).not.toHaveBeenCalled();
});

test("dimension mutations preserve editing room without changing other fields", () => {
  const sheet = { getMaxRows: () => 150, getMaxColumns: () => 36 };
  const lookup = vi.fn((id: string) => (id === "s" ? sheet : null));
  const workbook = { getSheetBySheetId: lookup } as unknown as FWorkbook;
  const rows = { subUnitId: "s", rowCount: 100, extra: "keep" };
  expect(keepEditingRoom(workbook, "sheet.mutation.set-worksheet-row-count", rows)).toEqual({
    ...rows,
    rowCount: 150,
  });
  expect(rows.rowCount).toBe(100);
  expect(
    keepEditingRoom(workbook, "sheet.mutation.set-worksheet-column-count", {
      subUnitId: "s",
      columnCount: 60,
    }),
  ).toEqual({ subUnitId: "s", columnCount: 60 });
  const missing = { subUnitId: "missing", rowCount: 100 };
  expect(keepEditingRoom(workbook, "sheet.mutation.set-worksheet-row-count", missing)).toBe(
    missing,
  );
});

test("batched submission still detaches shared rows from subsequent editor changes", async () => {
  const send = vi.fn(),
    batch = new EditorMutationBatch(send);
  const cells = {
    0: { 0: { v: "original" } },
    1: { 0: { v: "edited", s: { cl: { rgb: "#000000" } } } },
  };
  batch.push(dropEditorThemeColor(values(cells)), 7);
  cells[0][0].v = "later";
  cells[1][0].v = "later edited";
  await Promise.resolve();
  expect(send.mock.calls[0][0][0].params.cellValue).toEqual({
    0: { 0: { v: "original" } },
    1: { 0: { v: "edited" } },
  });
  expect(send.mock.calls[0][1]).toBe(7);
});

test("initial workbook preparation still detaches cells and honors sparse extents", () => {
  const snapshot = {
    sheets: { s: { rowCount: 10, columnCount: 10, cellData: { 200: { 60: { v: "original" } } } } },
  };
  const prepared = withEditingRoom(snapshot);
  expect(prepared.sheets.s.rowCount).toBe(251);
  expect(prepared.sheets.s.columnCount).toBe(71);
  const preparedCells = prepared.sheets.s.cellData;
  if (!preparedCells) throw new Error("missing cell data");
  preparedCells[200][60].v = "editor value";
  expect(snapshot.sheets.s.cellData[200][60].v).toBe("original");
});
