import { formatRange, parseRange, type RangeRef, subtractRanges } from "@excelmanus/core";
import type { ChangeEntry } from "./reduce.ts";

export const CHANGE_HIGHLIGHT_MS = 6000;

export function changeDeadline(change: ChangeEntry): number {
  return Date.parse(change.at ?? "") + CHANGE_HIGHLIGHT_MS;
}

export interface ChangeHighlight {
  range: string;
  entry: ChangeEntry;
}

/** 新提交拥有重叠单元格；矩形差集保留旧区域的剩余部分，不涂满包围盒。 */
export function changeHighlights(changes: ChangeEntry[], sheet: string): ChangeHighlight[] {
  const covered: RangeRef[] = [];
  const out: ChangeHighlight[] = [];
  for (const entry of [...changes].sort((a, b) => b.seq - a.seq)) {
    for (const key of entry.ranges) {
      try {
        const p = parseRange(key);
        if (p.sheet && p.sheet !== sheet) continue;
        const range: RangeRef = {
          sheetId: sheet,
          r0: p.startRow - 1,
          r1: p.endRow - 1,
          c0: p.startCol - 1,
          c1: p.endCol - 1,
        };
        for (const part of subtractRanges(range, covered)) {
          out.push({
            entry,
            range: formatRange({
              sheet,
              startRow: part.r0 + 1,
              endRow: part.r1 + 1,
              startCol: part.c0 + 1,
              endCol: part.c1 + 1,
            }),
          });
        }
        covered.push(range);
      } catch {
        // 不可定位的历史区域仍留在变更导航中。
      }
    }
  }
  return out;
}

export function changeHighlightFrame(age: number, reducedMotion: boolean) {
  if (age >= CHANGE_HIGHLIGHT_MS) return { fill: 0, stroke: 0, width: 0 };
  if (reducedMotion) return { fill: 0, stroke: 0.8, width: 1.5 };
  const enter = Math.min(1, Math.max(0, age) / 650);
  const fade = Math.min(1, (CHANGE_HIGHLIGHT_MS - age) / 900);
  return {
    fill: Math.round(0.09 * (1 - enter) ** 2 * fade * 1000) / 1000,
    stroke: Math.round((0.7 + 0.3 * (1 - enter)) * fade * 100) / 100,
    width: 1.5 + (1 - enter),
  };
}
