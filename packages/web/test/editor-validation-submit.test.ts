import { isDerivedWorkbookMutation } from "@excelmanus/core";
import type { ICellData, IDocumentData, IRange, IUniverInstanceService } from "@univerjs/core";
import { EditingRenderController } from "@univerjs/preset-sheets-core";
import { SheetInterceptorService, VALIDATE_CELL } from "@univerjs/sheets";
import { EMPTY } from "rxjs";
import { expect, onTestFinished, test, vi } from "vitest";
import type { DocMutation } from "../src/lib/workbook/doc-sync";
import { EditorValidationGate } from "../src/lib/workbook/editor-validation-gate";
import { EditorMutationBatch } from "../src/lib/workbook/mutation-batch";

const SET_VALUES = "sheet.command.set-range-values";
const SET_VALUES_MUTATION = "sheet.mutation.set-range-values";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Run the shipped editor method, including real input conversion and its awaited
// validation/rollback branch. Only injected workbook and command services are stubs.
function editorFixture(origin = { row: 0, column: 0 }) {
  let dirty = true;
  let failCommand = false;
  let throwCommand = false;
  let cancelled = false;
  let validation = deferred<boolean>();
  const send = vi.fn();
  const batch = new EditorMutationBatch(send);
  const gate = new EditorValidationGate((mutation, revision) => batch.push(mutation, revision));
  let current: ICellData = { v: "original" };
  let undoId = "";
  const original = structuredClone(current);
  const undoMutations: DocMutation[] = [
    {
      id: SET_VALUES_MUTATION,
      params: {
        unitId: "book",
        subUnitId: "sheet",
        cellValue: { 0: { 0: original } },
      },
    },
    {
      id: "sheet.mutation.remove.numfmt",
      params: {
        unitId: "book",
        subUnitId: "sheet",
        ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }],
      },
    },
    {
      id: "sheet.mutation.set-worksheet-row-auto-height",
      params: {
        unitId: "book",
        subUnitId: "sheet",
        rowsAutoHeightInfo: [{ row: 0, autoHeight: 20 }],
      },
    },
  ];
  const emit = (mutation: DocMutation) => {
    gate.after(mutation);
    if (gate.isRollback(mutation) || isDerivedWorkbookMutation(mutation)) return;
    gate.push(mutation, 7);
  };
  const worksheet = {
    getSheetId: () => "sheet",
    getCellRaw: () => current,
    getComposedCellStyleWithoutSelf: () => ({}),
  };
  const workbook = {
    getUnitId: () => "book",
    getActiveSheet: () => worksheet,
    getSheetBySheetId: () => worksheet,
    getStyles: () => ({ get: (style: unknown) => style, getStyleByCell: () => ({}) }),
  };
  const rollback = vi.fn((id: string, unitId: string) => {
    expect(id).toBe(undoId);
    expect(unitId).toBe("book");
    current = structuredClone(original);
    // sequenceExecute reuses these params objects. A no-trigger values mutation
    // is derived-filtered, but numfmt and auto-height rollback siblings are not.
    for (const mutation of undoMutations) emit(mutation);
  });
  const interceptors = new SheetInterceptorService({
    getTypeOfUnitAdded$: () => EMPTY,
    getTypeOfUnitDisposed$: () => EMPTY,
  } as unknown as IUniverInstanceService);
  // InterceptorManager's next() returns only its input, not the downstream
  // async chain. Wrap onValidateCell's final promise, not an interceptor's input.
  const unbindValidation = gate.bindValidation(interceptors, () => ({ id: undoId, undoMutations }));
  interceptors.writeCellInterceptor.intercept(VALIDATE_CELL, {
    handler: async (result, _context, next) => {
      await result;
      return next(validation.promise) ?? validation.promise;
    },
  });
  onTestFinished(() => {
    unbindValidation();
    interceptors.dispose();
  });
  const onValidateCell = vi.spyOn(interceptors, "onValidateCell");
  const controller = Object.assign(Object.create(EditingRenderController.prototype), {
    _editorBridgeService: {
      getEditCellState: () => (cancelled ? null : { unitId: "book", sheetId: "sheet", ...origin }),
      getEditorDirty: () => dirty,
    },
    _univerInstanceService: { getUnit: () => workbook },
    _localService: { getCurrentLocale: () => "enUS" },
    _sheetInterceptorService: interceptors,
    _selectionManagerService: {
      getWorkbookSelections: () => ({
        getCurrentLastSelection: () => ({
          range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        }),
      }),
    },
    _commandService: {
      syncExecuteCommand: (
        id: string,
        params: { value: ICellData; redoUndoId: string; range: IRange },
      ) => {
        expect(id).toBe(SET_VALUES);
        const command = { id, params };
        gate.before(command);
        if (throwCommand) throw new Error("native command failed");
        if (failCommand) {
          gate.after(command);
          return false;
        }
        undoId = params.redoUndoId;
        current = structuredClone(params.value);
        const cellValue: Record<number, Record<number, ICellData>> = {};
        for (let row = params.range.startRow; row <= params.range.endRow; row++) {
          cellValue[row] = {};
          for (let col = params.range.startColumn; col <= params.range.endColumn; col++)
            cellValue[row][col] = structuredClone(current);
        }
        emit({
          id: SET_VALUES_MUTATION,
          params: {
            unitId: "book",
            subUnitId: "sheet",
            trigger: SET_VALUES,
            cellValue,
          },
        });
        emit({
          id: "sheet.mutation.set.numfmt",
          params: {
            unitId: "book",
            subUnitId: "sheet",
            values: { 0: { 0: { pattern: "0" } } },
          },
        });
        emit({
          id: "sheet.mutation.set-worksheet-row-auto-height",
          params: {
            unitId: "book",
            subUnitId: "sheet",
            rowsAutoHeightInfo: [{ row: 0, autoHeight: 40 }],
          },
        });
        gate.after(command);
        return true;
      },
    },
    _undoRedoService: { rollback },
  }) as { _submitEdit(snapshot: IDocumentData, wholeSelection?: boolean): Promise<boolean> };
  return {
    get validation() {
      return validation;
    },
    nextValidation: () => {
      validation = deferred<boolean>();
    },
    setCommandThrow: (value: boolean) => {
      throwCommand = value;
    },
    setCommandFailure: (value: boolean) => {
      failCommand = value;
    },
    setDirty: (value: boolean) => {
      dirty = value;
    },
    cancel: () => {
      cancelled = true;
    },
    paste: () => {
      const command = { id: SET_VALUES, params: { unitId: "book", subUnitId: "sheet" } };
      gate.before(command);
      emit({
        id: SET_VALUES_MUTATION,
        params: {
          ...command.params,
          trigger: "sheet.command.paste",
          cellValue: { 4: { 0: { v: "paste a" }, 1: { v: "paste b" } } },
        },
      });
      gate.after(command);
    },
    send,
    rollback,
    onValidateCell,
    current: () => current,
    unrelated: () =>
      emit({
        id: "sheet.mutation.set-worksheet-row-auto-height",
        params: {
          unitId: "book",
          subUnitId: "sheet",
          rowsAutoHeightInfo: [{ row: 1, autoHeight: 60 }],
        },
      }),
    submit: (value = "invalid", wholeSelection = false) =>
      controller._submitEdit(
        {
          id: "editor",
          body: { dataStream: `${value}\r\n` },
        } as IDocumentData,
        wholeSelection,
      ),
  };
}

test("a rejected real editor submit never sends its value or rollback side effects", async () => {
  const fixture = editorFixture();
  const submitting = fixture.submit();
  expect(fixture.current().v).toBe("invalid");
  expect(fixture.onValidateCell).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(fixture.send).not.toHaveBeenCalled();
  fixture.validation.resolve(false);
  expect(await submitting).toBe(false);
  expect(fixture.rollback).toHaveBeenCalledOnce();
  expect(fixture.current().v).toBe("original");
  await Promise.resolve();
  expect(fixture.send).not.toHaveBeenCalled();
});

test("ordinary editor input still submits after the always-awaited validation returns true", async () => {
  const fixture = editorFixture();
  const submitting = fixture.submit("ordinary input");
  expect(fixture.onValidateCell).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(fixture.send).not.toHaveBeenCalled();
  fixture.validation.resolve(true);
  expect(await submitting).toBe(true);
  await Promise.resolve();
  expect(fixture.rollback).not.toHaveBeenCalled();
  expect(fixture.send).toHaveBeenCalledOnce();
  const [mutations, revision] = fixture.send.mock.calls[0];
  expect(revision).toBe(7);
  expect(mutations).toHaveLength(3);
  expect(mutations[0].params.cellValue[0][0].v).toBe("ordinary input");
});

test("an unrelated mutation during editor validation is sent and is not mistaken for rollback", async () => {
  const fixture = editorFixture();
  const submitting = fixture.submit();
  fixture.unrelated();
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0][0]).toEqual([
    {
      id: "sheet.mutation.set-worksheet-row-auto-height",
      params: {
        unitId: "book",
        subUnitId: "sheet",
        rowsAutoHeightInfo: [{ row: 1, autoHeight: 60 }],
      },
    },
  ]);
  fixture.validation.resolve(false);
  expect(await submitting).toBe(false);
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  fixture.unrelated();
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledTimes(2);
});

test("pending rejection does not swallow a multi-cell paste or a later valid editor input", async () => {
  const fixture = editorFixture();
  const rejected = fixture.submit();
  fixture.paste();
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0][0][0].params.cellValue).toEqual({
    4: { 0: { v: "paste a" }, 1: { v: "paste b" } },
  });
  fixture.validation.resolve(false);
  expect(await rejected).toBe(false);
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  fixture.nextValidation();
  const accepted = fixture.submit("valid later");
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  fixture.validation.resolve(true);
  expect(await accepted).toBe(true);
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledTimes(2);
  expect(fixture.send.mock.calls[1][0][0].params.cellValue[0][0].v).toBe("valid later");
});

test("whole-selection input matches validation at an origin inside rather than at the range start", async () => {
  const fixture = editorFixture({ row: 1, column: 1 });
  const submitting = fixture.submit("fill", true);
  expect(fixture.onValidateCell.mock.calls[0].slice(2)).toEqual([1, 1]);
  await Promise.resolve();
  expect(fixture.send).not.toHaveBeenCalled();
  fixture.validation.resolve(true);
  expect(await submitting).toBe(true);
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  const cells = fixture.send.mock.calls[0][0][0].params.cellValue;
  expect(Object.keys(cells)).toEqual(["0", "1", "2"]);
  expect(Object.keys(cells[1])).toEqual(["0", "1", "2"]);
  expect(cells[0][0].v).toBe("fill");
  expect(cells[2][2].v).toBe("fill");
});

test("an untouched or cancelled editor has nothing to validate or synchronize", async () => {
  const fixture = editorFixture();
  fixture.setDirty(false);
  expect(await fixture.submit()).toBe(true);
  fixture.setDirty(true);
  fixture.cancel();
  expect(await fixture.submit()).toBe(true);
  await Promise.resolve();
  expect(fixture.onValidateCell).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.current().v).toBe("original");
});

test("a failed command without validation does not consume the next editor validation", async () => {
  const fixture = editorFixture();
  fixture.setCommandFailure(true);
  expect(await fixture.submit("failed command")).toBe(true);
  expect(fixture.onValidateCell).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  fixture.setCommandFailure(false);
  const submitting = fixture.submit("valid after command failure");
  fixture.validation.resolve(true);
  expect(await submitting).toBe(true);
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0][0][0].params.cellValue[0][0].v).toBe(
    "valid after command failure",
  );
});

test("a throwing editor command without an after event does not swallow later mutations", async () => {
  const fixture = editorFixture();
  fixture.setCommandThrow(true);
  await expect(fixture.submit()).rejects.toThrow("native command failed");
  await Promise.resolve();
  expect(fixture.onValidateCell).not.toHaveBeenCalled();
  fixture.unrelated();
  await Promise.resolve();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0][0][0].id).toBe("sheet.mutation.set-worksheet-row-auto-height");
});
