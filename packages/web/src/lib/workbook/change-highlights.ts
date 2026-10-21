import { formatRange, parseRange, type RangeRef, subtractRanges } from "@excelmanus/core";
import type { ChangeEntry } from "@/lib/session/types";

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
  const seen = new Set<string>();
  let bounds: RangeRef | undefined;
  const out: ChangeHighlight[] = [];
  for (const entry of [...changes].sort((a, b) => b.seq - a.seq)) {
    for (const key of entry.ranges) {
      if (seen.has(key)) continue;
      seen.add(key);
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
        // Ordered row/column edits outside the covered bounds cannot overlap any earlier mark.
        const disjoint =
          !bounds ||
          range.r1 < bounds.r0 ||
          range.r0 > bounds.r1 ||
          range.c1 < bounds.c0 ||
          range.c0 > bounds.c1;
        const parts = disjoint ? [range] : subtractRanges(range, covered);
        for (const part of parts) {
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
        if (parts.length > 0) {
          covered.push(range);
          bounds = bounds
            ? {
                sheetId: sheet,
                r0: Math.min(bounds.r0, range.r0),
                r1: Math.max(bounds.r1, range.r1),
                c0: Math.min(bounds.c0, range.c0),
                c1: Math.max(bounds.c1, range.c1),
              }
            : range;
        }
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

/** All rectangles from one revision share the same animation age and style in a paint pass. */
export function createChangeHighlightFrames() {
  const deadlines = new Map<ChangeEntry, number>();
  const frames = new Map<
    ChangeEntry,
    { frame: ReturnType<typeof changeHighlightFrame>; signature: string; age: number }
  >();
  let previousNow: number | undefined;
  let previousMotion: boolean | undefined;
  return (entry: ChangeEntry, now: number, reducedMotion: boolean) => {
    if (previousNow !== now || previousMotion !== reducedMotion) {
      frames.clear();
      previousNow = now;
      previousMotion = reducedMotion;
    }
    let result = frames.get(entry);
    if (!result) {
      let deadline = deadlines.get(entry);
      if (deadline === undefined) {
        deadline = changeDeadline(entry);
        deadlines.set(entry, deadline);
      }
      const age = now - (deadline - CHANGE_HIGHLIGHT_MS);
      const frame = changeHighlightFrame(age, reducedMotion);
      result = { frame, signature: JSON.stringify(frame), age };
      frames.set(entry, result);
    }
    return result;
  };
}
