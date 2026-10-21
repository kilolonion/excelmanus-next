type SortRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};
// biome-ignore lint/suspicious/noConfusingVoidType: Matches Univer Nullable without a runtime dependency.
type Nullable<T> = T | null | undefined | void;
type SortCell = { f?: Nullable<string>; si?: Nullable<string> };
type SortSheet = {
  getMergeData(): SortRange[];
  getCellRaw(row: number, column: number): Nullable<SortCell>;
  getCellMatrix(): {
    setValue(row: number, column: number, cell: Nullable<SortCell>): void;
    forValue(callback: (row: number, col: number, cell: Nullable<SortCell>) => void): unknown;
  };
};

class SortRefusal extends Error {}

function refuseSortSafely<T>(run: () => T, onRefusal?: () => void): T | false {
  try {
    return run();
  } catch (error) {
    // Univer 1.0.2 does not unwind its command stack when a handler throws.
    if (error instanceof SortRefusal) {
      onRefusal?.();
      return false;
    }
    throw error;
  }
}

export function assertSortableRange(range: SortRange, merges: SortRange[]): void {
  if (range.startRow > range.endRow) return;
  if (
    merges.some(
      (merge) =>
        merge.startRow <= range.endRow &&
        merge.endRow >= range.startRow &&
        merge.startColumn <= range.endColumn &&
        merge.endColumn >= range.startColumn,
    )
  )
    throw new SortRefusal("排序数据区域与合并单元格相交，请先取消合并后再排序");
}

/** Exclude the header before Univer inspects merges or constructs the reorder mutation. */
export function prepareSortRange(
  params: { range: SortRange; hasTitle?: boolean },
  merges: SortRange[],
): void {
  const range = { ...params.range, startRow: params.range.startRow + (params.hasTitle ? 1 : 0) };
  assertSortableRange(range, merges);
  params.range = range;
  params.hasTitle = false;
}

/** Refuse inside the handler, not a throwing before-command hook. */
export function safeSortRangeCommand<A, O, R>(
  command: { id: string; type: number; handler(accessor: A, params?: object, options?: O): R },
  sheetOf: (unitId: string, sheetId: string) => Nullable<SortSheet>,
) {
  return {
    ...command,
    handler: (accessor: A, input?: object, options?: O) =>
      refuseSortSafely(() => {
        const p = input as { unitId: string; subUnitId: string } & Parameters<
          typeof prepareSortRange
        >[0];
        prepareSortRange(p, sheetOf(p.unitId, p.subUnitId)?.getMergeData() ?? []);
        return command.handler(accessor, input, options);
      }),
  };
}

/** Univer 1.0.2 copies formulas verbatim on reorder; translate the copied row before recalc. */
export function formulaAwareReorderMutation(
  type: number,
  sheetOf: (unitId: string, sheetId: string) => Nullable<SortSheet>,
  shiftFormula: (formula: string, columns: number, rows: number) => string,
) {
  return {
    id: "sheet.mutation.reorder-range",
    type,
    handler: (
      _accessor: unknown,
      input: unknown,
      options: { excelmanusReplay?: boolean; excelmanusSortRejected?: boolean } = {},
    ) => {
      options.excelmanusSortRejected = false;
      return refuseSortSafely(
        () => {
          const p = input as {
            unitId: string;
            subUnitId: string;
            range: SortRange;
            order: Record<number, number>;
            excelmanusSortVersion?: unknown;
          };
          // Only trusted log hydration may select legacy semantics; public params cannot opt in.
          const replay = options?.excelmanusReplay === true;
          const legacy = replay && p.excelmanusSortVersion === undefined;
          if (replay && !legacy && p.excelmanusSortVersion !== 1)
            throw new SortRefusal("不支持的排序修订版本，未修改数据");
          if (!replay) p.excelmanusSortVersion = 1;
          const sheet = sheetOf(p.unitId, p.subUnitId);
          if (!sheet) return false;
          const cells: Array<[number, number, Nullable<SortCell>]> = [];
          const sharedGroups = new Set<string>();
          const matrix = sheet.getCellMatrix();
          let masters: Map<string, { formula: string; row: number; col: number }> | undefined;
          for (const [key, sourceRow] of Object.entries(p.order)) {
            const row = Number(key);
            if (row < p.range.startRow || row > p.range.endRow) continue;
            // Editor mutations can include the header in range, but not in order.
            for (const checkedRow of legacy ? [] : [row, sourceRow])
              assertSortableRange(
                { ...p.range, startRow: checkedRow, endRow: checkedRow },
                sheet.getMergeData(),
              );
            for (let col = p.range.startColumn; col <= p.range.endColumn; col++) {
              const cell = structuredClone(sheet.getCellRaw(sourceRow, col));
              if (!legacy && cell?.si) {
                sharedGroups.add(cell.si);
                if (!masters) {
                  masters = new Map();
                  matrix.forValue((r, c, value) => {
                    if (value?.si && value.f)
                      masters?.set(value.si, { formula: value.f, row: r, col: c });
                  });
                }
                const master = masters.get(cell.si);
                if (!master) throw new SortRefusal("排序共享公式主单元格缺失");
                cell.f =
                  cell.f ?? shiftFormula(master.formula, col - master.col, sourceRow - master.row);
                cell.si = null;
              }
              if (!legacy && cell?.f) {
                const shifted = shiftFormula(cell.f, 0, row - sourceRow);
                // A new out-of-bounds reference loses its address and cannot survive inverse reorder.
                if (
                  shifted.toUpperCase().includes("#REF!") &&
                  shiftFormula(shifted, 0, sourceRow - row) !== shiftFormula(cell.f, 0, 0)
                )
                  throw new SortRefusal(
                    "排序会使公式引用越界且无法撤销，未修改数据，请调整排序区域或公式",
                  );
                cell.f = shifted;
              }
              cells.push([row, col, cell]);
            }
          }
          if (sharedGroups.size)
            matrix.forValue((row, col, cell) => {
              if (
                cell?.si &&
                sharedGroups.has(cell.si) &&
                (row < p.range.startRow ||
                  row > p.range.endRow ||
                  col < p.range.startColumn ||
                  col > p.range.endColumn ||
                  !Object.hasOwn(p.order, row))
              )
                throw new SortRefusal("排序区域截断共享公式，请包含完整共享公式区域后再排序");
            });
          for (const [row, col, cell] of cells) matrix.setValue(row, col, cell);
          return true;
        },
        () => {
          options.excelmanusSortRejected = true;
        },
      );
    },
  };
}
