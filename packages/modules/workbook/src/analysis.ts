import { z } from "zod";
import { runSql, type SqlTable } from "./sql-runner.ts";

const column = z
  .string()
  .min(1)
  .describe("区域首行的实际列标题；不是 Excel 列字母。先用 workbook_read mode=table 查看列名。");
const expected = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export const CheckRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("required"), column }),
  z.object({ kind: z.literal("unique"), column }),
  z.object({
    kind: z.literal("range"),
    column,
    min: z.union([z.number(), z.string()]),
    max: z.union([z.number(), z.string()]),
  }),
  z.object({ kind: z.literal("pattern"), column, pattern: z.string().max(500) }),
  z.object({ kind: z.literal("foreign_key"), column, source: z.string(), referenceColumn: column }),
  z.object({ kind: z.literal("row_expression"), expression: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal("cell"),
    column,
    row: z.int().positive(),
    expected,
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({
    kind: z
      .literal("total")
      .describe(
        "对输入范围全部数据行求和（不含表头）；不会自动排除合计行。校验明细合计时 range 应只包含明细，避免重复累计。",
      ),
    column,
    expected: z.number(),
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({ kind: z.literal("formula_errors"), column: column.optional() }),
]);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string | number | boolean | null) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : typeof value === "boolean"
        ? value
          ? "1"
          : "0"
        : `'${value.replaceAll("'", "''")}'`;
export async function checkTables(
  tables: SqlTable[],
  rules: z.infer<typeof CheckRule>[],
  signal?: AbortSignal,
) {
  const main = tables[0]!;
  let indexColumn = "__excelmanus_row";
  while (main.columns.includes(indexColumn)) indexColumn += "_";
  const input = [
    {
      ...main,
      columns: [...main.columns, indexColumn],
      rows: main.rows.map((row, i) => [...row, i + 1]),
    },
    ...tables.slice(1),
  ];
  const results = [];
  for (const [index, rule] of rules.entries()) {
    const column = "column" in rule ? rule.column : undefined;
    if (column && !main.columns.includes(column)) throw new Error(`不存在的列：${column}`);
    const c = quote(column ?? main.columns[0] ?? ""),
      row = quote(indexColumn);
    let condition = "",
      sql = "";
    switch (rule.kind) {
      case "required":
        condition = `${c} IS NULL OR trim(CAST(${c} AS TEXT))=''`;
        break;
      case "unique":
        condition = `${c} IN (SELECT ${c} FROM data WHERE ${c} IS NOT NULL GROUP BY ${c} HAVING COUNT(*)>1)`;
        break;
      case "range":
        condition = `${c} IS NOT NULL AND NOT (${c} BETWEEN ${literal(rule.min)} AND ${literal(rule.max)})`;
        break;
      case "pattern":
        condition = `${c} IS NOT NULL AND NOT regexp(${literal(rule.pattern)},${c})`;
        break;
      case "foreign_key": {
        const source = tables.find((t) => t.name === rule.source);
        if (!source?.columns.includes(rule.referenceColumn))
          throw new Error("外键目标表或列不存在");
        condition = `${c} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${quote(rule.source)} ref WHERE ref.${quote(rule.referenceColumn)}=data.${c})`;
        break;
      }
      case "row_expression":
        if (/;|--|\/\*/.test(rule.expression)) throw new Error("行表达式不能包含多语句或注释");
        condition = `NOT COALESCE((${rule.expression}),0)`;
        break;
      case "cell": {
        if (rule.row > main.rows.length)
          throw new Error("cell 行号超出明细数据范围（从1开始，不含表头）");
        const mismatch =
          typeof rule.expected === "number"
            ? `typeof(${c}) NOT IN ('integer','real') OR abs(${c}-${rule.expected})>${rule.tolerance}`
            : `${c} IS NOT ${literal(rule.expected)}`;
        condition = `${row}=${rule.row} AND (${mismatch})`;
        break;
      }
      case "total":
        sql = `SELECT 0 AS row,COALESCE(SUM(${c}),0) AS actual FROM data HAVING abs(COALESCE(SUM(${c}),0)-${rule.expected})>${rule.tolerance}`;
        break;
      case "formula_errors":
        condition = (rule.column ? [rule.column] : main.columns)
          .map(
            (name) =>
              `${quote(name)} IN ('#REF!','#DIV/0!','#VALUE!','#NAME?','#NUM!','#N/A','#NULL!','#SPILL!','#CALC!')`,
          )
          .join(" OR ");
        break;
    }
    sql ||= `SELECT ${row} AS row,${column ? c : "NULL"} AS actual FROM data WHERE ${condition}`;
    const { rows } = await runSql(input, sql, signal);
    results.push({
      index,
      kind: rule.kind,
      passed: rows.length === 0,
      failedCount: rows.length,
      failures: rows.slice(0, 100),
      truncated: rows.length > 100,
    });
  }
  return {
    passed: results.every((r) => r.passed),
    rules: results,
    rowNumbering:
      "1-based detail rows, excludes header; row=0 denotes an aggregate over all input detail rows",
  };
}
export function diffTables(
  left: SqlTable,
  right: SqlTable,
  keys: string[] | undefined,
  offset = 0,
) {
  const columns = [...new Set([...left.columns, ...right.columns])];
  if (keys?.some((k) => !left.columns.includes(k) || !right.columns.includes(k)))
    throw new Error("业务键必须在两个区域都存在");
  const make = (table: SqlTable, side: string) => {
    const map = new Map<string, { values: Record<string, unknown>; row: number }>();
    for (const [i, row] of table.rows.entries()) {
      const object = Object.fromEntries(table.columns.map((c, j) => [c, row[j] ?? null]));
      const key = keys?.length ? JSON.stringify(keys.map((k) => object[k])) : String(i + 1);
      const previous = map.get(key);
      if (previous)
        throw new Error(
          `${side}业务键重复：${key}；明细行 ${previous.row}、${i + 1}（不含表头）；请提供唯一的组合键或先按业务口径汇总`,
        );
      map.set(key, { values: object, row: i + 1 });
    }
    return map;
  };
  const a = make(left, "左侧"),
    b = make(right, "右侧"),
    changes = [];
  let added = 0,
    deleted = 0,
    modified = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const beforeEntry = a.get(key),
      afterEntry = b.get(key);
    const before = beforeEntry?.values,
      after = afterEntry?.values;
    const changedColumns = columns.filter(
      (c) => JSON.stringify(before?.[c]) !== JSON.stringify(after?.[c]),
    );
    if (!changedColumns.length) continue;
    const kind = !before ? "added" : !after ? "deleted" : "modified";
    if (kind === "added") added++;
    else if (kind === "deleted") deleted++;
    else modified++;
    const index = added + deleted + modified - 1;
    if (index >= offset && changes.length < 200)
      changes.push({
        kind,
        key,
        before: before ?? null,
        after: after ?? null,
        changedColumns,
        beforeRow: beforeEntry?.row ?? null,
        afterRow: afterEntry?.row ?? null,
      });
  }
  const total = added + deleted + modified;
  return {
    added,
    deleted,
    modified,
    total,
    columns,
    changes,
    alignment: keys?.length ? "business_key" : "position",
    rowNumbering: "1-based detail rows, excludes header",
    ...(offset + changes.length < total ? { nextOffset: offset + changes.length } : {}),
    addedColumns: right.columns.filter((c) => !left.columns.includes(c)),
    deletedColumns: left.columns.filter((c) => !right.columns.includes(c)),
  };
}
