import { indexToCol } from "@excelmanus/core";
import type { IColumnData, IRowData } from "@univerjs/core";

type AxisData = Record<number, Partial<IRowData | IColumnData>>;
type AxisState = { level: number; hidden: boolean; collapsed: boolean };

export function axisOutlineRanges(data: AxisData | undefined, axis: "rows" | "cols") {
  const spans: (AxisState & { start: number; end: number })[] = [];
  const items = data ?? {};
  for (const index of Object.keys(items)
    .map(Number)
    .sort((a, b) => a - b)) {
    const item = items[index];
    const rawLevel = item.custom?.excelmanusOutlineLevel;
    const level = typeof rawLevel === "number" ? rawLevel : 0;
    const hidden = item.hd === 1;
    const collapsed = item.custom?.excelmanusCollapsed === true;
    if (!level && !hidden && !collapsed) continue;
    const previous = spans.at(-1);
    if (
      previous?.end === index - 1 &&
      previous.level === level &&
      previous.hidden === hidden &&
      previous.collapsed === collapsed
    ) {
      previous.end = index;
    } else {
      spans.push({ start: index, end: index, level, hidden, collapsed });
    }
  }
  const label = (index: number) => (axis === "rows" ? String(index + 1) : indexToCol(index + 1));
  return spans.map(({ start, end, ...state }) => ({
    range: start === end ? label(start) : `${label(start)}:${label(end)}`,
    ...state,
  }));
}

const OUTLINE_DEFAULTS = {
  summaryBelow: true,
  summaryRight: true,
  showOutlineSymbols: true,
  applyStyles: false,
};

export function outlineSettings(attributes: Record<string, string> | undefined) {
  return (Object.keys(OUTLINE_DEFAULTS) as (keyof typeof OUTLINE_DEFAULTS)[]).map((key) => {
    const raw = attributes?.[key];
    const normalized = raw?.toLowerCase();
    return {
      key,
      value:
        raw === undefined
          ? OUTLINE_DEFAULTS[key]
          : normalized === "1" || normalized === "true" || normalized === "on"
            ? true
            : normalized === "0" || normalized === "false" || normalized === "off"
              ? false
              : null,
      raw,
    };
  });
}
