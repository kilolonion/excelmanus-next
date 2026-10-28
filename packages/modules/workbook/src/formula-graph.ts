import { indexToCol, parseRange, type RangeRef } from "@excelmanus/core";
import type { ICellData, IWorkbookData } from "@univerjs/core";

const overlap = (a: RangeRef, b: RangeRef) =>
  a.sheetId === b.sheetId && a.r0 <= b.r1 && a.r1 >= b.r0 && a.c0 <= b.c1 && a.c1 >= b.c0;
const MAX_VALUE_CELLS = 2000;

function cellValue(snapshot: IWorkbookData, sheetId: string, row: number, col: number) {
  const sheet = snapshot.sheets[sheetId];
  const cell = sheet?.cellData?.[row]?.[col];
  return {
    cell: `'${String(sheet?.name ?? sheetId).replaceAll("'", "''")}'!${indexToCol(col + 1)}${row + 1}`,
    ...(cell?.f ? { formula: cell.f } : {}),
    value: cell?.v ?? null,
    valueAvailable: cell?.f ? cell.v !== undefined && cell.v !== null : true,
  };
}

export function formulaGraph(snapshot: IWorkbookData, target: RangeRef, depth: number) {
  const formulas: (ReturnType<typeof cellValue> & {
    location: RangeRef;
    references: { text: string; range: RangeRef }[];
    unsupported: string[];
  })[] = [];
  let scanned = 0;
  for (const [sid, sheet] of Object.entries(snapshot.sheets))
    for (const [row, cells] of Object.entries(sheet.cellData ?? {}))
      for (const [col, cell] of Object.entries((cells ?? {}) as Record<string, ICellData>)) {
        if (++scanned > 200000) throw new Error("依赖图最多扫描20万格，请拆分工作簿");
        if (!cell?.f) continue;
        const formula = cell.f.replace(/"(?:[^"]|"")*"/g, '""');
        const unsupported: string[] = [];
        if (/\b(?:INDIRECT|OFFSET)\s*\(/i.test(formula))
          unsupported.push("动态引用 INDIRECT/OFFSET");
        if (/[[\]]/.test(formula)) unsupported.push("外部工作簿或结构化表引用");
        if (/(?:[\p{L}\p{N}_]+):(?:[\p{L}\p{N}_]+)!/u.test(formula)) unsupported.push("三维引用");
        const references: { text: string; range: RangeRef }[] = [];
        const regex =
          /(?<![\p{L}\p{N}_.$])(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?(?![\p{L}\p{N}_(])/gu;
        for (const match of formula.matchAll(regex)) {
          const name = match[1]?.replaceAll("''", "'") ?? match[2];
          const prefix = formula.slice(0, match.index).trimEnd();
          // 不把外部工作簿、结构化表或三维引用中的 A1 片段解析为本地值。
          if ((name && /[\]:]$/.test(prefix)) || prefix.lastIndexOf("[") > prefix.lastIndexOf("]"))
            continue;
          const refSid = name
            ? Object.keys(snapshot.sheets).find((id) => snapshot.sheets[id]?.name === name)
            : sid;
          if (!refSid) {
            unsupported.push(`未知工作表：${name}`);
            continue;
          }
          try {
            const p = parseRange(
              `${match[3]}${match[4]}${match[5] ? `:${match[5]}${match[6]}` : ""}`,
            );
            references.push({
              text: match[0],
              range: {
                sheetId: refSid,
                r0: p.startRow - 1,
                r1: p.endRow - 1,
                c0: p.startCol - 1,
                c1: p.endCol - 1,
              },
            });
          } catch {
            unsupported.push(`无法解析：${match[0]}`);
          }
        }
        // Formula tokenization is deliberately conservative: named ranges and whole-axis ranges are not silently treated as absent.
        if (/\$?[A-Z]+:\$?[A-Z]+|\b\d+:\d+\b/.test(formula)) unsupported.push("整行/整列引用");
        if (
          /\b[A-Za-z_][A-Za-z_0-9.]*\b(?!\s*[(!])/g.test(
            formula.replace(regex, " ").replace(/\b(?:TRUE|FALSE)\b/g, ""),
          )
        )
          unsupported.push("可能包含定义名或未解析标识符");
        formulas.push({
          ...cellValue(snapshot, sid, Number(row), Number(col)),
          location: {
            sheetId: sid,
            r0: Number(row),
            r1: Number(row),
            c0: Number(col),
            c1: Number(col),
          },
          unsupported: [...new Set(unsupported)],
          references,
        });
      }
  const visit = (direction: "precedents" | "dependents") => {
    let frontier = [target];
    const seen = new Set<string>(),
      out: typeof formulas = [];
    for (let i = 0; i < depth && frontier.length; i++) {
      const next: RangeRef[] = [];
      for (const f of formulas) {
        if (seen.has(f.cell)) continue;
        const matches =
          direction === "precedents"
            ? frontier.some((r) => overlap(r, f.location))
            : f.references.some((ref) => frontier.some((r) => overlap(r, ref.range)));
        if (!matches) continue;
        seen.add(f.cell);
        out.push(f);
        if (out.length >= 1000) return { items: out, truncated: true };
        next.push(
          ...(direction === "precedents" ? f.references.map((r) => r.range) : [f.location]),
        );
      }
      frontier = next;
    }
    return { items: out, truncated: false };
  };
  let returnedCells = 0;
  let valuesTruncated = false;
  const withValues = (group: ReturnType<typeof visit>) => ({
    ...group,
    items: group.items.map((node) => ({
      ...node,
      references: node.references.map((ref) => {
        const { sheetId, r0, r1, c0, c1 } = ref.range;
        const totalCells = (r1 - r0 + 1) * (c1 - c0 + 1);
        const cells: ReturnType<typeof cellValue>[] = [];
        for (let row = r0; row <= r1 && returnedCells < MAX_VALUE_CELLS; row++) {
          for (let col = c0; col <= c1 && returnedCells < MAX_VALUE_CELLS; col++) {
            cells.push(cellValue(snapshot, sheetId, row, col));
            returnedCells++;
          }
        }
        const truncated = cells.length < totalCells;
        valuesTruncated ||= truncated;
        return { ...ref, totalCells, truncated, cells };
      }),
    })),
  });
  const precedents = withValues(visit("precedents"));
  const dependents = withValues(visit("dependents"));
  return {
    depth,
    coverage: "static_only",
    valueCoverage: {
      source: "current_snapshot",
      limit: MAX_VALUE_CELLS,
      returnedCells,
      truncated: valuesTruncated,
    },
    limitations: [
      "动态、外部、结构化和定义名引用可能不完整；每个公式独立报告 unsupported。",
      "值来自当前修订快照；公式没有缓存结果时 valueAvailable=false，不把它当作空白或计算正确。引用值截断时可用 workbook_read mode=range 读取所需区域。",
    ],
    precedents,
    dependents,
  };
}
