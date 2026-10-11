// A1b：传输层修补与悬空样式引用检测。
//
// 规则清单（每条标注"通用/专用"）：
//  R-styles-subset  [专用 insert-sheet] 在 params 里补 `styles` 子集（发送方样式表中
//                   该 sheet 引用到的条目）。mutation handler 原生支持 styles 字段。
//  R-styles-inline  [专用 insert-sheet] 把 params.sheet 内所有 `.s` 样式 id 就地展开成
//                   完整样式对象——B 无需查样式表即可渲染，但后续引用该 id 的 mutation
//                   仍会悬空（策略局限，量化见 a1b-copy-sheet.ts）。
//  R-filter-reconcile [通用] 操作结束后，发送方把 SHEET_FILTER_PLUGIN 资源中
//                   各 subUnit 的 ref/filterColumns/cachedFilteredOut 与"接收方应有值"
//                   对照，对漂移的 subUnit 合成一条 sheet.mutation.set-filter-range。
//                   适用于任何操作类型（漂移来自 filter 自动扩展监听器的批内求值时序）。

import type { CapturedMutation } from "./univer-node.ts";

type P = Record<string, unknown>;

interface SnapshotLike {
  sheets?: Record<string, P>;
  styles?: Record<string, unknown>;
  resources?: Array<{ name?: string; data?: unknown }>;
}

// 收集一个对象树内所有 `.s` 字符串值
export function collectStyleIds(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectStyleIds(v, out);
    return out;
  }
  const o = node as P;
  if (typeof o.s === "string") out.add(o.s);
  for (const v of Object.values(o)) collectStyleIds(v, out);
  return out;
}

export interface FixupResult {
  mutation: CapturedMutation;
  fixups: string[];
  addedBytes: number;
}

// 策略 A：补 styles 子集；策略 B：内联展开
export function fixupInsertSheet(
  m: CapturedMutation,
  senderStyles: Record<string, unknown>,
  strategy: "styles-subset" | "inline",
): FixupResult {
  const params = JSON.parse(JSON.stringify(m.params)) as P;
  const sheet = params.sheet as P | undefined;
  if (!sheet) return { mutation: m, fixups: [], addedBytes: 0 };
  const referenced = collectStyleIds(sheet);
  if (strategy === "styles-subset") {
    const subset: Record<string, unknown> = {};
    let missing = 0;
    for (const id of referenced) {
      if (id in senderStyles) subset[id] = senderStyles[id];
      else missing += 1;
    }
    if (Object.keys(subset).length > 0) params.styles = subset;
    const bytes = JSON.stringify(params).length - JSON.stringify(m.params).length;
    return {
      mutation: { id: m.id, params },
      fixups: [
        `styles-subset(+${Object.keys(subset).length} styles${missing ? `,${missing} missing` : ""})`,
      ],
      addedBytes: bytes,
    };
  }
  // inline：把引用对象就地换成样式内容
  let inlined = 0;
  const expand = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) expand(v);
      return;
    }
    const o = node as P;
    if (typeof o.s === "string" && o.s in senderStyles) {
      o.s = JSON.parse(JSON.stringify(senderStyles[o.s]));
      inlined += 1;
    }
    for (const v of Object.values(o)) expand(v);
  };
  expand(sheet);
  const bytes = JSON.stringify(params).length - JSON.stringify(m.params).length;
  return {
    mutation: { id: m.id, params },
    fixups: [`inline(${inlined} cells)`],
    addedBytes: bytes,
  };
}

// 通用入口：对任意 mutation 应用适用的修补规则
export function fixupMutationForTransport(
  m: CapturedMutation,
  senderSnapshot: SnapshotLike,
  strategy: "styles-subset" | "inline" | "none" = "styles-subset",
): FixupResult {
  if (m.id === "sheet.mutation.insert-sheet" && strategy !== "none") {
    return fixupInsertSheet(m, senderSnapshot.styles ?? {}, strategy);
  }
  return { mutation: m, fixups: [], addedBytes: 0 };
}

// 悬空样式引用检测：快照中所有 .s 引用 - styles 表 key 的差集
export function findDanglingStyleRefs(snap: SnapshotLike): Array<{ sheetId: string; s: string }> {
  const known = new Set(Object.keys(snap.styles ?? {}));
  const dangling: Array<{ sheetId: string; s: string }> = [];
  for (const [sid, sheet] of Object.entries(snap.sheets ?? {})) {
    const ids = collectStyleIds(sheet);
    for (const id of ids) if (!known.has(id)) dangling.push({ sheetId: sid, s: id });
  }
  return dangling;
}

// ── R-filter-reconcile ──

export interface FilterResourceEntry {
  ref?: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  filterColumns?: unknown;
  cachedFilteredOut?: unknown;
}

export function parseFilterResource(snap: SnapshotLike): Record<string, FilterResourceEntry> {
  const res = (snap.resources ?? []).find((r) => r.name === "SHEET_FILTER_PLUGIN");
  if (!res || typeof res.data !== "string" || res.data === "") return {};
  try {
    return JSON.parse(res.data) as Record<string, FilterResourceEntry>;
  } catch {
    return {};
  }
}

// 以发送方 filter 资源为准，为漂移的 subUnit 合成 set-filter-range mutation
export function reconcileFilterResource(
  senderSnap: SnapshotLike,
  receiverSnap: SnapshotLike,
  unitId: string,
): CapturedMutation[] {
  const a = parseFilterResource(senderSnap);
  const b = parseFilterResource(receiverSnap);
  const out: CapturedMutation[] = [];
  for (const [sub, entry] of Object.entries(a)) {
    const bb = b[sub];
    const same =
      bb !== undefined &&
      JSON.stringify(bb.ref) === JSON.stringify(entry.ref) &&
      JSON.stringify(bb.filterColumns ?? []) === JSON.stringify(entry.filterColumns ?? []) &&
      JSON.stringify(bb.cachedFilteredOut ?? []) === JSON.stringify(entry.cachedFilteredOut ?? []);
    if (!same && entry.ref) {
      out.push({
        id: "sheet.mutation.set-filter-range",
        params: {
          unitId,
          subUnitId: sub,
          range: entry.ref,
          filteredOutRows: entry.cachedFilteredOut ?? [],
        },
      });
    }
  }
  return out;
}
