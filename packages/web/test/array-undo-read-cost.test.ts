import { ARRAY_STATE_MUTATION } from "@excelmanus/protocol";
import { ICommandService, IUndoRedoService } from "@univerjs/core";
import { expect, test, vi } from "vitest";
import { editTable } from "../src/lib/workbook/table-edit";

test("array undo captures independent current metadata without saving the workbook", () => {
  const array = {
    id: "a",
    mode: "fixed",
    formula: "=1",
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
  };
  const data = { custom: { excelmanusArrays: [array] } };
  const save = vi.fn(() => ({ sheets: { s: structuredClone(data) } }));
  const pushUndoRedo = vi.fn();
  let handler: (accessor: any, input: any) => boolean;
  const commands = {
    registerCommand: (c: any) => {
      handler = c.handler;
    },
    syncExecuteCommand: (id: string, params: any): boolean => {
      if (id === "excelmanus.command.edit-table") return handler(accessor, params);
      return true;
    },
  };
  const accessor = {
    get: (token: unknown): any =>
      token === ICommandService
        ? commands
        : token === IUndoRedoService
          ? { pushUndoRedo }
          : undefined,
  };
  const api = {
    univer: { __getInjector: () => accessor },
    wb: {
      getId: () => "unit",
      save,
      getSheetBySheetId: () => ({ getSheet: () => ({ getSnapshot: () => data }) }),
    },
  };
  const mutations = [
    { id: ARRAY_STATE_MUTATION, params: { unitId: "unit", subUnitId: "s", arrays: [] } },
  ];
  expect(editTable(api as unknown as Parameters<typeof editTable>[0], mutations)).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(pushUndoRedo).toHaveBeenCalledOnce();
  const undo = pushUndoRedo.mock.calls[0][0];
  expect(undo.undoMutations[0].params.arrays).toEqual([array]);
  array.formula = "=99";
  expect(undo.undoMutations[0].params.arrays[0].formula).toBe("=1");
  expect(undo.redoMutations).toBe(mutations);
});
