import type { DataRange } from "./range-actions";

type Criteria = { filters?: unknown[]; blank?: boolean } | undefined;

export function readRangeDataColumns(
  kind: "sort" | "filter",
  range: DataRange,
  read: (range: DataRange) => unknown[][],
  criteriaFor: (column: number) => Criteria = () => undefined,
) {
  const values = read(kind === "sort" ? { ...range, endRow: range.startRow } : range);
  return Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, offset) => {
    const index = range.startColumn + offset;
    const unique = new Set<string>();
    if (kind === "filter")
      for (let row = 1; row < values.length; row++) unique.add(String(values[row][offset] ?? ""));
    const criteria = criteriaFor(index);
    return {
      index,
      label: `第 ${index + 1} 列 · ${String(values[0]?.[offset] ?? "（无表头）")}`,
      values: [...unique],
      ...(criteria
        ? { selected: [...(criteria.filters ?? []).map(String), ...(criteria.blank ? [""] : [])] }
        : {}),
    };
  });
}

/** Keep normalization local to one column and reuse matches while a query narrows. */
export function createRangeValueSearch(values: string[]) {
  let normalized: string[] | undefined;
  let previousQuery = "";
  let previousIndices: number[] = [];
  let previousResults = values;
  return (query: string): string[] => {
    if (!query) {
      previousQuery = "";
      previousIndices = [];
      previousResults = values;
      return values;
    }
    const q = query.toLowerCase();
    if (q === previousQuery) return previousResults;
    normalized ??= values.map((value) => value.toLowerCase());
    const indices: number[] = [];
    if (previousQuery && q.startsWith(previousQuery)) {
      for (const i of previousIndices) if (normalized[i].includes(q)) indices.push(i);
    } else {
      normalized.forEach((value, i) => {
        if (value.includes(q)) indices.push(i);
      });
    }
    previousQuery = q;
    previousIndices = indices;
    previousResults = indices.map((i) => values[i]);
    return previousResults;
  };
}
