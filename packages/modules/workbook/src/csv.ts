// CSV → IWorkbookData 只读导入。
// 编码：BOM（UTF-8/UTF-16LE/BE）→ UTF-8 fatal 嗅探 → GBK 兜底；分隔符嗅探 , ; \t |。

import type { ICellData } from "@univerjs/core";
import type { ImportedWorkbook } from "./xlsx.ts";

export class CsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvImportError";
  }
}

export function decodeCsv(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch {
    return { text: new TextDecoder("gbk").decode(bytes), encoding: "gbk" };
  }
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  let best: string = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuote = false;
    for (const ch of head) {
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && ch === d) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return bestCount <= 0 ? "," : best;
}

/** RFC4180 风格解析（引号、转义 ""、\r\n）。 */
function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuote = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushField();
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    pushField();
    rows.push(row);
  }
  return rows;
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function toCell(s: string): ICellData | null {
  const t = s.trim();
  if (t === "") return null;
  if (NUMERIC.test(t)) return { v: Number(t), t: 1 };
  return { v: t, t: 2 };
}

export function importCsv(bytes: Uint8Array, name: string): ImportedWorkbook {
  const { text } = decodeCsv(bytes);
  const delim = sniffDelimiter(text);
  const rows = parseRows(text, delim);
  if (rows.length === 0) throw new CsvImportError("CSV 为空");

  const cellData: Record<number, Record<number, ICellData>> = {};
  let maxCol = 0;
  let cellCount = 0;
  rows.forEach((r, ri) => {
    r.forEach((f, ci) => {
      const cell = toCell(f);
      if (cell === null) return;
      const row = cellData[ri] ?? {};
      cellData[ri] = row;
      row[ci] = cell;
      cellCount += 1;
      if (ci + 1 > maxCol) maxCol = ci + 1;
    });
  });
  const sheetName = "Sheet1";
  return {
    snapshot: {
      id: `wbk_${name.replace(/\W+/g, "_")}`,
      name,
      appVersion: "1.0.2",
      locale: "zh-CN" as never,
      styles: {},
      sheetOrder: ["s0"],
      sheets: {
        s0: {
          id: "s0",
          name: sheetName,
          rowCount: Math.max(rows.length, 1),
          columnCount: Math.max(maxCol, 1),
          cellData,
        },
      },
    },
    unsupported: {},
    cellCounts: { [sheetName]: cellCount },
    formulaCounts: {},
  };
}
