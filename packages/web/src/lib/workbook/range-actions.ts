export type DataRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};
export type DataTarget = {
  unitId: string;
  subUnitId: string;
  range: DataRange;
  hasFilter?: boolean;
};
export type DataAction =
  | { kind: "sort"; column: number; order: "asc" | "desc"; header: boolean }
  | { kind: "filter"; column: number; values: string[] };
/** Commands remain on the editor's normal mutation/undo path. Columns are absolute, zero-based. */
export function rangeDataCommands(target: DataTarget, action: DataAction) {
  const { unitId, subUnitId, range } = target;
  if (action.column < range.startColumn || action.column > range.endColumn)
    throw new Error("请选择区域内的列");
  if (range.endRow <= range.startRow) throw new Error("请选择至少两行数据");
  if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 200000)
    throw new Error("请缩小选区，单次最多处理 20 万格");
  const shared = { unitId, subUnitId };
  if (action.kind === "sort")
    return [
      {
        id: "sheet.command.sort-range",
        params: {
          ...shared,
          range,
          hasTitle: action.header,
          orderRules: [{ colIndex: action.column, type: action.order }],
        },
      },
    ];
  if (!action.values.length) throw new Error("至少保留一个筛选值");
  return [
    ...(!target.hasFilter
      ? [{ id: "sheet.command.set-filter-range", params: { ...shared, range } }]
      : []),
    {
      id: "sheet.command.set-filter-criteria",
      params: {
        ...shared,
        col: action.column,
        criteria: {
          colId: action.column - range.startColumn,
          filters: {
            filters: action.values.filter((v) => v !== ""),
            blank: action.values.includes(""),
          },
        },
      },
    },
  ];
}
