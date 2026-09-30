// 前像式逆操作生成（07 §3.3、ADR 0003 第 3 条，不使用 Univer UndoRedoService）：
// 结构操作用成对逆 mutation（insert↔remove / move 交换源目标 / remove-sheet→insert-sheet
// 携带被删表 JSON 与其样式子集）；数据差异由 pre/post 快照逐格恢复。

import { changedCellsBetween } from "./compare.ts";
import type { DocMutation } from "./engine.ts";

type P = Record<string, unknown>;
type R = { startRow: number; endRow: number; startColumn: number; endColumn: number };
type Snap = {
  sheets?: Record<string, P>;
  sheetOrder?: string[];
  styles?: Record<string, unknown>;
  resources?: Array<{ name?: string; data?: unknown }>;
};

const M = {
  insertRow: "sheet.mutation.insert-row",
  removeRows: "sheet.mutation.remove-rows",
  insertCol: "sheet.mutation.insert-col",
  removeCol: "sheet.mutation.remove-col",
  moveRows: "sheet.mutation.move-rows",
  moveCols: "sheet.mutation.move-columns",
  moveRange: "sheet.mutation.move-range",
  insertSheet: "sheet.mutation.insert-sheet",
  removeSheet: "sheet.mutation.remove-sheet",
  setOrder: "sheet.mutation.set-worksheet-order",
  setName: "sheet.mutation.set-worksheet-name",
  setRangeValues: "sheet.mutation.set-range-values",
  addMerge: "sheet.mutation.add-worksheet-merge",
  removeMerge: "sheet.mutation.remove-worksheet-merge",
  setRowHidden: "sheet.mutation.set-row-hidden",
  setRowVisible: "sheet.mutation.set-row-visible",
  setColHidden: "sheet.mutation.set-col-hidden",
  setColVisible: "sheet.mutation.set-col-visible",
  setRowHeight: "sheet.mutation.set-worksheet-row-height",
  setColWidth: "sheet.mutation.set-worksheet-col-width",
  setFrozen: "sheet.mutation.set-frozen",
  setFilterRange: "sheet.mutation.set-filter-range",
  removeFilter: "sheet.mutation.remove-filter",
  dvAdd: "data-validation.mutation.addRule",
  dvRemove: "data-validation.mutation.removeRule",
  cfAdd: "sheet.mutation.add-conditional-rule",
  cfDelete: "sheet.mutation.delete-conditional-rule",
} as const;

const mut = (id: string, params: P): DocMutation => ({ id, params });
const rng = (r: P): R => r as unknown as R;

/** 发射 mutation 中的结构对（按发射顺序倒序回放）。 */
function structuralInverses(
  mutations: DocMutation[],
  preSnap: Snap,
  unitId: string,
): DocMutation[] {
  const out: DocMutation[] = [];
  for (const m of [...mutations].reverse()) {
    const q = (m.params ?? {}) as P;
    const sub = String(q.subUnitId ?? "");
    switch (m.id) {
      case M.insertRow:
        out.push(mut(M.removeRows, { unitId, subUnitId: sub, range: q.range }));
        break;
      case M.removeRows:
        out.push(mut(M.insertRow, { unitId, subUnitId: sub, range: q.range }));
        break;
      case M.insertCol:
        out.push(mut(M.removeCol, { unitId, subUnitId: sub, range: q.range }));
        break;
      case M.removeCol:
        out.push(mut(M.insertCol, { unitId, subUnitId: sub, range: q.range }));
        break;
      case M.moveRows: {
        // Univer move-rows 语义：源行落到 target.startRow（下移时物理落点 target-1），
        // 逆移动的 source = 实际落点（spike 实测）。
        const src = rng(q.sourceRange as P);
        const tgt = rng(q.targetRange as P);
        const drop = src.startRow < tgt.startRow ? tgt.startRow - 1 : tgt.startRow;
        const span = src.endRow - src.startRow;
        out.push(
          mut(M.moveRows, {
            unitId,
            subUnitId: sub,
            sourceRange: { ...src, startRow: drop, endRow: drop + span },
            targetRange: src,
          }),
        );
        break;
      }
      case M.moveCols: {
        const src = rng(q.sourceRange as P);
        const tgt = rng(q.targetRange as P);
        const drop = src.startColumn < tgt.startColumn ? tgt.startColumn - 1 : tgt.startColumn;
        const span = src.endColumn - src.startColumn;
        out.push(
          mut(M.moveCols, {
            unitId,
            subUnitId: sub,
            sourceRange: { ...src, startColumn: drop, endColumn: drop + span },
            targetRange: src,
          }),
        );
        break;
      }
      case M.moveRange:
        // 交换 from/to 范围与负载（负载是被搬动的单元格矩阵，缺失会 Invalid move）
        out.push(
          mut(M.moveRange, {
            unitId,
            fromRange: q.toRange,
            toRange: q.fromRange,
            from: q.to,
            to: q.from,
          }),
        );
        break;
      case M.insertSheet: {
        const newId = String((q.sheet as P | undefined)?.id ?? q.subUnitId ?? "");
        const newName = String((q.sheet as P | undefined)?.name ?? "");
        if (newId) out.push(mut(M.removeSheet, { unitId, subUnitId: newId, subUnitName: newName }));
        break;
      }
      case M.removeSheet: {
        const removed = preSnap.sheets?.[sub];
        const idx = (preSnap.sheetOrder ?? []).indexOf(sub);
        if (removed) {
          // 携带被删表完整 JSON + 其引用到的样式子集
          const styleIds = new Set<string>();
          const walk = (n: unknown) => {
            if (!n || typeof n !== "object") return;
            const o = n as P;
            if (typeof o.s === "string") styleIds.add(o.s);
            for (const v of Object.values(o)) walk(v);
          };
          walk(removed);
          const styles: Record<string, unknown> = {};
          for (const id of styleIds)
            if (preSnap.styles && id in preSnap.styles) styles[id] = preSnap.styles[id];
          out.push(
            mut(M.insertSheet, {
              unitId,
              index: idx >= 0 ? idx : 0,
              sheet: JSON.parse(JSON.stringify(removed)),
              styles,
            }),
          );
        }
        break;
      }
      default:
        break; // 数据类 mutation 由前像恢复统一覆盖
    }
  }
  return out;
}

/** pre/post 差异 → 数据恢复 mutation（单元格值/合并/行列元数据/冻结/名称/顺序）。 */
function dataRestores(preSnap: Snap, postSnap: Snap, unitId: string): DocMutation[] {
  const out: DocMutation[] = [];
  const changed = changedCellsBetween(preSnap as P, postSnap as P);
  const preSheets = (preSnap.sheets ?? {}) as Record<string, P>;
  const postSheets = (postSnap.sheets ?? {}) as Record<string, P>;

  // 单元格：恢复 pre 值；post 有 pre 无的键显式写 null（set-range-values 的
  // null 语义是删除该键/清空单元格）。
  for (const [sid, cells] of changed.cells) {
    if (!preSheets[sid]) continue; // 被删 sheet 已由 insert-sheet 整体恢复
    const preCD = (preSheets[sid]?.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const postCD = (postSheets[sid]?.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const cellValue: Record<string, Record<string, unknown>> = {};
    for (const rc of cells) {
      const [r, c] = rc.split(",").map(Number) as [number, number];
      const preCell = preCD[String(r)]?.[String(c)] as P | undefined;
      const postCell = postCD[String(r)]?.[String(c)] as P | undefined;
      let row = cellValue[String(r)];
      if (!row) {
        row = {};
        cellValue[String(r)] = row;
      }
      if (preCell === undefined) {
        row[String(c)] = null;
        continue;
      }
      const restored = JSON.parse(JSON.stringify(preCell)) as P;
      if (postCell) {
        for (const k of Object.keys(postCell)) {
          if (!(k in restored)) restored[k] = null;
        }
      }
      row[String(c)] = restored;
    }
    out.push(mut(M.setRangeValues, { unitId, subUnitId: sid, cellValue }));
  }

  // 元数据
  const metaSet = new Set(changed.meta);
  for (const m of changed.meta) {
    if (m.startsWith("sheet:")) continue; // 增删 sheet 已由结构逆对处理
    const dot = m.indexOf(".");
    if (dot <= 0) continue;
    const sid = m.slice(0, dot);
    const key = m.slice(dot + 1);
    const preS = preSheets[sid];
    if (!preS) continue;
    if (key === "mergeData") {
      const preM = (preS.mergeData ?? []) as R[];
      const postM = (postSheets[sid]?.mergeData ?? []) as R[];
      const eq = (a: R, b: R) =>
        a.startRow === b.startRow &&
        a.endRow === b.endRow &&
        a.startColumn === b.startColumn &&
        a.endColumn === b.endColumn;
      const toRemove = postM.filter((x) => !preM.some((y) => eq(x, y)));
      const toAdd = preM.filter((x) => !postM.some((y) => eq(x, y)));
      if (toRemove.length)
        out.push(mut(M.removeMerge, { unitId, subUnitId: sid, ranges: toRemove }));
      if (toAdd.length) out.push(mut(M.addMerge, { unitId, subUnitId: sid, ranges: toAdd }));
    } else if (key === "rowData") {
      const preRD = (preS.rowData ?? {}) as Record<string, P>;
      const postRD = (postSheets[sid]?.rowData ?? {}) as Record<string, P>;
      const rows = new Set([...Object.keys(preRD), ...Object.keys(postRD)]);
      const heightByRow: Record<string, unknown> = {};
      const autoByRow: Record<string, unknown> = {};
      const touched: R[] = [];
      let hasHeight = false;
      let hasAuto = false;
      for (const r of rows) {
        const a = preRD[r];
        const b = postRD[r];
        if (JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})) continue;
        const range = { startRow: Number(r), endRow: Number(r), startColumn: 0, endColumn: 0 };
        touched.push(range);
        if (Boolean(a?.hd) !== Boolean(b?.hd)) {
          out.push(
            mut(a?.hd ? M.setRowHidden : M.setRowVisible, {
              unitId,
              subUnitId: sid,
              ranges: [range],
            }),
          );
        }
        if ((a?.h ?? null) !== (b?.h ?? null)) {
          heightByRow[r] = a?.h ?? (preS.defaultRowHeight as number | undefined) ?? 24;
          hasHeight = true;
        }
        for (const k of ["ia", "ah"] as const) {
          if ((a?.[k] ?? null) !== (b?.[k] ?? null)) {
            autoByRow[r] = (a?.[k] ?? null) as number | boolean | null;
            hasAuto = true;
          }
        }
      }
      if (hasHeight)
        out.push(
          mut(M.setRowHeight, { unitId, subUnitId: sid, ranges: touched, rowHeight: heightByRow }),
        );
      if (hasAuto)
        out.push(
          mut("sheet.mutation.set-worksheet-row-is-auto-height", {
            unitId,
            subUnitId: sid,
            ranges: touched,
            autoHeightInfo: autoByRow,
          }),
        );
    } else if (key === "columnData") {
      const preCD = (preS.columnData ?? {}) as Record<string, P>;
      const postCD = (postSheets[sid]?.columnData ?? {}) as Record<string, P>;
      const cols = new Set([...Object.keys(preCD), ...Object.keys(postCD)]);
      const widthByCol: Record<string, unknown> = {};
      const touched: R[] = [];
      let hasWidth = false;
      for (const c of cols) {
        const a = preCD[c];
        const b = postCD[c];
        if (JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})) continue;
        const range = { startRow: 0, endRow: 0, startColumn: Number(c), endColumn: Number(c) };
        touched.push(range);
        if (Boolean(a?.hd) !== Boolean(b?.hd)) {
          out.push(
            mut(a?.hd ? M.setColHidden : M.setColVisible, {
              unitId,
              subUnitId: sid,
              ranges: [range],
            }),
          );
        }
        if ((a?.w ?? null) !== (b?.w ?? null)) {
          widthByCol[c] = a?.w ?? (preS.defaultColumnWidth as number | undefined) ?? 88;
          hasWidth = true;
        }
      }
      if (hasWidth)
        out.push(
          mut(M.setColWidth, { unitId, subUnitId: sid, ranges: touched, colWidth: widthByCol }),
        );
    } else if (key === "freeze") {
      out.push(mut(M.setFrozen, { unitId, subUnitId: sid, ...(preS.freeze as P) }));
    } else if (key === "name") {
      out.push(mut(M.setName, { unitId, subUnitId: sid, name: preS.name }));
    }
  }
  if (metaSet.has("workbook.sheetOrder")) {
    const preOrder = [...(preSnap.sheetOrder ?? [])];
    const postOrder = [...((postSnap.sheetOrder as string[] | undefined) ?? [])].filter(
      (x): x is string => x != null,
    );
    // setOrder 只能移动已在 sheetOrder 的条目；存在于 sheets 但缺槽位的表只能删了重插。
    const order = [...postOrder];
    for (let i = 0; i < preOrder.length; i++) {
      const want = preOrder[i] as string;
      const j = order.indexOf(want);
      if (j === i) continue;
      if (j < 0) {
        if (postSheets[want] !== undefined) {
          out.push(
            mut(M.removeSheet, { unitId, subUnitId: want, subUnitName: postSheets[want]?.name }),
          );
          out.push(
            mut(M.insertSheet, {
              unitId,
              index: i,
              sheet: JSON.parse(JSON.stringify(postSheets[want])),
            }),
          );
          order.splice(i, 0, want);
        }
        continue;
      }
      out.push(mut(M.setOrder, { unitId, subUnitId: want, fromOrder: j, toOrder: i }));
      order.splice(j, 1);
      order.splice(i, 0, want);
    }
  }
  return out;
}

/** 资源对账（filter / DV / CF 三插件按 sheet 规则级恢复）。 */
function resourceRestores(preSnap: Snap, postSnap: Snap, unitId: string): DocMutation[] {
  const out: DocMutation[] = [];
  const getRes = (s: Snap, name: string): Record<string, unknown> => {
    const r = (s.resources ?? []).find((x) => x.name === name);
    if (!r || typeof r.data !== "string" || r.data === "") return {};
    try {
      return JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const preF = getRes(preSnap, "SHEET_FILTER_PLUGIN");
  const postF = getRes(postSnap, "SHEET_FILTER_PLUGIN");
  for (const [sid, a] of Object.entries(preF)) {
    const b = postF[sid];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const ref = (a as P).ref;
    if (ref) {
      out.push(
        mut(M.setFilterRange, {
          unitId,
          subUnitId: sid,
          range: ref,
          filteredOutRows: (a as P).cachedFilteredOut ?? [],
        }),
      );
    }
  }
  for (const sid of Object.keys(postF)) {
    if (!(sid in preF)) out.push(mut(M.removeFilter, { unitId, subUnitId: sid }));
  }
  const preDV = getRes(preSnap, "SHEET_DATA_VALIDATION_PLUGIN");
  const postDV = getRes(postSnap, "SHEET_DATA_VALIDATION_PLUGIN");
  for (const sid of new Set([...Object.keys(preDV), ...Object.keys(postDV)])) {
    const preRules = new Map(
      ((preDV[sid] as unknown[]) ?? []).map((r) => [(r as P).uid ?? (r as P).id, r]),
    );
    const postRules = new Map(
      ((postDV[sid] as unknown[]) ?? []).map((r) => [(r as P).uid ?? (r as P).id, r]),
    );
    for (const [id, rule] of postRules) {
      const a = preRules.get(id);
      if (JSON.stringify(a) !== JSON.stringify(rule)) {
        out.push(mut(M.dvRemove, { unitId, subUnitId: sid, ruleId: id }));
        if (a !== undefined) out.push(mut(M.dvAdd, { unitId, subUnitId: sid, rule: a }));
      }
    }
    for (const [id, rule] of preRules) {
      if (!postRules.has(id)) out.push(mut(M.dvAdd, { unitId, subUnitId: sid, rule }));
    }
  }
  const preCF = getRes(preSnap, "SHEET_CONDITIONAL_FORMATTING_PLUGIN");
  const postCF = getRes(postSnap, "SHEET_CONDITIONAL_FORMATTING_PLUGIN");
  for (const sid of new Set([...Object.keys(preCF), ...Object.keys(postCF)])) {
    const preRules = new Map(
      ((preCF[sid] as unknown[]) ?? []).map((r) => [(r as P).cfId ?? (r as P).id, r]),
    );
    const postRules = new Map(
      ((postCF[sid] as unknown[]) ?? []).map((r) => [(r as P).cfId ?? (r as P).id, r]),
    );
    for (const [id, rule] of postRules) {
      const a = preRules.get(id);
      if (JSON.stringify(a) !== JSON.stringify(rule)) {
        out.push(mut(M.cfDelete, { unitId, subUnitId: sid, cfId: id }));
        if (a !== undefined)
          out.push(mut(M.cfAdd, { unitId, subUnitId: sid, rule: (a as P).rule ?? a }));
      }
    }
    for (const [id, rule] of preRules) {
      if (!postRules.has(id))
        out.push(mut(M.cfAdd, { unitId, subUnitId: sid, rule: (rule as P).rule ?? rule }));
    }
  }
  return out;
}

/** 前像逆操作包。 */
export interface InverseResult {
  inverse: DocMutation[];
}

/** 为一整个提交生成逆 mutation（emitted = 本修订实际发射的 mutation 序列）。 */
export function makeInverse(
  preSnap: Snap,
  postSnap: Snap,
  emitted: DocMutation[],
  unitId: string,
): InverseResult {
  return {
    inverse: [
      ...structuralInverses(emitted, preSnap, unitId),
      ...dataRestores(preSnap, postSnap, unitId),
      ...resourceRestores(preSnap, postSnap, unitId),
    ],
  };
}

/** dryRun 回滚后二次对账：以 pre 为准补齐残余数据级差异（结构逆放落点不精时兜底）。 */
export function reconcile(preSnap: Snap, currentSnap: Snap, unitId: string): DocMutation[] {
  return [
    ...dataRestores(preSnap, currentSnap, unitId),
    ...resourceRestores(preSnap, currentSnap, unitId),
  ];
}
