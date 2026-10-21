// 冲突条的纯逻辑：把被拒绝的编辑与服务端返回的冲突区域对上，得到「你的输入」逐格对照。
// 只产出结构，便于单测；文案在冲突条组件里。

import { indexToCol, parseRange } from "@excelmanus/core";
import type { DocConflict } from "./doc-sync";

/** 冲突的另一方（服务端 `kind:id` 的 kind）。 */
export type ConflictParty = "agent" | "window" | "engine" | "external" | "script";

const PARTY: Record<string, ConflictParty> = {
  agent: "agent",
  user: "window",
  engine: "engine",
  external: "external",
  script: "script",
};

/** 服务端来源 `kind:id` → 对方是谁；认不出来时为 undefined。 */
export function partyOf(source: string): ConflictParty | undefined {
  return PARTY[source.split(":", 1)[0] ?? ""];
}

/** 去重后的冲突对方；服务端没给来源（例如结构冲突）时为空。 */
export function conflictParties(conflict: DocConflict): ConflictParty[] {
  const out = new Set<ConflictParty>();
  for (const detail of conflict.conflicts) {
    const party = partyOf(detail.source ?? "");
    if (party) out.add(party);
  }
  return [...out];
}

/** 单元格内容的展示形态；样式类编辑没有内容，单独标出。 */
export type CellValue = { kind: "text"; text: string } | { kind: "empty" } | { kind: "format" };

interface CellLike {
  v?: unknown;
  f?: unknown;
  p?: { body?: { dataStream?: unknown } } | null;
}

/** Univer 单元格数据 → 展示文本：公式优先，其次富文本，最后原始值。 */
export function describeCell(cell: unknown): CellValue {
  if (cell === null || typeof cell !== "object") return { kind: "empty" };
  const c = cell as CellLike;
  if (!("v" in c || "f" in c || "p" in c)) return { kind: "format" };
  if (typeof c.f === "string" && c.f.length > 0) return { kind: "text", text: c.f };
  const rich = c.p?.body?.dataStream;
  if (typeof rich === "string") {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Univer 富文本数据流用控制字符分隔段落
    const text = rich.replace(/[\u0000-\u001f]+/g, " ").trim();
    if (text) return { kind: "text", text };
  }
  if (c.v === null || c.v === undefined || c.v === "") return { kind: "empty" };
  return { kind: "text", text: String(c.v) };
}

export interface ConflictCell {
  sheetId: string;
  sheetName: string;
  /** 0 起算，与 Univer 一致。 */
  row: number;
  col: number;
  /** A1 记法，不带工作表名。 */
  address: string;
  /** 用户这次想写入的内容。 */
  mine: CellValue;
}

/**
 * 被拒绝的 set-range-values 里，落在服务端冲突区域内的单元格。
 * 区域对不上（例如对方插入行列后坐标已平移）时返回空，宁可只显示区域，也不给出错位的对照。
 */
export function conflictCells(
  conflict: DocConflict,
  sheetNameOf: (sheetId: string) => string | undefined,
): ConflictCell[] {
  const mutation = conflict.submitted?.mutation;
  if (mutation?.id !== "sheet.mutation.set-range-values") return [];
  const params = mutation.params as { subUnitId?: unknown; cellValue?: unknown } | null;
  const sheetId = typeof params?.subUnitId === "string" ? params.subUnitId : undefined;
  const matrix = params?.cellValue;
  if (!sheetId || matrix === null || typeof matrix !== "object") return [];
  const sheetName = sheetNameOf(sheetId);
  if (!sheetName) return [];

  const rects = conflict.conflicts.flatMap((detail) =>
    detail.cells.flatMap((ref) => {
      try {
        const range = parseRange(ref);
        return (range.sheet ?? sheetName) === sheetName ? [range] : [];
      } catch {
        return [];
      }
    }),
  );
  if (rects.length === 0) return [];

  const out: ConflictCell[] = [];
  for (const [rowKey, cols] of Object.entries(matrix as Record<string, unknown>)) {
    if (cols === null || typeof cols !== "object") continue;
    const row = Number(rowKey);
    for (const [colKey, cell] of Object.entries(cols as Record<string, unknown>)) {
      const col = Number(colKey);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      const hit = rects.some(
        (r) =>
          row + 1 >= r.startRow &&
          row + 1 <= r.endRow &&
          col + 1 >= r.startCol &&
          col + 1 <= r.endCol,
      );
      if (!hit) continue;
      out.push({
        sheetId,
        sheetName,
        row,
        col,
        address: `${indexToCol(col + 1)}${row + 1}`,
        mine: describeCell(cell),
      });
    }
  }
  return out;
}

/** 冲突区域的展示文本：去掉不必要的单引号，去重。 */
export function conflictRegions(conflict: DocConflict): string[] {
  return [
    ...new Set(
      conflict.conflicts
        .flatMap((detail) => detail.cells)
        .filter((cell) => cell.length > 0)
        .map((cell) => cell.replace(/^'([^']*)'!/, "$1!")),
    ),
  ];
}

/** 服务端修订已经落到本端快照之后才能读到对方的值。 */
export function conflictRevision(conflict: DocConflict): number {
  return Math.max(0, ...conflict.conflicts.map((detail) => detail.rev ?? 0));
}

/** 能用「保留我的」解决：服务端指出了冲突区域，且这条编辑我们还留着。 */
export function canKeepMine(conflict: DocConflict): boolean {
  return (
    conflict.code === "VERSION_CONFLICT" &&
    conflict.submitted !== undefined &&
    conflict.conflicts.some((detail) => detail.cells.length > 0)
  );
}
