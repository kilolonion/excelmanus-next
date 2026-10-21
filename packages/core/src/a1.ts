// A1 地址/区域解析与运算（06 §4：Sheet1!A1:D20，行列 1 起算，
// 工作表名含空格或特殊字符时加单引号）。

/** Excel 上限：整列/整行区域收敛到这两个界内，保证运算是有限矩形。 */
export const MAX_COL = 16384; // XFD
export const MAX_ROW = 1048576;

/** 归一化后的区域：col/row 均为 1 起算的闭区间。 */
export interface A1Range {
  sheet?: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

const CELL = /^([A-Za-z]{1,3})([0-9]{1,7})$/;

export function colToIndex(col: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(col)) {
    throw new Error(`非法列名: ${col}`);
  }
  let n = 0;
  for (const c of col.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  if (n < 1 || n > MAX_COL) throw new Error(`列名越界: ${col}`);
  return n;
}

export function indexToCol(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_COL) {
    throw new Error(`非法列号: ${index}`);
  }
  let n = index;
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** 拆分 "Sheet!区域" 前缀；工作表名可用单引号包裹（内部 '' 转义为 '）。 */
function splitSheet(input: string): { sheet?: string; body: string } {
  const bang = input.lastIndexOf("!");
  if (bang < 0) return { body: input };
  const raw = input.slice(0, bang);
  const body = input.slice(bang + 1);
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return { sheet: raw.slice(1, -1).replaceAll("''", "'"), body };
  }
  return { sheet: raw, body };
}

function parseHalf(ref: string): { col: number; row: number } | null {
  const m = CELL.exec(ref);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const col = colToIndex(m[1]);
  const row = Number(m[2]);
  if (!Number.isInteger(row) || row < 1 || row > MAX_ROW) {
    throw new Error(`行号越界: ${ref}`);
  }
  return { col, row };
}

/**
 * 解析 A1 区域：A1 / A1:D20 / A:C（整列）/ 3:7（整行），可带工作表前缀。
 * 非法输入抛 Error。
 */
export function parseRange(input: string): A1Range {
  const { sheet, body } = splitSheet(input.trim());
  if (!body || sheet === "" || body.split(":").length > 2) throw new Error(`非法区域: ${input}`);
  const [a, b] = body.split(":", 2);
  if (a === undefined) throw new Error(`非法区域: ${input}`);

  if (b === undefined) {
    // 单格
    const cell = parseHalf(a);
    if (!cell) throw new Error(`非法区域: ${input}`);
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      startCol: cell.col,
      startRow: cell.row,
      endCol: cell.col,
      endRow: cell.row,
    };
  }

  const aCell = parseHalf(a);
  const bCell = parseHalf(b);
  if (aCell && bCell) {
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      startCol: Math.min(aCell.col, bCell.col),
      startRow: Math.min(aCell.row, bCell.row),
      endCol: Math.max(aCell.col, bCell.col),
      endRow: Math.max(aCell.row, bCell.row),
    };
  }
  // 整列 A:C
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
    const c1 = colToIndex(a);
    const c2 = colToIndex(b);
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      startCol: Math.min(c1, c2),
      startRow: 1,
      endCol: Math.max(c1, c2),
      endRow: MAX_ROW,
    };
  }
  // 整行 3:7
  if (/^[0-9]{1,7}$/.test(a) && /^[0-9]{1,7}$/.test(b)) {
    const r1 = Number(a);
    const r2 = Number(b);
    if (r1 < 1 || r2 < 1 || r1 > MAX_ROW || r2 > MAX_ROW) {
      throw new Error(`行号越界: ${input}`);
    }
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      startCol: 1,
      startRow: Math.min(r1, r2),
      endCol: MAX_COL,
      endRow: Math.max(r1, r2),
    };
  }
  throw new Error(`非法区域: ${input}`);
}

/** 工作表是否同表：都指明且不同 → false；一方未指明视为同表。 */
function sameSheet(a: A1Range, b: A1Range): boolean {
  if (a.sheet === undefined || b.sheet === undefined) return true;
  return a.sheet === b.sheet;
}

export function intersects(a: A1Range, b: A1Range): boolean {
  if (!sameSheet(a, b)) return false;
  return (
    a.startCol <= b.endCol &&
    b.startCol <= a.endCol &&
    a.startRow <= b.endRow &&
    b.startRow <= a.endRow
  );
}

/** 相交部分；不相交或不同表返回 null。 */
export function intersection(a: A1Range, b: A1Range): A1Range | null {
  if (!intersects(a, b)) return null;
  return {
    ...(a.sheet !== undefined
      ? { sheet: a.sheet }
      : b.sheet !== undefined
        ? { sheet: b.sheet }
        : {}),
    startCol: Math.max(a.startCol, b.startCol),
    startRow: Math.max(a.startRow, b.startRow),
    endCol: Math.min(a.endCol, b.endCol),
    endRow: Math.min(a.endRow, b.endRow),
  };
}

/** 覆盖两个区域的最小矩形；不同表返回 null。 */
export function union(a: A1Range, b: A1Range): A1Range | null {
  if (!sameSheet(a, b)) return null;
  return {
    ...(a.sheet !== undefined
      ? { sheet: a.sheet }
      : b.sheet !== undefined
        ? { sheet: b.sheet }
        : {}),
    startCol: Math.min(a.startCol, b.startCol),
    startRow: Math.min(a.startRow, b.startRow),
    endCol: Math.max(a.endCol, b.endCol),
    endRow: Math.max(a.endRow, b.endRow),
  };
}

export function formatRange(r: A1Range): string {
  const sheet =
    r.sheet !== undefined
      ? /^\w+$/.test(r.sheet)
        ? `${r.sheet}!`
        : `'${r.sheet.replaceAll("'", "''")}'!`
      : "";
  const cell = (c: number, row: number) => `${indexToCol(c)}${row}`;
  if (r.startCol === 1 && r.endCol === MAX_COL) {
    // 整行
    return `${sheet}${r.startRow}:${r.endRow}`;
  }
  if (r.startRow === 1 && r.endRow === MAX_ROW) {
    return `${sheet}${indexToCol(r.startCol)}:${indexToCol(r.endCol)}`;
  }
  if (r.startCol === r.endCol && r.startRow === r.endRow) {
    return `${sheet}${cell(r.startCol, r.startRow)}`;
  }
  return `${sheet}${cell(r.startCol, r.startRow)}:${cell(r.endCol, r.endRow)}`;
}
