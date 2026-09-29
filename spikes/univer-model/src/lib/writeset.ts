// T4 写集推导：mutation(id+params) → 受影响区域列表。
// WriteRegion：sheetId + 行列区间（缺省 = 全维）+ metaKeys（该区域附带允许变化的非单元格字段）。
// meta 匹配用“前缀包含”：`s1.rowData`、`workbook.resources` 等 diff 路径按此归类。

import type { CapturedMutation } from "./univer-node.ts";

export interface WriteRegion {
  sheetId: string | "*";
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
  metaKeys?: string[]; // 例：["mergeData"]、["rowData"]、["name"]
}

export interface WriteSet {
  regions: WriteRegion[];
  bookMeta?: string[]; // workbook 级字段：sheetOrder/styles/resources…
  conservative?: string; // 无法精确推导时的原因
  paramsOnly: boolean; // 推导是否只依赖 mutation params
  rule: string; // 规则说明（进报告表格）
}

type P = Record<string, unknown>;
const p = (m: CapturedMutation) => (m.params ?? {}) as P;
const numKeys = (o: unknown): number[] =>
  o && typeof o === "object"
    ? Object.keys(o as P)
        .map(Number)
        .filter((n) => Number.isFinite(n))
    : [];

interface R {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}
const asRanges = (v: unknown): R[] => (Array.isArray(v) ? (v as R[]) : v ? [v as R] : []);

function regionFromRanges(sheetId: string, ranges: R[], meta?: string[]): WriteRegion[] {
  return ranges.map((r) => ({
    sheetId,
    startRow: r.startRow,
    endRow: r.endRow,
    startCol: r.startColumn,
    endCol: r.endColumn,
    metaKeys: meta,
  }));
}

// ObjectMatrix {row:{col:cell}} → 覆盖区间
function matrixRegion(sheetId: string, matrix: unknown, meta?: string[]): WriteRegion[] {
  const rows = numKeys(matrix);
  if (rows.length === 0) return [{ sheetId, metaKeys: meta }];
  const m = matrix as Record<string, Record<string, unknown>>;
  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const r of rows) {
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    for (const c of numKeys(m[String(r)])) {
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
    }
  }
  return [{ sheetId, startRow: minR, endRow: maxR, startCol: minC, endCol: maxC, metaKeys: meta }];
}

const ROW_TAIL = (sheetId: string, fromRow: number, meta?: string[]): WriteRegion => ({
  sheetId,
  startRow: fromRow,
  metaKeys: meta,
});
const COL_TAIL = (sheetId: string, fromCol: number, meta?: string[]): WriteRegion => ({
  sheetId,
  startCol: fromCol,
  metaKeys: meta,
});

const META_ALL_SHEET = [
  "cellData",
  "mergeData",
  "rowData",
  "columnData",
  "rowCount",
  "columnCount",
];

export function deriveWriteSet(m: CapturedMutation): WriteSet {
  const q = p(m);
  const sub = String(q.subUnitId ?? "");
  switch (m.id) {
    case "sheet.mutation.set-range-values": {
      return {
        regions: matrixRegion(sub, q.cellValue, ["cellData"]),
        bookMeta: ["styles"], // mutation 内联样式会登记进 styles 表
        paramsOnly: true,
        rule: "cellValue 的 {row:{col}} 键集 → 最小包围矩形",
      };
    }
    case "sheet.mutation.insert-row": {
      const r = (q.range ?? {}) as R;
      return {
        regions: [ROW_TAIL(sub, r.startRow ?? 0, META_ALL_SHEET)],
        bookMeta: ["resources"], // DV/CF 等插件按坐标存规则，行平移会改写 resources
        paramsOnly: true,
        rule: "插入行 = [startRow, 表尾) × 全列（坐标空间整体下移）",
      };
    }
    case "sheet.mutation.remove-rows": {
      const r = (q.range ?? {}) as R;
      return {
        regions: [ROW_TAIL(sub, r.startRow ?? 0, META_ALL_SHEET)],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "删除行 = [startRow, 表尾) × 全列（坐标空间整体上移）",
      };
    }
    case "sheet.mutation.insert-col": {
      const r = (q.range ?? {}) as R;
      return {
        regions: [COL_TAIL(sub, r.startColumn ?? 0, META_ALL_SHEET)],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "插入列 = 全行 × [startColumn, 表尾)",
      };
    }
    case "sheet.mutation.remove-col": {
      const r = (q.range ?? {}) as R;
      return {
        regions: [COL_TAIL(sub, r.startColumn ?? 0, META_ALL_SHEET)],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "删除列 = 全行 × [startColumn, 表尾)",
      };
    }
    case "sheet.mutation.move-rows": {
      const s = (q.sourceRange ?? {}) as R;
      const t = (q.targetRange ?? {}) as R;
      return {
        regions: [
          {
            sheetId: sub,
            startRow: Math.min(s.startRow ?? 0, t.startRow ?? 0),
            endRow: Math.max(s.endRow ?? 0, t.endRow ?? 0),
            metaKeys: META_ALL_SHEET,
          },
        ],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "移动行 = [min(src,tgt).startRow, max(src,tgt).endRow] × 全列",
      };
    }
    case "sheet.mutation.move-columns": {
      const s = (q.sourceRange ?? {}) as R;
      const t = (q.targetRange ?? {}) as R;
      return {
        regions: [
          {
            sheetId: sub,
            startCol: Math.min(s.startColumn ?? 0, t.startColumn ?? 0),
            endCol: Math.max(s.endColumn ?? 0, t.endColumn ?? 0),
            metaKeys: META_ALL_SHEET,
          },
        ],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "移动列 = 全行 × [min(src,tgt).startCol, max(src,tgt).endCol]",
      };
    }
    case "sheet.mutation.move-range": {
      const from = ((q.from ?? {}) as P).subUnitId as string;
      const to = ((q.to ?? {}) as P).subUnitId as string;
      return {
        regions: [
          ...regionFromRanges(from || sub, asRanges(q.fromRange), META_ALL_SHEET),
          ...regionFromRanges(to || sub, asRanges(q.toRange), META_ALL_SHEET),
        ],
        paramsOnly: true,
        rule: "fromRange ∪ toRange（可跨表）",
      };
    }
    case "sheet.mutation.reorder-range": {
      return {
        regions: regionFromRanges(sub, asRanges(q.range), ["cellData", "mergeData"]),
        paramsOnly: true,
        rule: "排序 range 内全部单元格（行内重排）",
      };
    }
    case "sheet.mutation.set-worksheet-row-height":
    case "sheet.mutation.set-worksheet-row-is-auto-height": {
      return {
        regions: regionFromRanges(sub, asRanges(q.ranges), ["rowData"]),
        paramsOnly: true,
        rule: "ranges 的行进 → rowData",
      };
    }
    case "sheet.mutation.set-worksheet-col-width": {
      return {
        regions: regionFromRanges(sub, asRanges(q.ranges), ["columnData"]),
        paramsOnly: true,
        rule: "ranges 的列进 → columnData",
      };
    }
    case "sheet.mutation.set-row-hidden":
    case "sheet.mutation.set-row-visible": {
      return {
        regions: regionFromRanges(sub, asRanges(q.ranges), ["rowData"]),
        paramsOnly: true,
        rule: "ranges 的行进 → rowData.hidden",
      };
    }
    case "sheet.mutation.set-col-hidden":
    case "sheet.mutation.set-col-visible": {
      return {
        regions: regionFromRanges(sub, asRanges(q.ranges), ["columnData"]),
        paramsOnly: true,
        rule: "ranges 的列进 → columnData.hidden",
      };
    }
    case "sheet.mutation.set-frozen": {
      return {
        regions: [{ sheetId: sub, metaKeys: ["freeze"] }],
        paramsOnly: true,
        rule: "sheet.freeze 字段",
      };
    }
    case "sheet.mutation.add-worksheet-merge":
    case "sheet.mutation.remove-worksheet-merge": {
      return {
        regions: regionFromRanges(sub, asRanges(q.ranges), ["mergeData", "cellData"]),
        paramsOnly: true,
        rule: "merge ranges → mergeData + 区域内单元格（合并清边/恢复）",
      };
    }
    case "sheet.mutation.set-worksheet-name": {
      return {
        regions: [{ sheetId: sub, metaKeys: ["name"] }],
        paramsOnly: true,
        rule: "sheet.name",
      };
    }
    case "sheet.mutation.set-worksheet-order": {
      return {
        regions: [],
        bookMeta: ["sheetOrder"],
        paramsOnly: true,
        rule: "workbook.sheetOrder",
      };
    }
    case "sheet.mutation.insert-sheet": {
      const sheet = (q.sheet ?? {}) as P;
      return {
        regions: [
          {
            sheetId: String(sheet.id ?? "*"),
            endRow: Number(sheet.rowCount ?? 0) - 1,
            endCol: Number(sheet.columnCount ?? 0) - 1,
          },
        ],
        bookMeta: ["sheetOrder", "resources", "styles", "sheets"],
        paramsOnly: true,
        rule: "新表全区域 + book 级 sheetOrder/resources",
      };
    }
    case "sheet.mutation.remove-sheet": {
      return {
        regions: [],
        bookMeta: ["sheetOrder", "resources", "sheets", "styles"], // 删表会回收其引用的样式条目
        paramsOnly: true,
        rule: `删除表 ${sub} → book 级结构字段`,
      };
    }
    case "sheet.mutation.set-filter-range":
    case "sheet.mutation.remove-filter": {
      return {
        regions: regionFromRanges(sub, asRanges(q.range), ["autoFilter", "rowData"]),
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "filter range + 隐藏行（rowData）",
      };
    }
    case "sheet.mutation.set-filter-criteria": {
      const rows = (q.filteredOutRows as number[] | undefined) ?? [];
      return {
        regions: [{ sheetId: sub, metaKeys: ["autoFilter", "rowData"] }],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: `col ${q.col} criteria + filteredOutRows(${rows.length}) → rowData.hidden`,
      };
    }
    case "sheet.mutation.mark-dirty-filter-change": {
      return {
        regions: [{ sheetId: sub, metaKeys: ["autoFilter", "rowData"] }],
        paramsOnly: true,
        rule: "filterRange 内部状态标记",
      };
    }
    case "sheet.mutation.re-calc-filter": {
      // params 只带 subUnitId；重算可能改写任意 filtered-out 行的 rowData.hidden → 保守整表 meta
      return {
        regions: [{ sheetId: sub === "" ? "*" : sub, metaKeys: ["autoFilter", "rowData"] }],
        bookMeta: ["resources"],
        paramsOnly: false,
        conservative: "params 无范围信息，重算可触及筛选区内任意行 → 保守整表",
        rule: "筛选重算 → 保守整表（rowData/resources）",
      };
    }
    case "sheet.mutation.add-conditional-rule":
    case "sheet.mutation.delete-conditional-rule":
    case "sheet.mutation.set-conditional-rule":
    case "sheet.mutation.move-conditional-rule": {
      return {
        regions: [{ sheetId: sub, metaKeys: ["conditionalFormat", "cf"] }],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "条件格式规则（不改单元格值）",
      };
    }
    case "data-validation.mutation.addRule":
    case "data-validation.mutation.updateRule":
    case "data-validation.mutation.removeRule": {
      return {
        regions: [{ sheetId: sub, metaKeys: ["dataValidation"] }],
        bookMeta: ["resources"],
        paramsOnly: true,
        rule: "数据验证规则（不改单元格值）",
      };
    }
    case "formula.mutation.set-formula-data": {
      const regions: WriteRegion[] = [];
      const fd = (q.formulaData ?? {}) as P;
      for (const sheetMap of Object.values(fd)) {
        for (const [sid, rows] of Object.entries(sheetMap as P)) {
          regions.push(...matrixRegion(sid, rows, ["cellData"]));
        }
      }
      return { regions, paramsOnly: true, rule: "formulaData 的 sheetId→row→col 键集" };
    }
    case "formula.mutation.set-array-formula-data": {
      const regions: WriteRegion[] = [];
      const afr = (q.arrayFormulaRange ?? {}) as P;
      for (const perUnit of Object.values(afr)) {
        for (const [sid, v] of Object.entries(perUnit as P)) {
          regions.push(...matrixRegion(sid, v, ["cellData"]));
        }
      }
      const afd = (q.arrayFormulaCellData ?? {}) as P;
      for (const perUnit of Object.values(afd)) {
        for (const [sid, v] of Object.entries(perUnit as P)) {
          regions.push(...matrixRegion(sid, v, ["cellData"]));
        }
      }
      return { regions, paramsOnly: true, rule: "arrayFormulaRange/arrayFormulaCellData 键集" };
    }
    case "formula.mutation.set-trigger-formula-calculation-start": {
      const regions: WriteRegion[] = [];
      for (const d of (q.dirtyRanges as Array<P>) ?? []) {
        const sid = String(d.sheetId ?? sub);
        regions.push(...regionFromRanges(sid, asRanges(d.range), ["cellData"]));
      }
      return {
        regions,
        paramsOnly: true,
        rule: "dirtyRanges 列表（触发计算的上界；实际值变更由 set-range-values 承载）",
      };
    }
    case "formula.mutation.set-formula-calculation-result":
    case "formula.mutation.set-formula-calculation-notification":
    case "formula.mutation.set-formula-calculation-end":
    case "formula.mutation.remove-other-formula": {
      return {
        regions: [{ sheetId: sub === "" ? "*" : sub }],
        paramsOnly: false,
        conservative: "params 只含公式 id/结果通知，无法映射到单元格 → 保守整表",
        rule: "保守整表",
      };
    }
    default: {
      return {
        regions: [{ sheetId: sub === "" ? "*" : sub }],
        paramsOnly: false,
        conservative: `未登记的 mutation id ${m.id} → 保守整表`,
        rule: "保守整表（未登记 id）",
      };
    }
  }
}

// ── ⊆ 自检 ──

export interface CoverageResult {
  ok: boolean;
  missingCells: string[]; // "sheetId r,c"
  missingMeta: string[];
}

export function covers(
  writeSet: WriteSet,
  changed: { cells: Map<string, Set<string>>; meta: string[] },
): CoverageResult {
  const missingCells: string[] = [];
  const missingMeta: string[] = [];
  for (const [sid, cells] of changed.cells) {
    for (const rc of cells) {
      const [r, c] = rc.split(",").map(Number) as [number, number];
      const hit = writeSet.regions.some(
        (g) =>
          (g.sheetId === "*" || g.sheetId === sid) &&
          (g.startRow === undefined || g.startRow <= r) &&
          (g.endRow === undefined || r <= g.endRow) &&
          (g.startCol === undefined || g.startCol <= c) &&
          (g.endCol === undefined || c <= g.endCol),
      );
      if (!hit) missingCells.push(`${sid} ${r},${c}`);
    }
  }
  for (const metaPath of changed.meta) {
    const hit = metaCovered(writeSet, metaPath);
    if (!hit) missingMeta.push(metaPath);
  }
  return { ok: missingCells.length === 0 && missingMeta.length === 0, missingCells, missingMeta };
}

function metaCovered(ws: WriteSet, metaPath: string): boolean {
  // metaPath 形如 "s1.mergeData"、"workbook.sheetOrder"、"sheet:s1 added/removed"
  if (metaPath.startsWith("sheet:")) {
    return (ws.bookMeta ?? []).some((k) => metaPath.includes(k) || k === "sheets");
  }
  const dot = metaPath.indexOf(".");
  const owner = dot > 0 ? metaPath.slice(0, dot) : metaPath;
  const key = dot > 0 ? metaPath.slice(dot + 1) : "";
  if (owner === "workbook") {
    return (ws.bookMeta ?? []).some((k) => key.startsWith(k));
  }
  return ws.regions.some(
    (g) =>
      (g.sheetId === "*" || g.sheetId === owner) &&
      (g.metaKeys ?? []).some((k) => key.startsWith(k)),
  );
}
