import type { TextLines } from "./text-lines";

/** A file-local index; normalize lazily and reuse candidates while a query gets narrower. */
export function createPreviewLineSearch(lines: string[] | TextLines): (query: string) => number[] {
  let normalized: string[] | undefined;
  let previousQuery = "";
  let previousMatches: number[] = [];
  return (query) => {
    if (!query.trim()) {
      previousQuery = "";
      previousMatches = [];
      return previousMatches;
    }
    const q = query.toLowerCase();
    if (q === previousQuery) return previousMatches;
    normalized ??=
      "get" in lines
        ? Array.from({ length: lines.length }, (_, i) => (lines.get(i) ?? "").toLowerCase())
        : lines.map((line) => line.toLowerCase());
    const matches: number[] = [];
    if (previousQuery && q.startsWith(previousQuery)) {
      for (const i of previousMatches) if (normalized[i].includes(q)) matches.push(i);
    } else {
      normalized.forEach((line, i) => {
        if (line.includes(q)) matches.push(i);
      });
    }
    previousQuery = q;
    previousMatches = matches;
    return matches;
  };
}

export type PreviewMatches = number[] | Uint32Array;

/** Search emits ascending line numbers; visible rows can test membership without a full Set. */
export function hasPreviewMatch(matches: PreviewMatches, line: number): boolean {
  let low = 0,
    high = matches.length;
  while (low < high) {
    const mid = low + ((high - low) >>> 1);
    const value = matches[mid];
    if (value === line) return true;
    if (value < line) low = mid + 1;
    else high = mid;
  }
  return false;
}
