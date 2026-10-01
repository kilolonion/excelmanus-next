// CSV → IWorkbookData 只读导入。
// 编码：BOM（UTF-8/UTF-16LE/BE）→ UTF-8 fatal 嗅探 → GBK 兜底；分隔符嗅探 , ; \t |。

import { FileOperationError } from "@excelmanus/kernel";
import type { ICellData, IWorkbookData } from "@univerjs/core";
import iconv from "iconv-lite";
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

function toCell(s: string): ICellData | null {
  if (s === "") return null;
  // 只把规范数字文本识别为数值（String(n) 与原文逐字相同），写回时仍逐字还原（07 §9）
  const n = Number(s);
  if (/^-?\d/.test(s) && Number.isFinite(n) && String(n) === s) return { v: n, t: 2 };
  return { v: s, t: 1 };
}

export function importCsv(bytes: Uint8Array, name: string): ImportedWorkbook {
  const { text, encoding } = decodeCsv(bytes);
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
    csv: {
      encoding,
      delimiter: delim,
      newline: text.includes("\r\n") ? "\r\n" : "\n",
      trailingNewline: /[\r\n]$/.test(text),
    },
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

export function exportCsv(
  snapshot: IWorkbookData,
  options: {
    sheet?: string;
    delimiter?: string;
    encoding?: string;
    newline?: string;
    trailingNewline?: boolean;
  } = {},
): Uint8Array {
  const sheet = options.sheet
    ? Object.values(snapshot.sheets).find((s) => s.name === options.sheet || s.id === options.sheet)
    : snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
  if (!sheet) throw new FileOperationError("NOT_FOUND", "工作表不存在");
  const data = (sheet.cellData as Record<number, Record<number, ICellData>>) ?? {};
  const rs = Object.keys(data).map(Number);
  const maxR = Math.max(-1, ...rs);
  const maxC = Math.max(
    -1,
    ...Object.values(data).flatMap((r) => Object.keys(r ?? {}).map(Number)),
  );
  if ((maxR + 1) * (maxC + 1) > 4_000_000)
    throw new FileOperationError("LIMIT_EXCEEDED", "CSV 导出最多 400 万格");
  const delim = options.delimiter ?? ",";
  const lines: string[] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = data[r]?.[c];
      // 导出值：公式格输出计算值（无计算值时为导入缓存），不输出公式文本
      const v = String(cell?.v ?? "");
      row.push(v.includes(delim) || /["\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    }
    lines.push(row.join(delim));
  }
  const text =
    lines.join(options.newline ?? "\n") +
    (options.trailingNewline ? (options.newline ?? "\n") : "");
  const encoding = options.encoding ?? "utf-8";
  if (encoding === "gbk") {
    const bytes = iconv.encode(text, "gbk");
    if (iconv.decode(bytes, "gbk") !== text)
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "文本无法用 GBK 无损表示，请另存为 UTF-8",
      );
    return bytes;
  }
  if (encoding === "utf-8-bom")
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  if (encoding === "utf-16le" || encoding === "utf-16be")
    return Buffer.concat([
      Buffer.from(encoding.endsWith("le") ? [0xff, 0xfe] : [0xfe, 0xff]),
      iconv.encode(text, encoding),
    ]);
  return Buffer.from(text);
}
