import type { SheetInterceptorService } from "@univerjs/preset-sheets-core";
import type { DocMutation } from "./doc-sync";

type Context = { unitId: string; subUnitId: string; row: number; col: number };
type EditParams = {
  redoUndoId: string;
  unitId: string;
  subUnitId: string;
  range?: { startRow: number; endRow: number; startColumn: number; endColumn: number };
};
type Transaction = { params: EditParams; items: { mutation: DocMutation; revision: number }[] };
type UndoItem = { id?: string; undoMutations: { params?: unknown }[] };

/** Univer writes an editor value before awaiting validation, then rolls it back on rejection.
 * Only that synchronous edit's mutations are provisional, not other edits during the await.
 */
export class EditorValidationGate {
  private active: Transaction | undefined;
  private pending: Transaction[] = [];
  private rollbackParams = new WeakSet<object>();
  private disposed = false;
  private readonly send: (mutation: DocMutation, revision: number) => void;
  constructor(send: (mutation: DocMutation, revision: number) => void) {
    this.send = send;
  }

  bindValidation(
    service: Pick<SheetInterceptorService, "onValidateCell">,
    undo: () => UndoItem | null | undefined,
  ): () => void {
    const original = service.onValidateCell;
    service.onValidateCell = (workbook, worksheet, row, col) =>
      this.validate(
        { unitId: workbook.getUnitId(), subUnitId: worksheet.getSheetId(), row, col },
        original.call(service, workbook, worksheet, row, col) ?? Promise.resolve(true),
        undo,
      );
    return () => {
      service.onValidateCell = original;
    };
  }

  before(command: DocMutation): void {
    const params = command.params as EditParams | undefined;
    if (command.id !== "sheet.command.set-range-values" || !params?.redoUndoId) return;
    this.active = { params, items: [] };
    // Validation starts synchronously after this command returns. Anything still
    // waiting here belongs to an earlier failed command that never validated.
    this.pending = [this.active];
    const transaction = this.active;
    // A throwing command emits no executed event. Drop its unfinished capture,
    // never release it, before a later user action can be mistaken for that edit.
    queueMicrotask(() => {
      if (this.active !== transaction) return;
      this.active = undefined;
      this.pending = this.pending.filter((item) => item !== transaction);
    });
  }

  after(command: DocMutation): void {
    if (command.params === this.active?.params) this.active = undefined;
  }

  isRollback(command: DocMutation): boolean {
    const params = command.params;
    if (!params || typeof params !== "object" || !this.rollbackParams.has(params)) return false;
    this.rollbackParams.delete(params);
    return true;
  }

  push(mutation: DocMutation, revision: number): void {
    if (this.disposed) return;
    if (this.active) this.active.items.push({ mutation: structuredClone(mutation), revision });
    else this.send(mutation, revision);
  }

  async validate(
    context: Context,
    result: Promise<boolean>,
    undo: () => UndoItem | null | undefined,
  ): Promise<boolean> {
    const index = this.pending.findIndex(({ params: p }) => {
      const r = p.range;
      return (
        p.unitId === context.unitId &&
        p.subUnitId === context.subUnitId &&
        (!r ||
          (context.row >= r.startRow &&
            context.row <= r.endRow &&
            context.col >= r.startColumn &&
            context.col <= r.endColumn))
      );
    });
    const transaction = index < 0 ? undefined : this.pending.splice(index, 1)[0];
    // Capture before the await: another command may change the focused undo stack meanwhile.
    const undoItem = transaction ? undo() : undefined;
    const accepted = await result;
    if (!transaction || this.disposed) return accepted;
    if (accepted) {
      for (const { mutation, revision } of transaction.items) this.send(mutation, revision);
    } else if (undoItem?.id === transaction.params.redoUndoId) {
      for (const { params } of undoItem.undoMutations) {
        if (params && typeof params === "object") this.rollbackParams.add(params);
      }
    }
    return accepted;
  }

  dispose(): void {
    this.disposed = true;
    this.active = undefined;
    this.pending = [];
  }
}
