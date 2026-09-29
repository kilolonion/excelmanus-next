// 严格快照比较器：结构化深比较（忽略对象 key 顺序），返回所有差异路径。
// ignore 规则是唯一豁免通道——必须逐条在报告中解释。

export interface DiffEntry {
  path: string;
  a: unknown;
  b: unknown;
}

export type IgnoreRule = (path: string[], a: unknown, b: unknown) => boolean;

export function deepDiff(
  a: unknown,
  b: unknown,
  path: string[] = [],
  ignore: IgnoreRule[] = [],
  out: DiffEntry[] = [],
  maxDiffs = 5000,
): DiffEntry[] {
  if (ignore.some((rule) => rule(path, a, b))) return out;
  if (out.length >= maxDiffs) return out;

  if (a === b) return out;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb || a === null || b === null || ta !== "object") {
    // 数字容差不放宽——浮点差异如实报
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
      out.push({
        path: `${path.join(".")}.length`,
        a: aa.length,
        b: bb.length,
      });
    }
    for (let i = 0; i < Math.max(aa.length, bb.length) && out.length < maxDiffs; i++) {
      deepDiff(aa[i], bb[i], [...path, String(i)], ignore, out, maxDiffs);
    }
    return out;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (out.length >= maxDiffs) break;
    const hasA = Object.hasOwn(ao, k);
    const hasB = Object.hasOwn(bo, k);
    if (!hasA || !hasB) {
      deepDiff(ao[k], bo[k], [...path, k], ignore, out, maxDiffs);
      continue;
    }
    deepDiff(ao[k], bo[k], [...path, k], ignore, out, maxDiffs);
  }
  return out;
}

// ── 语义规范化：Univer 的 styles 表 key 是随机 id（同一内容在 A/B 得到不同 id）。
// 按"内容→规范键"重映射 styles 与所有 .s 引用后再比较。这不是忽略规则：
// 样式内容与"哪些单元格引用哪份样式"仍然全量参与比较。

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

type SnapLike = Record<string, unknown>;

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function normalizeSnapshot(input: unknown): SnapLike {
  const snap = JSON.parse(JSON.stringify(input)) as SnapLike;
  const styles = (snap.styles ?? {}) as Record<string, unknown>;
  const canon = new Map<string, string>();
  const newStyles: Record<string, unknown> = {};
  for (const [id, style] of Object.entries(styles)) {
    const key = stableStringify(style);
    canon.set(id, key);
    newStyles[key] = style;
  }
  snap.styles = newStyles;
  // DV/CF 等插件 resource 的 data 是 "sheetId → 规则数组" 的 JSON 字符串；
  // "sheetId: []" 与缺 key 语义相同（命令路径登记空条目，复现路径不登记）。
  const RESOURCES_WITH_EMPTY_LISTS = new Set([
    "SHEET_DATA_VALIDATION_PLUGIN",
    "SHEET_CONDITIONAL_FORMATTING_PLUGIN",
    "SHEET_FILTER_PLUGIN",
    "SHEET_DEFINED_NAME_PLUGIN",
  ]);
  for (const res of (snap.resources ?? []) as Array<{ name?: string; data?: unknown }>) {
    if (!res.name || res.data === undefined || res.data === null) continue;
    // 5) 插件惰性初始化："":（从未初始化）与 "{}"（初始化后为空）等价；
    //    data 可能是 JSON 字符串，也可能已是对象
    const asObj = typeof res.data === "string" ? safeParse(res.data) : res.data;
    if (asObj && typeof asObj === "object" && Object.keys(asObj as object).length === 0) {
      res.data = "";
      continue;
    }
    if (typeof res.data !== "string" || !RESOURCES_WITH_EMPTY_LISTS.has(res.name)) continue;
    try {
      const map = JSON.parse(res.data) as Record<string, unknown>;
      for (const k of Object.keys(map)) {
        const v = map[k];
        if (Array.isArray(v) && v.length === 0) delete map[k];
      }
      const cleaned = stableStringify(map);
      res.data = cleaned === "{}" ? "" : cleaned;
    } catch {
      // 非 JSON 原样保留
    }
  }
  const remap = (cell: unknown) => {
    if (cell && typeof cell === "object") {
      const o = cell as Record<string, unknown>;
      if (typeof o.s === "string" && canon.has(o.s)) o.s = canon.get(o.s);
      // 表示层归一（T5 undo 路径产物）：
      // 1) boolean 单元格经重写后 v:false→0（t:3 保留语义），统一成数值形态
      if (o.t === 3 && typeof o.v === "boolean") o.v = o.v ? 1 : 0;
      // 2) 显式 t 字段若与 v 的推断类型一致则去掉（未改写的单元格常缺省 t）
      const inferred =
        typeof o.v === "string"
          ? 1
          : typeof o.v === "number"
            ? 2
            : typeof o.v === "boolean"
              ? 3
              : undefined;
      if (o.t !== undefined && inferred !== undefined && o.t === inferred) delete o.t;
    }
  };
  const sheets = (snap.sheets ?? {}) as Record<string, SnapLike>;
  for (const sheet of Object.values(sheets)) {
    const cellData = (sheet.cellData ?? {}) as Record<string, Record<string, unknown>>;
    for (const row of Object.values(cellData)) for (const cell of Object.values(row)) remap(cell);
    const rowData = (sheet.rowData ?? {}) as Record<string, SnapLike>;
    for (const row of Object.values(rowData)) {
      remap(row);
      // 3) hd:0（显式“未隐藏”）与缺省等价
      if (row && typeof row === "object" && row.hd === 0) delete row.hd;
    }
    const colData = (sheet.columnData ?? {}) as Record<string, SnapLike>;
    for (const col of Object.values(colData)) {
      remap(col);
      if (col && typeof col === "object" && col.hd === 0) delete col.hd;
    }
    // 5) undo 后残留的"全默认"rowData/columnData 空条目 ≡ 缺省
    for (const [k, row] of Object.entries(rowData)) {
      if (row && typeof row === "object" && Object.keys(row).length === 0) delete rowData[k];
    }
    for (const [k, col] of Object.entries(colData)) {
      if (col && typeof col === "object" && Object.keys(col).length === 0) delete colData[k];
    }
  }
  // 4) 丢弃未被任何单元格/行/列引用的样式（undo 不清 styles 表，为 append-only 语义）
  const referenced = new Set<string>();
  for (const sheet of Object.values(sheets)) {
    const scan = (cell: unknown) => {
      const o = cell as SnapLike | undefined;
      if (o && typeof o.s === "string") referenced.add(o.s);
    };
    for (const row of Object.values(
      (sheet.cellData ?? {}) as Record<string, Record<string, unknown>>,
    ))
      for (const cell of Object.values(row)) scan(cell);
    for (const row of Object.values((sheet.rowData ?? {}) as Record<string, unknown>)) scan(row);
    for (const col of Object.values((sheet.columnData ?? {}) as Record<string, unknown>)) scan(col);
  }
  for (const k of Object.keys(snap.styles as Record<string, unknown>)) {
    if (!referenced.has(k)) delete (snap.styles as Record<string, unknown>)[k];
  }
  return snap;
}

// ── T4 用：两份快照间"实际发生变化的单元格/区域"集合 ──

export interface ChangedCells {
  // sheetId -> Set<"r,c">
  cells: Map<string, Set<string>>;
  // 非单元格差异的路径（结构、样式表、行高列宽、mergeData 等）
  meta: string[];
}

export function changedCellsBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangedCells {
  const cells = new Map<string, Set<string>>();
  const meta: string[] = [];
  const bSheets = (before.sheets ?? {}) as Record<string, Record<string, unknown>>;
  const aSheets = (after.sheets ?? {}) as Record<string, Record<string, unknown>>;
  const sheetIds = new Set([...Object.keys(bSheets), ...Object.keys(aSheets)]);
  for (const sid of sheetIds) {
    const sb = bSheets[sid];
    const sa = aSheets[sid];
    if (!sb || !sa) {
      meta.push(`sheet:${sid} added/removed`);
      continue;
    }
    const cb = (sb.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const ca = (sa.cellData ?? {}) as Record<string, Record<string, unknown>>;
    const set = new Set<string>();
    const rows = new Set([...Object.keys(cb), ...Object.keys(ca)]);
    for (const r of rows) {
      const rb = cb[r] ?? {};
      const ra = ca[r] ?? {};
      const cols = new Set([...Object.keys(rb), ...Object.keys(ra)]);
      for (const c of cols) {
        const diffs = deepDiff(rb[c], ra[c], [], [], []);
        if (diffs.length > 0) set.add(`${r},${c}`);
      }
    }
    if (set.size > 0) cells.set(sid, set);
    // 非 cellData 字段差异（mergeData/rowData/columnData/name/freeze 等）
    const otherKeys = [...new Set([...Object.keys(sb), ...Object.keys(sa)])].filter(
      (k) => k !== "cellData",
    );
    for (const k of otherKeys) {
      if (deepDiff(sb[k], sa[k], [], [], []).length > 0) {
        meta.push(`${sid}.${k}`);
      }
    }
  }
  // workbook 级差异（sheetOrder、styles、resources、name 等）
  const wbKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => k !== "sheets",
  );
  for (const k of wbKeys) {
    if (deepDiff(before[k], after[k], [], [], []).length > 0) {
      meta.push(`workbook.${k}`);
    }
  }
  return { cells, meta };
}
