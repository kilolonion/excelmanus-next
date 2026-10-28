import { CommandType, type ICellData, type ICommandService, type Workbook } from "@univerjs/core";
import { z } from "zod";
import { shiftFormula } from "./formula-shift.ts";
export const FILTER_COMMAND = "excelmanus.command.filter";
export const LINK_COMMAND = "excelmanus.command.hyperlink";
export const FILL_COMMAND = "excelmanus.command.fill";
export const AXIS_SIZE_COMMAND = "excelmanus.command.axis-size";
export const COPY_SHEET_COMMAND = "excelmanus.command.copy-sheet";
export const RENAME_SHEET_COMMAND = "excelmanus.command.rename-sheet";
const Size = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(1000),
  mode: z.enum(["pixels", "scale", "auto"]),
  value: z.number().positive().optional(),
});
const Copy = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  id: z.string(),
  name: z.string(),
  index: z.int().nonnegative(),
});
export function layoutCommands(
  commands: ICommandService,
  bookOf: (id: string) => Workbook | undefined | null | void,
  hasFilter: (unitId: string, sheetId: string) => boolean,
) {
  return [
    {
      id: RENAME_SHEET_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = input as { unitId: string; subUnitId: string; name: string };
        const book = bookOf(p.unitId),
          source = book?.getSheetBySheetId(p.subUnitId);
        if (!book || !source) return false;
        const oldName = source.getName();
        if (!(await commands.executeCommand("sheet.command.set-worksheet-name", p))) return false;
        for (const sheet of book.getSheets()) {
          const cellValue: Record<number, Record<number, ICellData>> = {};
          sheet.getCellMatrix().forValue((row, col, cell) => {
            const link = cell?.custom?.excelmanusHyperlink as { url?: unknown } | undefined;
            if (typeof link?.url !== "string") return;
            const match = /^#(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(link.url);
            if (
              !match ||
              (match[1]?.replaceAll("''", "'") ?? match[2])?.toLowerCase() !== oldName.toLowerCase()
            )
              return;
            const url = `#'${p.name.replaceAll("'", "''")}'!${match[3]}`;
            (cellValue[row] ??= {})[col] = {
              ...structuredClone(cell),
              custom: { ...cell?.custom, excelmanusHyperlink: { ...link, url } },
            };
          });
          if (
            Object.keys(cellValue).length &&
            !(await commands.executeCommand("sheet.mutation.set-range-values", {
              unitId: p.unitId,
              subUnitId: sheet.getSheetId(),
              cellValue,
            }))
          )
            return false;
        }
        return true;
      },
    },
    {
      id: FILTER_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = input as {
          unitId: string;
          subUnitId: string;
          clear?: boolean;
          range: unknown;
          columns: {
            column: number;
            values?: (string | number | boolean)[];
            blank?: boolean;
            condition?: { operator: string; value: number };
          }[];
        };
        const book = bookOf(p.unitId);
        if (!book) return false;
        if (hasFilter(p.unitId, p.subUnitId))
          await commands.executeCommand("sheet.mutation.remove-filter", {
            unitId: p.unitId,
            subUnitId: p.subUnitId,
          });
        if (p.clear) return true;
        if (
          !(await commands.executeCommand("sheet.mutation.set-filter-range", {
            unitId: p.unitId,
            subUnitId: p.subUnitId,
            range: p.range,
          }))
        )
          return false;
        for (const col of p.columns)
          if (
            !(await commands.executeCommand("sheet.mutation.set-filter-criteria", {
              unitId: p.unitId,
              subUnitId: p.subUnitId,
              col: col.column - 1,
              criteria: {
                colId: col.column - 1,
                ...(col.condition
                  ? {
                      customFilters: {
                        customFilters: [
                          { operator: col.condition.operator, val: col.condition.value },
                        ],
                      },
                    }
                  : {
                      filters: {
                        filters: (col.values ?? []).map(String),
                        ...(col.blank ? { blank: true } : {}),
                      },
                    }),
              },
              reCalc: true,
            }))
          )
            return false;
        return true;
      },
    },
    {
      id: LINK_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = input as {
          unitId: string;
          subUnitId: string;
          row: number;
          col: number;
          url: string | null;
          label?: string;
        };
        const sheet = bookOf(p.unitId)?.getSheetBySheetId(p.subUnitId);
        if (!sheet) return false;
        const cell = structuredClone(sheet.getCellMatrix().getValue(p.row, p.col) ?? {}),
          custom: Record<string, unknown> = { ...cell.custom };
        if (p.url) custom.excelmanusHyperlink = { url: p.url };
        else delete custom.excelmanusHyperlink;
        const value = {
          ...cell,
          custom,
          ...(p.label !== undefined
            ? { v: p.label, f: null, si: null, p: null }
            : !cell.v && p.url
              ? { v: p.url }
              : {}),
        };
        return commands.executeCommand("sheet.mutation.set-range-values", {
          unitId: p.unitId,
          subUnitId: p.subUnitId,
          cellValue: { [p.row]: { [p.col]: value } },
        });
      },
    },
    {
      id: FILL_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = input as {
          unitId: string;
          subUnitId: string;
          targetRange: { startRow: number; endRow: number; startColumn: number; endColumn: number };
        };
        if (!(await commands.executeCommand("sheet.command.auto-fill", input as object)))
          return false;
        const snapshot = bookOf(p.unitId)?.save().sheets[p.subUnitId];
        if (!snapshot) return false;
        const masters = new Map<string, { f: string; r: number; c: number }>();
        for (const [r, cells] of Object.entries(snapshot.cellData ?? {}))
          for (const [c, raw] of Object.entries(cells ?? {})) {
            const cell = raw as ICellData;
            if (cell?.si && cell.f) masters.set(cell.si, { f: cell.f, r: Number(r), c: Number(c) });
          }
        const cellValue: Record<number, Record<number, ICellData>> = {};
        for (let r = p.targetRange.startRow; r <= p.targetRange.endRow; r++)
          for (let c = p.targetRange.startColumn; c <= p.targetRange.endColumn; c++) {
            const cell = snapshot.cellData?.[r]?.[c];
            if (!cell?.si) continue;
            const master = masters.get(cell.si);
            if (!master) throw new Error("填充共享公式主单元格缺失");
            const row = cellValue[r] ?? {};
            row[c] = {
              ...cell,
              f: cell.f ?? shiftFormula(master.f, c - master.c, r - master.r),
              si: null,
            };
            cellValue[r] = row;
          }
        return (
          !Object.keys(cellValue).length ||
          commands.executeCommand("sheet.mutation.set-range-values", {
            unitId: p.unitId,
            subUnitId: p.subUnitId,
            cellValue,
          })
        );
      },
    },
    {
      id: COPY_SHEET_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = Copy.parse(input),
          book = bookOf(p.unitId),
          sheet = book?.getSheetBySheetId(p.subUnitId);
        if (!sheet) return false;
        const data = structuredClone(book!.save().sheets[p.subUnitId]!);
        data.id = p.id;
        data.name = p.name;
        data.hidden = 0;
        return commands.executeCommand("sheet.command.insert-sheet", {
          unitId: p.unitId,
          index: p.index,
          sheet: data,
        });
      },
    },
    {
      id: AXIS_SIZE_COMMAND,
      type: CommandType.COMMAND,
      handler: async (_a: unknown, input: unknown) => {
        const p = Size.parse(input),
          sheet = bookOf(p.unitId)?.getSheetBySheetId(p.subUnitId);
        if (!sheet) return false;
        const rows = p.axis === "rows",
          config = bookOf(p.unitId)!.save().sheets[p.subUnitId]!,
          values = new Map<number, number>();
        if (
          p.at + p.count - 2 > (rows ? 1048575 : 16383) ||
          (p.mode !== "auto" && p.value === undefined)
        )
          return false;
        for (let i = p.at - 1; i < p.at + p.count - 1; i++)
          values.set(
            i,
            p.mode === "pixels"
              ? p.value!
              : p.mode === "scale"
                ? (rows ? sheet.getRowHeight(i) : sheet.getColumnWidth(i)) * p.value!
                : rows
                  ? 24
                  : 48,
          );
        if (p.mode === "auto") {
          let visited = 0;
          for (const [r, columns] of Object.entries(config.cellData ?? {}))
            for (const [c, cell] of Object.entries(columns ?? {})) {
              if (++visited > 200000) throw new Error("自动适配最多扫描20万已用格，请缩小工作簿");
              const index = rows ? Number(r) : Number(c);
              if (!values.has(index) || !cell) continue;
              const data = cell as { v?: unknown; f?: string; s?: unknown };
              const text = String(data.v ?? data.f ?? ""),
                lines = text.split(/\r?\n/);
              // Deterministic headless approximation, independent of browser canvas/font availability.
              const width =
                Math.max(
                  0,
                  ...lines.map((line) =>
                    [...line].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 14 : 7), 0),
                  ),
                ) + 16;
              const pixels = rows
                ? Math.max(
                    lines.length,
                    Math.ceil(width / Math.max(1, sheet.getColumnWidth(Number(c)))),
                  ) *
                    20 +
                  4
                : width;
              values.set(index, Math.max(values.get(index)!, pixels));
            }
        }
        for (const [index, value] of values) {
          const range = {
            startRow: rows ? index : 0,
            endRow: rows ? index : 1048575,
            startColumn: rows ? 0 : index,
            endColumn: rows ? 16383 : index,
          };
          const pixels = Math.max(1, Math.min(rows ? 1000 : 2000, Math.ceil(value)));
          if (
            !(await commands.executeCommand(
              rows
                ? "sheet.mutation.set-worksheet-row-height"
                : "sheet.mutation.set-worksheet-col-width",
              {
                unitId: p.unitId,
                subUnitId: p.subUnitId,
                ranges: [range],
                ...(rows ? { rowHeight: pixels } : { colWidth: pixels }),
              },
            ))
          )
            return false;
        }
        return true;
      },
    },
  ];
}
