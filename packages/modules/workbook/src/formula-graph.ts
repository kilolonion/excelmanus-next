import { indexToCol, parseRange, type RangeRef } from "@excelmanus/core";
import type { ICellData, IWorkbookData } from "@univerjs/core";

const overlap = (a: RangeRef, b: RangeRef) =>
  a.sheetId === b.sheetId && a.r0 <= b.r1 && a.r1 >= b.r0 && a.c0 <= b.c1 && a.c1 >= b.c0;
export function formulaGraph(snapshot: IWorkbookData, target: RangeRef, depth: number) {
  const formulas: {
    cell: string;
    location: RangeRef;
    references: { text: string; range: RangeRef }[];
    unsupported: string[];
  }[] = [];
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
          cell: `'${String(sheet.name).replaceAll("'", "''")}'!${indexToCol(Number(col) + 1)}${Number(row) + 1}`,
          location: {
            sheetId: sid,
            r0: Number(row),
            r1: Number(row),
            c0: Number(col),
            c1: Number(col),
          },
          references,
          unsupported: [...new Set(unsupported)],
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
  return {
    depth,
    precedents: visit("precedents"),
    dependents: visit("dependents"),
    coverage: "static_only",
    limitations: ["动态、外部、结构化和定义名引用可能不完整；每个公式独立报告 unsupported。"],
  };
}
