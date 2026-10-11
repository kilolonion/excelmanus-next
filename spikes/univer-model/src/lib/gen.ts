// 快照生成：大文档（T1/T2）与小文档（T3/T4/T5）

import type { IWorkbookData } from "@univerjs/core";

import type { Prng } from "./prng.ts";

export interface CellStyle {
  bl?: 0 | 1;
  fs?: number;
  bg?: { rgb: string };
  n?: { pattern: string };
}

// 20 种样式表（粗体/背景色/数字格式/字号混合）
export function genStyleTable(): Record<string, CellStyle> {
  const styles: Record<string, CellStyle> = {};
  const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"];
  const patterns = ["0.00", "0.0%", "yyyy-mm-dd", "#,##0", "0.000e+00"];
  for (let i = 0; i < 20; i++) {
    const s: CellStyle = {};
    if (i % 2 === 0) s.bl = 1;
    if (i % 3 === 0) s.bg = { rgb: colors[i % colors.length] as string };
    if (i % 5 === 0) s.n = { pattern: patterns[i % patterns.length] as string };
    s.fs = 10 + (i % 5) * 2;
    styles[`s${i}`] = s;
  }
  return styles;
}

/**
 * 大文档：单工作表，数值/字符串混合，~20% 单元格带样式引用。
 * cellData 直接用手写稀疏对象，尽量贴近 xlsx 导入产物。
 */
export function genLargeSnapshot(
  unitId: string,
  rows: number,
  cols: number,
  seed: number,
): { snapshot: IWorkbookData; cellCount: number } {
  const rand = createFastRand(seed);
  const styles = genStyleTable();
  const cellData: Record<number, Record<number, unknown>> = {};
  let cellCount = 0;
  for (let r = 0; r < rows; r++) {
    const row: Record<number, unknown> = {};
    for (let c = 0; c < cols; c++) {
      const cell: { v: string | number; s?: string } = {
        v: rand() < 0.5 ? Math.floor(rand() * 1e6) : `t${r}x${c}`,
      };
      if (rand() < 0.2) cell.s = `s${Math.floor(rand() * 20)}`;
      row[c] = cell;
      cellCount += 1;
    }
    cellData[r] = row;
  }
  return {
    snapshot: {
      id: unitId,
      name: "large",
      sheetOrder: ["s1"],
      appVersion: "1.0.2",
      styles,
      sheets: {
        s1: {
          id: "s1",
          name: "Data",
          rowCount: rows,
          columnCount: cols,
          cellData: cellData as never,
        },
      },
    } as unknown as IWorkbookData,
    cellCount,
  };
}

// 更轻的 PRNG 用于大体量生成（速度优先，仍是种子化）
function createFastRand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface SmallSheetSpec {
  id: string;
  name: string;
  rows: number;
  cols: number;
}

/** 小文档：3 工作表 × ~100 行 × 12 列；数值/字符串/布尔/空/简单公式。 */
export function genSmallSnapshot(
  unitId: string,
  prng: Prng,
): {
  snapshot: IWorkbookData;
  sheets: SmallSheetSpec[];
} {
  const styles = genStyleTable();
  const sheets: SmallSheetSpec[] = [
    { id: "s1", name: "Alpha", rows: 100, cols: 12 },
    { id: "s2", name: "Beta", rows: 100, cols: 12 },
    { id: "s3", name: "Gamma", rows: 100, cols: 12 },
  ];
  const sheetsData: Record<string, unknown> = {};
  for (const spec of sheets) {
    const cellData: Record<number, Record<number, unknown>> = {};
    for (let r = 0; r < spec.rows; r++) {
      const row: Record<number, unknown> = {};
      for (let c = 0; c < spec.cols; c++) {
        const roll = prng.next();
        if (roll < 0.35) {
          row[c] = { v: Math.floor(prng.next() * 1000) };
        } else if (roll < 0.55) {
          row[c] = { v: `txt_${spec.id}_${r}_${c}` };
        } else if (roll < 0.62) {
          row[c] = { v: prng.chance(0.5), t: 3 };
        } else if (roll < 0.7) {
          // 简单公式：同行相邻列相加 / SUM 局部区
          if (c >= 2) {
            row[c] = { f: `=A${r + 1}+B${r + 1}` };
          } else if (r <= spec.rows - 10) {
            row[c] = { f: `=SUM(A${r + 1}:A${r + 10})` };
          } else {
            row[c] = { v: Math.floor(prng.next() * 100) };
          }
        }
        // 其余 30% 留空（不写 key）
      }
      if (Object.keys(row).length > 0) cellData[r] = row;
    }
    sheetsData[spec.id] = {
      id: spec.id,
      name: spec.name,
      rowCount: spec.rows,
      columnCount: spec.cols,
      cellData,
    };
  }
  return {
    snapshot: {
      id: unitId,
      name: "small",
      sheetOrder: sheets.map((s) => s.id),
      appVersion: "1.0.2",
      styles,
      sheets: sheetsData as never,
    } as unknown as IWorkbookData,
    sheets,
  };
}
