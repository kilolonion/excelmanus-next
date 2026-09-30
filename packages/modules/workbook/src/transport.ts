// 传输层修补与对账（ADR 0003 第 1 条）：用户工作台产生的 mutation 复现前修补。
//  R-styles-subset   [专用 insert-sheet] 在 params 补 `styles` 子集（发送方样式表中
//                    该 sheet 引用到的条目；1.0.2 copy-sheet 丢样式表）。
//  R-filter-reconcile [通用] 提交后对照发送方/接收方 SHEET_FILTER_PLUGIN 资源，
//                    对漂移的 subUnit 合成 set-filter-range 追加到本修订。

import type { DocMutation } from "./engine.ts";

type P = Record<string, unknown>;

export interface SnapshotLike {
  sheets?: Record<string, P>;
  styles?: Record<string, unknown>;
  resources?: Array<{ name?: string; data?: unknown }>;
}

/** 收集对象树内所有 `.s` 样式引用。 */
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

/** insert-sheet 修补：params.sheet 引用到的样式从发送方样式表取子集补进 params.styles。 */
export function fixupInsertSheet(
  m: DocMutation,
  senderStyles: Record<string, unknown>,
): DocMutation {
  const params = JSON.parse(JSON.stringify(m.params ?? {})) as P;
  const sheet = params.sheet as P | undefined;
  if (!sheet) return m;
  const referenced = collectStyleIds(sheet);
  const subset: Record<string, unknown> = {};
  for (const id of referenced) {
    if (id in senderStyles) subset[id] = senderStyles[id];
  }
  if (Object.keys(subset).length === 0) return m;
  params.styles = subset;
  return { id: m.id, params };
}

/** 通用入口：对适用规则的 mutation 做修补；无发送方快照时 styles 子集为空 → 原样返回。 */
export function fixupMutationForTransport(
  m: DocMutation,
  senderSnapshot?: SnapshotLike,
): DocMutation {
  if (m.id === "sheet.mutation.insert-sheet" && senderSnapshot) {
    return fixupInsertSheet(m, senderSnapshot.styles ?? {});
  }
  return m;
}

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

/** 以发送方 filter 资源为准，为漂移的 subUnit 合成 set-filter-range mutation。 */
export function reconcileFilterResource(
  senderSnap: SnapshotLike,
  receiverSnap: SnapshotLike,
  unitId: string,
): DocMutation[] {
  const a = parseFilterResource(senderSnap);
  const b = parseFilterResource(receiverSnap);
  const out: DocMutation[] = [];
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
