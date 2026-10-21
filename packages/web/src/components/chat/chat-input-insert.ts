import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { fileName, normalizePath } from "@/lib/paths";
import { extractMentions } from "./mention-tokens";

/**
 * 工作区文件在消息文本里的引用：`@相对路径`（见 mention-tokens）。
 * 区域不写进文本，而是作为结构化上下文（ContextRef）随消息发送。
 */
export function formatFileMention(opts: { path: string }): string {
  return `@${normalizePath(opts.path)}`;
}

/**
 * 截断长文件名的提及 token，保留前缀 + 前 N 字符 + … + 扩展名。
 * 返回 [displayToken, fullToken]；若无需截断则两者相同。
 *
 * 例: "@file:学生成绩_2024_第一学期_期末考试.xlsx[Sheet1!A1:C10]"
 *   → "@file:学生成绩_…考试.xlsx[Sheet1!A1:C10]"
 */
export function truncateMention(
  token: string,
  maxFilenameLen = 16,
): [display: string, full: string] {
  // 匹配 @[file:]<path>[rangeSpec][@sha256:…] 结构
  const m = token.match(/^(@(?:file:)?)(.+?)(\[[^\]]*\])?(@sha256:[0-9a-fA-F]+)?$/);
  if (!m) return [token, token];
  const [, prefix, filename, rangePart = "", versionPart = ""] = m;

  const slash = filename.lastIndexOf("/");
  const dir = slash >= 0 ? filename.slice(0, slash + 1) : "";
  const baseName = slash >= 0 ? filename.slice(slash + 1) : filename;

  if (baseName.length <= maxFilenameLen) return [token, token];

  const dotIdx = baseName.lastIndexOf(".");
  const ext = dotIdx > 0 ? baseName.slice(dotIdx) : "";
  const base = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;

  // 保留目录 + 首 6 字符 + … + 末 4 字符 + 扩展名
  const head = base.slice(0, 6);
  const tail = base.slice(-4);
  const short = `${head}…${tail}${ext}`;

  const display = `${prefix}${dir}${short}${rangePart}${versionPart}`;
  return [display, token];
}

const FILE_MENTION_RE = /^@(?:file:)?([^\s[\]@]+)(?:\[([^\]]*)\])?(?:@(sha256:[0-9a-fA-F]+))?$/;

interface ParsedFileMention {
  path: string;
  rangeSpec: string | null;
}

function parseFileMention(token: string): ParsedFileMention | null {
  const m = token.match(FILE_MENTION_RE);
  if (!m) return null;
  return {
    path: m[1].replace(/\\/g, "/").replace(/^\.\//, ""),
    rangeSpec: m[2] ? m[2] : null,
  };
}

function collapseSingleCellRange(rangeSpec: string): string {
  const bang = rangeSpec.lastIndexOf("!");
  const sheetPrefix = bang >= 0 ? rangeSpec.slice(0, bang + 1) : "";
  const cells = bang >= 0 ? rangeSpec.slice(bang + 1) : rangeSpec;
  const single = cells.match(/^([A-Za-z]+[0-9]+):\1$/i);
  return `${sheetPrefix}${single ? single[1] : cells}`;
}

function mentionFileLabel(fileLabel: string, rangeSpec: string | null): string {
  if (!rangeSpec) return fileLabel;
  return `${fileLabel} · ${collapseSingleCellRange(rangeSpec)}`;
}

function basenameOf(path: string): string {
  return fileName(path) || path;
}

function withParentDir(path: string): string | null {
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${basenameOf(path)}`;
}

/**
 * 可见层标签：basename + 可选 ` · Sheet!Range`（单格 B1:B1 → B1）。
 * 不含 `@file:` / 目录 / sha256。无法解析时 display 与 full 均为原文。
 */
export function formatMentionDisplay(fullToken: string): { display: string; full: string } {
  const parsed = parseFileMention(fullToken);
  if (!parsed) return { display: fullToken, full: fullToken };
  return {
    display: mentionFileLabel(`@${basenameOf(parsed.path)}`, parsed.rangeSpec),
    full: fullToken,
  };
}

function resolveUniqueDisplay(
  fullToken: string,
  preferred: string,
  taken: Set<string>,
  tokenMap: Map<string, string>,
): string {
  const available = (label: string) => tokenMap.get(label) === fullToken || !taken.has(label);

  if (available(preferred)) return preferred;

  const parsed = parseFileMention(fullToken);
  if (!parsed) return preferred;

  const dirSegment = withParentDir(parsed.path);
  if (dirSegment) {
    const withDir = mentionFileLabel(`@${dirSegment}`, parsed.rangeSpec);
    if (available(withDir)) return withDir;
  }

  return mentionFileLabel(`@${parsed.path}`, parsed.rangeSpec);
}

export function insertTokensIntoText(
  text: string,
  cursorPos: number,
  tokens: string[],
): { newText: string; newCursorPos: number } {
  if (tokens.length === 0) return { newText: text, newCursorPos: cursorPos };
  const before = text.slice(0, cursorPos);
  const after = text.slice(cursorPos);
  const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
  const prefix = needsSpace ? " " : "";
  const mentions = tokens.join(" ");
  const inserted = `${prefix}${mentions} `;
  return {
    newText: before + inserted + after,
    newCursorPos: before.length + inserted.length,
  };
}

export function scheduleTextareaCursor(
  textarea: HTMLTextAreaElement | null,
  pos: number,
  extra?: () => void,
) {
  requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(pos, pos);
    extra?.();
  });
}

type MentionTrie = { children: Map<string, MentionTrie>; token?: string };
const mentionBoundary = (c: string | undefined) =>
  !c || /[\s,;!?，；！？、。:：()（）"'“”]/.test(c);

function buildMentionTrie(tokens: Iterable<string>): MentionTrie {
  const root: MentionTrie = { children: new Map() };
  for (const token of tokens) {
    if (!token) continue;
    let node = root;
    for (let i = 0; i < token.length; i++) {
      let next = node.children.get(token[i]);
      if (!next) {
        next = { children: new Map() };
        node.children.set(token[i], next);
      }
      node = next;
    }
    node.token = token;
  }
  return root;
}

/** Match complete tokens, longest first, without replacing text inside another filename. */
export function mentionOccurrences(text: string, tokens: Iterable<string>) {
  const root = buildMentionTrie(tokens);
  const spans: { start: number; end: number; token: string }[] = [];
  if (root.children.size === 0) return spans;
  for (let i = 0; i < text.length; i++) {
    let node = root.children.get(text[i]);
    if (!node || !mentionBoundary(text[i - 1])) continue;
    let token: string | undefined;
    for (let end = i + 1; node; end++) {
      if (node.token && mentionBoundary(text[end])) token = node.token;
      node = node.children.get(text[end]);
    }
    if (!token) continue;
    spans.push({ start: i, end: i + token.length, token });
    i += token.length - 1;
  }
  return spans;
}

/** Keep confirmed labels that are still present, preserving their full-path mappings. */
export function reconcileMentionTokens(
  text: string,
  previous: Set<string>,
  tokenMap: Map<string, string>,
): Set<string> {
  if (previous.size === 0) return previous;
  const root = buildMentionTrie(previous);
  const present = new Set<string>();
  // Unlike display matching, presence includes overlapping complete labels.
  for (let i = 0; i < text.length; i++) {
    let node = root.children.get(text[i]);
    if (!node || !mentionBoundary(text[i - 1])) continue;
    for (let end = i + 1; node; end++) {
      if (node.token && mentionBoundary(text[end])) present.add(node.token);
      node = node.children.get(text[end]);
    }
  }
  let changed = false;
  const next = new Set<string>();
  previous.forEach((token) => {
    if (present.has(token)) next.add(token);
    else {
      changed = true;
      tokenMap.delete(token);
    }
  });
  return changed ? next : previous;
}

export function applyDisplayReplacements(text: string, tokenMap: Map<string, string>): string {
  let cursor = 0;
  let result = "";
  for (const span of mentionOccurrences(text, tokenMap.keys())) {
    result += text.slice(cursor, span.start) + tokenMap.get(span.token);
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

/** Drafts persist full paths; restore their visible labels without losing identity. */
export function restoreMentionDraft(raw: string) {
  const map = new Map<string, string>();
  const tokens = new Set<string>();
  let text = "";
  let cursor = 0;
  const spans = extractMentions(raw).filter((t) => t.kind === "file");
  const labels = toDisplayMentionTokens(
    spans.map((span) => span.raw),
    map,
  );
  for (const [index, span] of spans.entries()) {
    const label = labels[index];
    tokens.add(label);
    text += raw.slice(cursor, span.start) + label;
    cursor = span.end;
  }
  return { text: text + raw.slice(cursor), map, tokens };
}

export function toDisplayMentionTokens(
  fullTokens: string[],
  tokenMap: Map<string, string>,
): string[] {
  const taken = new Set(tokenMap.keys());
  return fullTokens.map((fullToken) => {
    const { display: preferred, full } = formatMentionDisplay(fullToken);
    const display = resolveUniqueDisplay(fullToken, preferred, taken, tokenMap);
    taken.add(display);
    tokenMap.set(display, full);
    return display;
  });
}

export function detectAtMentionTrigger(value: string): string | null {
  const lastAtIdx = value.lastIndexOf("@");
  if (lastAtIdx >= 0 && (lastAtIdx === 0 || value[lastAtIdx - 1] === " ")) {
    const afterAt = value.slice(lastAtIdx + 1);
    if (!afterAt.includes(" ")) return afterAt;
  }
  return null;
}

export function useInsertMentionTokens(
  text: string,
  setText: Dispatch<SetStateAction<string>>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  tokenMapRef: MutableRefObject<Map<string, string>>,
  setConfirmedTokens: Dispatch<SetStateAction<Set<string>>>,
) {
  return useCallback(
    (fullTokens: string[], afterInsert?: () => void) => {
      const displayTokens = toDisplayMentionTokens(fullTokens, tokenMapRef.current);
      setConfirmedTokens((prev) => {
        const next = new Set(prev);
        for (const token of displayTokens) next.add(token);
        return next;
      });
      const textarea = textareaRef.current;
      const cursorPos = textarea?.selectionStart ?? text.length;
      const { newText, newCursorPos } = insertTokensIntoText(text, cursorPos, displayTokens);
      setText(newText);
      scheduleTextareaCursor(textarea, newCursorPos, afterInsert);
    },
    [text, setText, textareaRef, tokenMapRef, setConfirmedTokens],
  );
}
