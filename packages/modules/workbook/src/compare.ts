import { indexToCol } from "@excelmanus/core";
import type { IWorkbookData } from "@univerjs/core";
// 快照差异：结构化深比较 + 两份快照间"实际变化的单元格/字段"集合。
// 逆操作生成（inverse.ts）用它定位需要恢复前像的单元格与元数据字段。

export interface DiffEntry {
  path: string;
  a: unknown;
  b: unknown;
}

export function deepDiff(
  a: unknown,
  b: unknown,
  path: string[] = [],
  out: DiffEntry[] = [],
  maxDiffs = 5000,
): DiffEntry[] {
  if (out.length >= maxDiffs) return out;
  if (a === b) return out;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb || a === null || b === null || ta !== "object") {
    out.push({ path: path.join("."), a, b });
    return out;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    out.push({ path: path.join("."), a, b });
    return out;
  }
  if (aArr && bArr) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) {
      out.push({ path: `${path.join(".")}.length`, a: aa.length, b: bb.length });
    }
    for (let i = 0; i < Math.max(aa.length, bb.length) && out.length < maxDiffs; i++) {
      deepDiff(aa[i], bb[i], [...path, String(i)], out, maxDiffs);
    }
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (out.length >= maxDiffs) break;
    deepDiff(ao[k], bo[k], [...path, k], out, maxDiffs);
  }
  return out;
}

export interface ChangedCells {
  /** sheetId -> Set<"r,c">（0 基）。 */
  cells: Map<string, Set<string>>;
  /** 非单元格差异路径：`s1.mergeData`、`workbook.sheetOrder`、`sheet:s1 added/removed`。 */
  meta: string[];
}

/** 两份 IWorkbookData 间的单元格与元数据差异（逆操作前像恢复的依据）。 */
export function changedCellsBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangedCells {
  const cells = new Map<string, Set<string>>();
  const meta: string[] = [];
  const bSheets = (before.sheets ?? {}) as Record<string, Record<string, unknown>>;
  const aSheets = (after.sheets ?? {}) as Record<string, Record<string, unknown>>;
  for (const sid of new Set([...Object.keys(bSheets), ...Object.keys(aSheets)])) {
    const sb = bSheets[sid];
    const sa = aSheets[sid];
    if (!sb || !sa) {
      meta.push(`sheet:${sid} added/removed`);
      continue;
    }
    const cb = (sb.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const ca = (sa.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const set = new Set<string>();
    for (const r of new Set([...Object.keys(cb), ...Object.keys(ca)])) {
      const rb = cb[r] ?? {};
      const ra = ca[r] ?? {};
      for (const c of new Set([...Object.keys(rb), ...Object.keys(ra)])) {
        if (deepDiff(rb[c], ra[c]).length > 0) set.add(`${r},${c}`);
      }
    }
    if (set.size > 0) cells.set(sid, set);
    for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
      if (k !== "cellData" && deepDiff(sb[k], sa[k]).length > 0) meta.push(`${sid}.${k}`);
    }
  }
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k !== "sheets" && deepDiff(before[k], after[k]).length > 0) meta.push(`workbook.${k}`);
  }
  return { cells, meta };
}

type CellLike = { v?: unknown; f?: unknown } | null | undefined;
type Rows = Record<string, Record<string, CellLike>>;

export interface CompareCell {
  cell: string;
  kind: "added" | "deleted" | "modified";
  left: { value: string | number | boolean | null; formula?: string } | null;
  right: { value: string | number | boolean | null; formula?: string } | null;
}

export interface CompareSheet {
  name: string;
  status: "both" | "leftOnly" | "rightOnly";
  changed: number;
  cells: CompareCell[];
}

/**
 * 两个工作簿并排对比：按表名配对，逐格比较值与公式（不比较样式）。
 * cells 合计最多 limit 条，changed 是完整计数。
 */
export function compareWorkbooks(
  left: IWorkbookData,
  right: IWorkbookData,
  limit = 500,
): { sheets: CompareSheet[]; truncated: boolean } {
  const byName = (b: IWorkbookData) =>
    new Map(
      (b.sheetOrder ?? Object.keys(b.sheets ?? {})).map((id) => {
        const s = b.sheets?.[id] ?? {};
        return [s.name ?? id, (s.cellData ?? {}) as unknown as Rows] as const;
      }),
    );
  const l = byName(left);
  const r = byName(right);
  const norm = (c: CellLike) => {
    const v = c?.v;
    const value =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
    const formula = typeof c?.f === "string" && c.f !== "" ? c.f : undefined;
    if (value === null && formula === undefined) return null;
    return { value, ...(formula !== undefined ? { formula } : {}) };
  };
  let budget = limit;
  let truncated = false;
  const sheets: CompareSheet[] = [];
  for (const name of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(name);
    const b = r.get(name);
    const status = a && b ? "both" : a ? "leftOnly" : "rightOnly";
    const cells: CompareCell[] = [];
    let changed = 0;
    const ad = a ?? {};
    const bd = b ?? {};
    const rows = [...new Set([...Object.keys(ad), ...Object.keys(bd)])]
      .map(Number)
      .sort((x, y) => x - y);
    for (const row of rows) {
      const ar = ad[row] ?? {};
      const br = bd[row] ?? {};
      const cols = [...new Set([...Object.keys(ar), ...Object.keys(br)])]
        .map(Number)
        .sort((x, y) => x - y);
      for (const col of cols) {
        const x = norm(ar[col]);
        const y = norm(br[col]);
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        changed++;
        if (budget <= 0) {
          truncated = true;
          continue;
        }
        budget--;
        cells.push({
          cell: `${indexToCol(col + 1)}${row + 1}`,
          kind: x === null ? "added" : y === null ? "deleted" : "modified",
          left: x,
          right: y,
        });
      }
    }
    sheets.push({ name, status, changed, cells });
  }
  return { sheets, truncated };
}
