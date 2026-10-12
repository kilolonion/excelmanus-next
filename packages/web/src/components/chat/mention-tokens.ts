// 消息文本里的文件引用：`@路径`（输入框插入的工作区文件）与正文里出现的裸文件路径。
// 区域引用不写进文本，而是作为结构化上下文（ContextRef）随消息发送。

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

const BARE_PATH_RE =
  /(?:^|(?<=\s|[：:"'（(]))(\.{0,2}\/)?([\w\u4e00-\u9fff][\w\u4e00-\u9fff./\\~ -]*\.(?:xlsx|xlsm|xls|csv|tsv|pdf|zip|docx|pptx|txt|json|xml|html|md|png|jpe?g))(?=\s|$|[,;!?。，；！？：:）)"'])/gi;

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
  BARE_PATH_RE.lastIndex = 0;
  for (let m = BARE_PATH_RE.exec(text); m !== null; m = BARE_PATH_RE.exec(text)) {
    const fullPath = (m[1] || "") + (m[2] ?? "");
    const start = m.index + m[0].length - fullPath.length;
    const end = start + fullPath.length;
    if (tokens.some((t) => start < t.end && end > t.start)) continue;
    tokens.push({ start, end, raw: fullPath, kind: "path", value: fullPath });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

export function mentionLabel(token: MentionToken): string {
  return fileName(token.value) || token.value;
}

/** 输入框插入的文件引用写法。 */
export function fileMention(path: string): string {
  return `@${path.replace(/\\/g, "/").replace(/^\.\//, "")}`;
}
