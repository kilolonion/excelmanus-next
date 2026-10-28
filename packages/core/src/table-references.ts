export type TableReference = {
  name: string;
  sheet: string;
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  columns: string[];
  showHeader: boolean;
  showFooter: boolean;
};
function col(n: number) {
  let s = "";
  for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
/** Only rewrites parsed bracket references, never quoted formula strings. */
export function rewriteTableReferences(
  formula: string,
  old: TableReference,
  next: TableReference | null,
  row: number,
  within: boolean,
  canonicalCurrentRow = false,
): string {
  let out = "",
    i = 0;
  while (i < formula.length) {
    if (formula[i] === '"') {
      const start = i++;
      while (i < formula.length) {
        if (formula[i++] === '"') {
          if (formula[i] === '"') {
            i++;
            continue;
          }
          break;
        }
      }
      out += formula.slice(start, i);
      continue;
    }
    const token = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(formula.slice(i))?.[0];
    if (token && formula[i + token.length] !== "[") {
      if (
        token.toLowerCase() === old.name.toLowerCase() &&
        !["!", "("].includes(formula[i + token.length] ?? "")
      )
        out += next
          ? next.name
          : rewriteTableReferences(`${old.name}[#Data]`, old, null, row, within);
      else out += formula[i + token.length] === "(" ? token.toUpperCase() : token;
      i += token.length;
      continue;
    }
    const prefix = /^([\p{L}_][\p{L}\p{N}_.]*)?(\[)/u.exec(formula.slice(i));
    if (!prefix) {
      out += formula[i++];
      continue;
    }
    const name = prefix[1],
      start = i,
      open = i + (name?.length ?? 0);
    let depth = 0,
      end = open;
    for (; end < formula.length; end++) {
      if (formula[end] === "[") depth++;
      if (formula[end] === "]" && --depth === 0) {
        end++;
        break;
      }
    }
    if (depth !== 0) throw Error("结构化引用括号不完整");
    let block = formula.slice(open, end);
    i = end;
    if (name ? name.toLowerCase() !== old.name.toLowerCase() : !within) {
      out += formula.slice(start, end);
      continue;
    }
    const leaves = [...block.matchAll(/\[([^[\]]+)\]/g)].map((m) => m[1]!);
    const fields = leaves.map((x) => x.replace(/^@/, "")).filter((x) => !x.startsWith("#"));
    const indexes = fields.map((x) =>
      old.columns.findIndex((c) => c.toLowerCase() === x.toLowerCase()),
    );
    if (indexes.some((x) => x < 0) || leaves.some((x) => x.includes("'")))
      throw Error("此结构化引用含暂不支持的列名转义");
    if (next) {
      block = block.replace(/\[([^[\]]+)\]/g, (raw, value: string) => {
        const at = value.startsWith("@"),
          field = at ? value.slice(1) : value;
        if (field.startsWith("#")) return raw;
        const n = old.columns.findIndex((c) => c.toLowerCase() === field.toLowerCase()),
          to = next.columns[n];
        if (to === undefined) throw Error("不能移除仍被公式引用的表列");
        return `[${at ? "@" : ""}${to}]`;
      });
      const currentRow = block.includes("@") || leaves.includes("#This Row");
      if (canonicalCurrentRow && currentRow) {
        block = block
          .replace(/^\[@([^[\]]+)\]$/, "[[#This Row],[$1]]")
          .replace(/^\[@(\[.*\])\]$/, "[[#This Row],$1]");
      }
      out += (name || (canonicalCurrentRow && currentRow) ? next.name : "") + block;
    } else {
      const options = leaves.filter((x) => x.startsWith("#"));
      const thisRow = block.includes("@") || options.includes("#This Row");
      if (options.some((x) => !["#All", "#Data", "#Headers", "#Totals", "#This Row"].includes(x)))
        throw Error("暂不支持转换此结构化引用");
      let r0 = old.range.startRow + (old.showHeader ? 1 : 0),
        r1 = old.range.endRow - (old.showFooter ? 1 : 0);
      if (options.includes("#All")) {
        r0 = old.range.startRow;
        r1 = old.range.endRow;
      }
      if (options.includes("#Headers")) {
        if (!old.showHeader) throw Error("表没有表头行");
        r0 = old.range.startRow;
        r1 = options.includes("#Data") ? r1 : r0;
      }
      if (options.includes("#Totals")) {
        if (!old.showFooter) throw Error("表没有汇总行");
        r1 = old.range.endRow;
        if (!options.includes("#Data")) r0 = r1;
      }
      if (thisRow) r0 = r1 = row;
      const c0 = old.range.startColumn + (indexes.length ? Math.min(...indexes) : 0),
        c1 =
          old.range.startColumn + (indexes.length ? Math.max(...indexes) : old.columns.length - 1);
      const a = `$${col(c0)}$${r0 + 1}`,
        b = `$${col(c1)}$${r1 + 1}`;
      out += `'${old.sheet.replaceAll("'", "''")}'!${a}${a === b ? "" : `:${b}`}`;
    }
  }
  return out;
}

/** Normalize the engine's case-sensitive lookup without touching quoted strings. */
export function normalizeTableCells(
  cells: Record<number, Record<number, unknown>>,
  sheetId: string,
  tables: Array<TableReference & { sheetId: string }>,
): void {
  for (const [row, values] of Object.entries(cells))
    for (const [column, value] of Object.entries(values ?? {})) {
      if (!value || typeof value !== "object" || !("f" in value) || typeof value.f !== "string")
        continue;
      for (const t of tables) {
        const r = Number(row),
          c = Number(column),
          within =
            sheetId === t.sheetId &&
            r >= t.range.startRow &&
            r <= t.range.endRow &&
            c >= t.range.startColumn &&
            c <= t.range.endColumn;
        try {
          value.f = rewriteTableReferences(value.f as string, t, t, r, within, true);
        } catch {
          /* Unknown reference syntax remains available to the engine. */
        }
      }
    }
}
