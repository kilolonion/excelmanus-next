export const THINKING_EFFORT_LEVELS = [
  { key: "none", label: "关闭", desc: "不使用推理" },
  { key: "minimal", label: "极简", desc: "最少推理" },
  { key: "low", label: "低", desc: "轻度推理" },
  { key: "medium", label: "中", desc: "平衡模式" },
  { key: "high", label: "高", desc: "深度推理" },
  { key: "xhigh", label: "极高", desc: "更强推理" },
  { key: "max", label: "最深", desc: "最深推理" },
] as const;

export type ThinkingEffort = (typeof THINKING_EFFORT_LEVELS)[number]["key"];

export const DEFAULT_THINKING_EFFORT_OPTIONS: ThinkingEffort[] = THINKING_EFFORT_LEVELS.map(
  ({ key }) => key,
);

export function normalizeThinkingEffortOptions(value: unknown): ThinkingEffort[] {
  if (!Array.isArray(value)) return [...DEFAULT_THINKING_EFFORT_OPTIONS];
  const selected = new Set(value.filter((item): item is string => typeof item === "string"));
  const normalized = THINKING_EFFORT_LEVELS.map(({ key }) => key).filter((key) =>
    selected.has(key),
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_THINKING_EFFORT_OPTIONS];
}

export function formatThinkingDuration(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const r = seconds % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

// Skip whitespace natively; a star run contributes only its unpaired final star.
const PREVIEW_TOKEN = /\*+|[^\s*]/g;

export function thinkingPreview(content: string, max = 48): string {
  if (!Number.isFinite(max) || max < 0) {
    const oneLine = content.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (!oneLine) return "";
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }
  // Stop once the clipped prefix and the need for an ellipsis are known.
  let preview = "";
  let previousEnd = 0;
  let space = false;
  PREVIEW_TOKEN.lastIndex = 0;
  for (let match = PREVIEW_TOKEN.exec(content); match; match = PREVIEW_TOKEN.exec(content)) {
    if (match.index > previousEnd && preview) space = true;
    previousEnd = match.index + match[0].length;
    const char = match[0][0] === "*" ? (match[0].length % 2 ? "*" : "") : match[0];
    if (!char) continue;
    if (space) {
      preview += " ";
      space = false;
    }
    preview += char;
    if (preview.length > max) return `${preview.slice(0, max)}…`;
  }
  return preview;
}

export interface ThinkingSegment {
  text: string;
  bold: boolean;
}

/**
 * 将 thinking 原始文本解析为「行 → 片段」结构，供思考卡片渲染加粗。
 *
 * GPT / OAuth（Codex）等模型的推理摘要由多个 `**标题**` 段落组成，
 * 流式拼接后可能粘连为 `**A****B**`：这里把相邻加粗段规范为独立行。
 * 行内以 `**` 作为加粗开关切分片段；流式输出中途出现的未闭合 `**`
 * 视为加粗到行尾，避免渲染出裸 `**`。
 */
export function parseThinkingLines(content: string): ThinkingSegment[][] {
  const normalized = content.replace(/\*\*\*\*/g, "**\n**");
  return normalized.split("\n").map((line) => {
    const segments: ThinkingSegment[] = [];
    line.split("**").forEach((part, index) => {
      if (part) segments.push({ text: part, bold: index % 2 === 1 });
    });
    return segments;
  });
}

/** Preserve complete raw lines during appends; reparse the unfinished line for split ** markers. */
export function createThinkingLineReader() {
  let previous: { content: string; prefixEnd: number; prefix: ThinkingSegment[][] } | null = null;
  return (content: string): ThinkingSegment[][] => {
    const cached = previous && content.startsWith(previous.content) ? previous : null;
    const prefix = cached?.prefix ?? [];
    const start = cached?.prefixEnd ?? 0;
    const parsed = parseThinkingLines(content.slice(start));
    const prefixEnd = content.lastIndexOf("\n") + 1;
    // Four adjacent stars insert a display newline but cannot freeze a raw line mid-stream.
    const completed =
      prefixEnd === start
        ? 0
        : parsed.length - 1 - (content.slice(prefixEnd).match(/\*\*\*\*/g)?.length ?? 0);
    const frozen = parsed.slice(0, completed);
    // Detach slices before caching: otherwise each completed line can retain an old whole input.
    // A JSON string round-trip also preserves lone UTF-16 surrogates, unlike UTF-8 encoding.
    for (const segments of frozen)
      for (const segment of segments) segment.text = JSON.parse(JSON.stringify(segment.text));
    previous = {
      content,
      prefixEnd,
      prefix: frozen.length ? [...prefix, ...frozen] : prefix,
    };
    return prefix.length ? [...prefix, ...parsed] : parsed;
  };
}
