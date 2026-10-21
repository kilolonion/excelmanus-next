// 待审批写入的目标（拟修改，尚未写入）：取自审批记录里的 workbook_edit 参数。

import type { ApprovalState } from "@/lib/session/types";

export interface PendingWriteOperation {
  op: string;
  range?: string;
  sheet?: string;
  at?: number;
  count?: number;
  name?: string;
  what?: string;
  values?: unknown[][];
}

export interface PendingWrite {
  path?: string;
  docId?: string;
  ranges: string[];
  /** cells.set 的拟写入值（二维，按区域）；用于修改前后对比。 */
  values: Record<string, unknown[][]>;
  operations: PendingWriteOperation[];
}

export function pendingWriteTargets(
  approval: Pick<ApprovalState, "toolName" | "args">,
): PendingWrite | null {
  if (approval.toolName !== "workbook_edit") return null;
  const a = approval.args as { path?: unknown; docId?: unknown; ops?: unknown } | undefined;
  if (!a || !Array.isArray(a.ops)) return null;
  const ranges: string[] = [];
  const values: Record<string, unknown[][]> = {};
  const operations: PendingWriteOperation[] = [];
  for (const raw of a.ops as Record<string, unknown>[]) {
    const opName = typeof raw.op === "string" ? raw.op : "";
    const operation: PendingWriteOperation = { op: opName };
    if (typeof raw.range === "string") operation.range = raw.range;
    if (typeof raw.sheet === "string") operation.sheet = raw.sheet;
    if (typeof raw.at === "number") operation.at = raw.at;
    if (typeof raw.count === "number") operation.count = raw.count;
    if (typeof raw.name === "string") operation.name = raw.name;
    if (typeof raw.what === "string") operation.what = raw.what;
    if (Array.isArray(raw.values)) operation.values = raw.values as unknown[][];
    operations.push(operation);
    if (typeof operation.range !== "string") continue;
    const r =
      typeof operation.sheet === "string" && !operation.range.includes("!")
        ? `${operation.sheet}!${operation.range}`
        : operation.range;
    ranges.push(r);
    if (opName === "cells.set" && operation.values) values[r] = operation.values;
  }
  return {
    ...(typeof a.path === "string" ? { path: a.path } : {}),
    ...(typeof a.docId === "string" ? { docId: a.docId } : {}),
    ranges,
    values,
    operations,
  };
}
