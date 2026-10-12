// Univer 主题：主色与灰阶取自应用 token（一代玉绿 #0b6b4f、偏绿冷灰），
// 让选区、列头高亮、工作表标签与公式栏和应用其余部分一致。深色模式由 Univer 按灰阶反转。

import { defaultTheme, type Theme } from "@univerjs/presets";

export const jadeTheme: Theme = {
  ...defaultTheme,
  primary: {
    50: "#ECF6F1",
    100: "#D6EDE2",
    200: "#AFDAC6",
    300: "#7DC2A4",
    400: "#3B9B74",
    500: "#1A825F",
    600: "#0B6B4F",
    700: "#095A43",
    800: "#074836",
    900: "#05372A",
  },
  gray: {
    0: "#FFFFFF",
    50: "#F6F8F6",
    100: "#EEF2F0",
    200: "#DCE7E0",
    300: "#B4C2BB",
    400: "#84958C",
    500: "#55655D",
    600: "#36443D",
    700: "#28332E",
    800: "#1F2925",
    900: "#17211C",
    1000: "#000000",
  },
};

const THEME_TEXT = new Set(Object.values(jadeTheme.gray).map((c) => String(c).toLowerCase()));

/**
 * 单元格编辑框提交时，Univer 会把主题文字色写成单元格样式 `{ cl }`；它不是用户设置的格式，
 * 留着会把主题色写进用户文件（CSV 还会因此被拒）。只处理编辑框产生的 set-range-values。
 */
export function dropEditorThemeColor<T extends { id: string; params: unknown }>(mutation: T): T {
  const p = mutation.params as {
    trigger?: unknown;
    cellValue?: Record<string, Record<string, { s?: unknown } | null>>;
  };
  if (
    mutation.id !== "sheet.mutation.set-range-values" ||
    p?.trigger !== "sheet.command.set-range-values"
  )
    return mutation;
  let changed = false;
  const cellValue: typeof p.cellValue = {};
  for (const [r, row] of Object.entries(p.cellValue ?? {})) {
    cellValue[r] = {};
    for (const [c, cell] of Object.entries(row ?? {})) {
      const s = cell?.s as { cl?: { rgb?: unknown } } | undefined;
      const onlyColor = s && typeof s === "object" && Object.keys(s).length === 1 && s.cl;
      if (onlyColor && THEME_TEXT.has(String(s.cl?.rgb).toLowerCase())) {
        cellValue[r][c] = { ...cell, s: null };
        changed = true;
      } else cellValue[r][c] = cell;
    }
  }
  return changed ? { ...mutation, params: { ...p, cellValue } } : mutation;
}
