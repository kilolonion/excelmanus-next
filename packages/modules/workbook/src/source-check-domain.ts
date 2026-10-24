import { indexToCol, parseRange } from "@excelmanus/core";
import {
  ARRAY_CACHE_RESOURCE,
  ArrayFormulas,
  SourceDomainDeclaration,
  type OutputDomainDeclaration,
} from "@excelmanus/protocol";
import type { SheetDomain } from "./source-checks.ts";

export interface SourceCheckSheet {
  id?: string;
  name?: string;
  rowCount?: number;
  columnCount?: number;
  cellData?: Record<number, Record<number, unknown>>;
  mergeData?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  custom?: unknown;
}
type Geometry = { startRow: number; endRow: number; startColumn: number; endColumn: number };
export interface SourceCheckSnapshot {
  sheets: Record<string, SourceCheckSheet>;
  resources?: { name: string; data: string }[];
}

export function extractSourceCheckDomain(
  snapshot: SourceCheckSnapshot,
  declaration: SourceDomainDeclaration | OutputDomainDeclaration,
): { domain: SheetDomain; limitations: string[] } {
  const domain: SheetDomain = { ...declaration, columnNames: [], rows: [], complete: false };
  const limitations: string[] = [];
  const result = { domain, limitations };
  const add = (code: string, at?: string) => {
    const limitation = `${code}${at ? `:${at}` : ""}`;
    if (limitations.includes(limitation)) return;
    if (limitations.length < 100) limitations.push(limitation);
    else if (!limitations.includes("LIMITATIONS_TRUNCATED"))
      limitations.push("LIMITATIONS_TRUNCATED");
  };
  if (!SourceDomainDeclaration.safeParse(declaration).success) {
    add("DOMAIN_DECLARATION_INVALID");
    return result;
  }
  let range: ReturnType<typeof parseRange>;
  try {
    range = parseRange(declaration.range);
  } catch {
    add("RANGE_INVALID");
    return result;
  }
  const sheets = Object.entries(snapshot.sheets);
  const matching = (name: string) =>
    sheets.filter(([id, sheet]) => id === name || sheet.id === name || sheet.name === name);
  const matches = matching(declaration.sheet);
  if (matches.length !== 1) {
    add("SHEET_MISSING_OR_AMBIGUOUS");
    return result;
  }
  const [sheetId, sheet] = matches[0]!;
  if ((sheet.id !== undefined && sheet.id !== sheetId) || matching(sheetId).length !== 1) {
    add("SHEET_IDENTITY_INCONSISTENT");
    return result;
  }
  if (range.sheet !== undefined) {
    const named = matching(range.sheet);
    if (named.length !== 1 || named[0]![0] !== sheetId) {
      add("SHEET_RANGE_MISMATCH");
      return result;
    }
  }
  domain.sheet = sheet.name || sheet.id || sheetId;
  if (matching(domain.sheet).length !== 1) {
    add("SHEET_CANONICAL_NAME_AMBIGUOUS");
    return result;
  }
  domain.range = `${indexToCol(range.startCol)}${range.startRow}:${indexToCol(range.endCol)}${range.endRow}`;
  if (
    !Number.isSafeInteger(sheet.rowCount) ||
    !Number.isSafeInteger(sheet.columnCount) ||
    sheet.rowCount! < 1 ||
    sheet.columnCount! < 1
  ) {
    add("SHEET_DIMENSIONS_UNAVAILABLE");
    return result;
  }
  if (range.endRow > sheet.rowCount! || range.endCol > sheet.columnCount!) {
    add("RANGE_OUTSIDE_SHEET");
    return result;
  }
  if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > 200000) {
    add("CELL_BUDGET_EXCEEDED");
    return result;
  }
  if (declaration.headerRows.length !== 1) {
    add("HEADER_LAYOUT_UNSUPPORTED");
    return result;
  }
  const headerRow = declaration.headerRows[0]!;
  if (headerRow < range.startRow || headerRow > range.endRow) {
    add("HEADER_OUTSIDE_RANGE");
    return result;
  }
  const intersects = (geometry: Geometry) =>
    geometry.startRow < range.endRow &&
    geometry.endRow >= range.startRow - 1 &&
    geometry.startColumn < range.endCol &&
    geometry.endColumn >= range.startCol - 1;
  const validGeometry = (value: unknown): value is Geometry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const geometry = value as Geometry;
    return (
      [geometry.startRow, geometry.endRow, geometry.startColumn, geometry.endColumn].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      geometry.endRow >= geometry.startRow &&
      geometry.endColumn >= geometry.startColumn
    );
  };
  for (const merge of sheet.mergeData ?? []) {
    if (!validGeometry(merge)) add("MERGE_GEOMETRY_UNSUPPORTED");
    else if (intersects(merge)) add("MERGED_DOMAIN_UNSUPPORTED", `${domain.sheet}!${domain.range}`);
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const declaredArrays = record(sheet.custom) ? sheet.custom.excelmanusArrays : undefined;
  if (declaredArrays !== undefined) {
    const parsed = ArrayFormulas.safeParse(declaredArrays);
    if (!parsed.success) add("ARRAY_METADATA_UNSUPPORTED");
    else
      for (const array of parsed.data) {
        if (!validGeometry(array.range)) add("ARRAY_METADATA_UNSUPPORTED");
        else if (intersects(array.range))
          add("ARRAY_DOMAIN_UNSUPPORTED", `${domain.sheet}!${domain.range}`);
      }
  }
  for (const resource of snapshot.resources ?? []) {
    if (resource.name !== ARRAY_CACHE_RESOURCE) continue;
    try {
      const cache: unknown = JSON.parse(resource.data);
      if (!record(cache) || !record(cache.ranges)) {
        add("ARRAY_METADATA_UNSUPPORTED");
        continue;
      }
      const ranges = cache.ranges[sheetId];
      if (ranges === undefined) continue;
      if (!record(ranges)) {
        add("ARRAY_METADATA_UNSUPPORTED");
        continue;
      }
      for (const columns of Object.values(ranges)) {
        if (!record(columns)) {
          add("ARRAY_METADATA_UNSUPPORTED");
          continue;
        }
        for (const cachedRange of Object.values(columns)) {
          if (!validGeometry(cachedRange)) add("ARRAY_METADATA_UNSUPPORTED");
          else if (intersects(cachedRange))
            add("ARRAY_DOMAIN_UNSUPPORTED", `${domain.sheet}!${domain.range}`);
        }
      }
    } catch {
      add("ARRAY_METADATA_UNSUPPORTED");
    }
  }
  let literalHeader = true;
  for (let row = range.startRow; row <= range.endRow; row++) {
    const cells: unknown[] = [];
    for (let col = range.startCol; col <= range.endCol; col++) {
      const at = `${domain.sheet}!${indexToCol(col)}${row}`;
      const cell = sheet.cellData?.[row - 1]?.[col - 1];
      if (cell === undefined || cell === null) {
        cells.push(null);
        continue;
      }
      if (typeof cell !== "object" || Array.isArray(cell)) {
        add("CELL_SHAPE_UNSUPPORTED", at);
        if (row === headerRow) literalHeader = false;
        cells.push(cell);
        continue;
      }
      const data = cell as Record<string, unknown>;
      let literal = true;
      if (
        ["f", "ft", "fd", "ref", "xf", "si"].some(
          (key) => data[key] !== undefined && data[key] !== null,
        )
      ) {
        add("FORMULA_CELL_UNSUPPORTED", at);
        literal = false;
      }
      if (data.p !== undefined && data.p !== null) {
        add("RICH_TEXT_UNSUPPORTED", at);
        literal = false;
      }
      const value = data.v === undefined ? null : data.v;
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      ) {
        add("VALUE_TYPE_UNSUPPORTED", at);
        literal = false;
      }
      if (data.t !== undefined && data.t !== null) {
        const expectedType =
          data.t === 1 || data.t === 4
            ? "string"
            : data.t === 2
              ? "number"
              : data.t === 3
                ? "boolean"
                : undefined;
        if (!expectedType) {
          add("CELL_TYPE_UNSUPPORTED", at);
          literal = false;
        } else if (value !== null && typeof value !== expectedType) {
          add("DECLARED_VALUE_TYPE_MISMATCH", at);
          literal = false;
        }
      }
      if (row === headerRow && !literal) literalHeader = false;
      cells.push(value);
    }
    domain.rows.push({ worksheetRow: row, cells });
    if (row === headerRow) {
      if (
        literalHeader &&
        cells.every((value) => typeof value === "string" && value.length > 0) &&
        new Set(cells).size === cells.length
      )
        domain.columnNames = cells as string[];
      else add("HEADER_MISSING_DUPLICATE_OR_NONLITERAL", `${domain.sheet}!${row}`);
    }
  }
  domain.complete = limitations.length === 0;
  return result;
}
