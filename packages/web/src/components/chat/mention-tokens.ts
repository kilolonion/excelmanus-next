// 消息文本里的文件引用：`@路径`（输入框插入的工作区文件）与正文里出现的裸文件路径。
// 区域引用不写进文本，而是作为结构化上下文（ContextRef）随消息发送。

import { isWorkspaceFileReference } from "@/lib/file-kind";
import { fileName } from "@/lib/paths";

export interface MentionToken {
  start: number;
  end: number;
  raw: string;
  kind: "file" | "path";
  value: string;
}

const STOP = "\\s@,;!?，；！？、\"'“”()（）\\[\\]<>";
/** `@目录/文件.ext`，支持中文文件名。 */
const AT_FILE_RE = new RegExp(
  `@((?:[^${STOP}/]+/)*[^${STOP}/]+\\.[A-Za-z0-9]{1,8})(?=$|[\\s,;!?，；！？、。)）"'”])`,
  "g",
);

// 空格在裸路径中作为分隔符；含空格的文件名需要明确引用。
const QUOTE_START_RE = /["'`“「]/g;
const QUOTE_END: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”", "「": "」" };

const BARE_PATH_RE =
  /(?:^|(?<=\s|[：:"'（(]))(\.{0,2}\/)?([\w\u4e00-\u9fff][\w\u4e00-\u9fff./\\~-]*\.(?:xlsx|xlsm|xls|csv|tsv|pdf|zip|docx|pptx|txt|json|xml|html|md|png|jpe?g))(?=\s|$|[,;!?。，；！？：:）)"'])/gi;

/** Each regex pass yields ordered, disjoint spans; merge without re-sorting. */
function mergeTokens(left: MentionToken[], right: MentionToken[]): MentionToken[] {
  const out: MentionToken[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j === right.length || (i < left.length && left[i].start <= right[j].start))
      out.push(left[i++]);
    else out.push(right[j++]);
  }
  return out;
}

/** Candidates arrive in text order, so occupied intervals only need one forward pass. */
function overlapCheck(occupied: MentionToken[]) {
  let cursor = 0;
  return (start: number, end: number) => {
    while (cursor < occupied.length && occupied[cursor].end <= start) cursor++;
    return cursor < occupied.length && occupied[cursor].start < end;
  };
}

export function extractMentions(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  AT_FILE_RE.lastIndex = 0;
  for (let m = AT_FILE_RE.exec(text); m !== null; m = AT_FILE_RE.exec(text)) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: "file",
      value: m[1] ?? "",
    });
  }
  const quoted: MentionToken[] = [];
  const overlapsExplicit = overlapCheck(tokens);
  // Failed opening quotes share the next closing position instead of rescanning the suffix.
  const closing = new Map<string, number>();
  let lineEnd = -1;
  QUOTE_START_RE.lastIndex = 0;
  for (let match = QUOTE_START_RE.exec(text); match; match = QUOTE_START_RE.exec(text)) {
    const opening = match.index;
    if (lineEnd < opening) {
      const newline = text.indexOf("\n", opening);
      lineEnd = newline < 0 ? text.length : newline;
    }
    const quote = QUOTE_END[match[0]];
    let end = closing.get(quote);
    if (end === undefined || (end !== -1 && end <= opening)) {
      end = text.indexOf(quote, opening + 1);
      closing.set(quote, end);
    }
    if (end < 0 || end >= lineEnd || end === opening + 1) continue;
    QUOTE_START_RE.lastIndex = end + 1;
    const start = opening + 1;
    const value = text.slice(start, end);
    if (!isWorkspaceFileReference(value) || overlapsExplicit(start, end)) continue;
    quoted.push({ start, end, raw: value, kind: "path", value });
  }
  const occupied = mergeTokens(tokens, quoted);
  const bare: MentionToken[] = [];
  const overlapsOccupied = overlapCheck(occupied);
  BARE_PATH_RE.lastIndex = 0;
  for (let m = BARE_PATH_RE.exec(text); m !== null; m = BARE_PATH_RE.exec(text)) {
    const fullPath = (m[1] || "") + (m[2] ?? "");
    const start = m.index + m[0].length - fullPath.length;
    const end = start + fullPath.length;
    if (overlapsOccupied(start, end)) continue;
    bare.push({ start, end, raw: fullPath, kind: "path", value: fullPath });
  }
  return mergeTokens(occupied, bare);
}

export function mentionLabel(token: MentionToken): string {
  return fileName(token.value) || token.value;
}

/** 输入框插入的文件引用写法。 */
export function fileMention(path: string): string {
  return `@${path.replace(/\\/g, "/").replace(/^\.\//, "")}`;
}
