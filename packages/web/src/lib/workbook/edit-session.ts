// 单元格编辑会话（02 §4.7）。
// 1. 编辑开始时记下当时的修订：用户提交时按"他看到的版本"作为 baseRev，若这期间别人改了同一格，
//    服务端据此判冲突，而不是悄悄覆盖对方。
// 2. 用户已键入、尚未提交时对方改写了这一格：Univer 会用新内容重置编辑框，草稿就此丢失；
//    这里在远端 mutation 落下前记住草稿，交给冲突条让用户选择保留谁的。

import { isDerivedWorkbookMutation } from "@excelmanus/core";
import type { DocMutation } from "./doc-sync";

const SET_VALUES = "sheet.mutation.set-range-values";

interface Editing {
  sheetId: string;
  row: number;
  col: number;
  baseRev: number;
  /** 用户键入过的最新内容；只是打开编辑框没有键入时为 undefined。 */
  draft: string | undefined;
}

/** 被冲掉的草稿，以及对方写进这一格的单元格数据。 */
export interface Clash {
  sheetId: string;
  row: number;
  col: number;
  text: string;
  theirs: unknown;
}

function cellOf(params: unknown, sheetId: string, row: number, col: number): unknown {
  const p = params as { subUnitId?: unknown; cellValue?: Record<string, Record<string, unknown>> };
  return p?.subUnitId === sheetId ? p.cellValue?.[row]?.[col] : undefined;
}

function touchesCell(
  mutation: DocMutation,
  e: { sheetId: string; row: number; col: number },
): boolean {
  return (
    mutation.id === SET_VALUES && cellOf(mutation.params, e.sheetId, e.row, e.col) !== undefined
  );
}

export class EditTracker {
  private cur: Editing | null = null;
  /** 刚结束的编辑：提交的 mutation 在 SheetEditEnded 之后才执行，需要短暂保留依据修订。 */
  private ended: (Editing & { at: number }) | null = null;

  start(sheetId: string, row: number, col: number, rev: number): void {
    this.cur = { sheetId, row, col, baseRev: rev, draft: undefined };
    this.ended = null;
  }

  typed(text: string): void {
    if (this.cur) this.cur.draft = text;
  }

  currentDraft(): { sheetId: string; row: number; col: number; text: string; baseRev: number } | null {
    const e = this.cur;
    return e?.draft === undefined ? null : { sheetId: e.sheetId, row: e.row, col: e.col, text: e.draft, baseRev: e.baseRev };
  }

  end(confirmed = true): void {
    this.ended = confirmed && this.cur ? { ...this.cur, at: Date.now() } : null;
    this.cur = null;
  }

  /** 本端提交某个 mutation 时应使用的依据修订：来自刚结束的单元格编辑则取编辑开始时的修订。 */
  baseRevFor(mutation: DocMutation): number | undefined {
    const e = this.ended;
    if (!e || Date.now() - e.at > 1500 || !touchesCell(mutation, e)) return undefined;
    this.ended = null;
    return e.baseRev;
  }

  /**
   * 回放对方的 mutation 之前调用：若它会冲掉正在输入的内容，返回草稿与对方写入的单元格。
   * 同一份草稿只提示一次，用户再键入后才会有新的草稿。
   */
  remote(mutation: DocMutation): Clash | null {
    const e = this.cur;
    if (e?.draft === undefined) return null;
    if (mutation.id !== SET_VALUES || isDerivedWorkbookMutation(mutation)) return null;
    const theirs = cellOf(mutation.params, e.sheetId, e.row, e.col);
    if (theirs === undefined) return null;
    const text = e.draft;
    e.draft = undefined;
    return { sheetId: e.sheetId, row: e.row, col: e.col, text, theirs };
  }
}

interface DraftWorkbook {
  endEditingAsync(save?: boolean): Promise<boolean>;
  getSheetBySheetId(id: string):
    | {
        getRange(row: number, col: number): { setValue(value: string): unknown };
      }
    | null
    | undefined;
}

/** Resolve a recovered draft only after abandoning the editor's stale pending value. */
export async function resolveDraftInput(
  workbook: DraftWorkbook,
  draft: Clash,
  choice: "mine" | "theirs",
): Promise<void> {
  if (!(await workbook.endEditingAsync(false))) throw new Error("未能结束单元格编辑，请重试");
  if (choice === "theirs") return;
  const sheet = workbook.getSheetBySheetId(draft.sheetId);
  if (!sheet) throw new Error("工作表已关闭，输入草稿仍保留");
  await sheet.getRange(draft.row, draft.col).setValue(draft.text);
}
