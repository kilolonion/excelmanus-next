// 上下文压缩：token 估算、切点规划与摘要转录（04 §6.3）。
// 纯函数；运行时负责调用与持久化。

import type { ContextItem } from "@excelmanus/protocol";

export const COMPACTION_SYSTEM = `你是对话压缩器。你的输出会替换掉较早的对话记录，成为代理继续工作时唯一能看到的早期信息。只依据给出的记录，不补充、不猜测。`;

export const COMPACTION_PROMPT = `以上是需要压缩的较早对话记录。请用简体中文输出结构化摘要，严格使用以下六个小节标题，某节没有内容时写"无"：

## 用户目标与约束
## 已做出的决定
## 涉及的文件与最后已知修订号
（逐条列出路径、docId、最后一次看到的修订号 rev；记录中没有修订号的写"未知"）
## 未完成的待办
## 用户明确说过的偏好
## 重要中间结果
（如识别出的表头口径、关键数值、区域地址、失败过的做法及原因）

要求：
- 只写记录中明确出现的内容。推测或未经确认的判断必须标注"（未确认）"，不能写成事实。
- 保留具体的文件路径、工作表名、单元格区域、数值和修订号，不要概括成模糊描述。
- 不要复述工具的原始输出，只保留结论。
- 只输出摘要本身，不要加开场白或结尾。`;

export type CompactionTrigger = "auto" | "manual" | "overflow";

function visualContent(item: ContextItem): { text: unknown; images: number } {
  if (item.kind === "user" && item.images?.length) {
    return {
      text: { ...item, images: item.images.map(({ data: _bytes, ...ref }) => ref) },
      images: item.images.length,
    };
  }
  if (item.kind === "toolResult" && item.output && typeof item.output === "object") {
    const { images, ...output } = item.output as Record<string, unknown>;
    if (Array.isArray(images) && images.length)
      return { text: { ...item, output }, images: images.length };
  }
  return { text: item, images: 0 };
}

/** 字符估算 token（无提供商用量时的兜底，04 §6.1）：ceil(字符数 / 4)。 */
export function estimateTokens(items: ContextItem[]): number {
  let chars = 0;
  // Images consume vision tokens, not base64 text tokens. This is a fallback estimate;
  // provider-reported input usage remains authoritative and overflow remains bounded.
  for (const item of items) {
    const content = visualContent(item);
    chars += JSON.stringify(content.text).length + content.images * 4096 * 4;
  }
  return Math.ceil(chars / 4);
}

/** 保留尾部预算：窗口已知取 20%，否则取当前估算的 20%（04 §6.3）。 */
export function keepBudgetTokens(contextWindow: number | undefined, currentTokens: number): number {
  return Math.floor(0.2 * (contextWindow ?? currentTokens));
}

export interface CompactionRow {
  item: ContextItem;
  fromSeq: number;
}

export interface CompactionPlan {
  /** 被摘要取代的旧条目（原文顺序）。 */
  old: CompactionRow[];
  /** 保留尾部第一条条目的 from_seq；null = 不保留原文。 */
  keepFromSeq: number | null;
}

/**
 * 规划压缩切点：从尾部向前累加直到超出 keepBudget；
 * 切点条目不得是孤立 toolResult（assistant 的 toolCalls 与其结果保持同侧）。
 */
export function planCompaction(rows: CompactionRow[], keepBudget: number): CompactionPlan | null {
  let acc = 0;
  let cut = rows.length;
  while (cut > 0) {
    const row = rows[cut - 1];
    if (row === undefined) break;
    const tokens = estimateTokens([row.item]);
    if (acc + tokens > keepBudget) break;
    acc += tokens;
    cut -= 1;
  }
  while (cut < rows.length && rows[cut]?.item.kind === "toolResult") cut += 1;
  // An image produced after the last successful model output has not been consumed.
  // Keep its complete call/result group even across failures, retries and log replay.
  // Once a following assistant output exists the normal bounded tail policy applies.
  const lastAssistant = rows.findLastIndex((row) => row.item.kind === "assistant");
  if (
    lastAssistant >= 0 &&
    rows
      .slice(lastAssistant + 1)
      .some(
        (row) =>
          row.item.kind === "toolResult" && !row.item.isError && visualContent(row.item).images > 0,
      )
  )
    cut = Math.min(cut, lastAssistant);
  const old = rows.slice(0, cut);
  if (old.length < 2) return null;
  return { old, keepFromSeq: rows[cut]?.fromSeq ?? null };
}

/**
 * 按位置取保留尾部：活跃条目按 idx 排序后，找第一条 fromSeq === keepFromSeq
 * 的条目，取它及之后的全部。压缩后 from_seq 不再随 idx 单调（摘要条目的
 * from_seq 大于保留尾部），按值 >= 过滤会把旧摘要误当尾部复制。
 * keepFromSeq 为 null 或找不到 → 不保留。
 */
export function tailFrom<T extends { fromSeq: number }>(
  rows: readonly T[],
  keepFromSeq: number | null,
): T[] {
  if (keepFromSeq === null) return [];
  const at = rows.findIndex((r) => r.fromSeq === keepFromSeq);
  return at === -1 ? [] : rows.slice(at);
}

const MAX_ENTRY_CHARS = 4000;

function truncateEntry(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…（已截断）` : text;
}

/** 把待压缩条目渲染成纯文本转录（摘要调用不传 tools，避免结构化工具消息被拒）。 */
export function transcriptForSummary(items: ContextItem[]): string {
  const entries: string[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      entries.push(truncateEntry(`【用户】\n${item.text}`));
    } else if (item.kind === "assistant") {
      let entry = `【助手】\n${item.text ?? ""}`;
      for (const tc of item.toolCalls ?? []) {
        entry += `\n【调用工具 ${tc.name}】${JSON.stringify(tc.args)}`;
      }
      entries.push(truncateEntry(entry));
    } else {
      const content = visualContent(item);
      const output = (content.text as Extract<ContextItem, { kind: "toolResult" }>).output;
      entries.push(truncateEntry(`【工具结果 ${item.toolName}】${JSON.stringify(output)}`));
      if (content.images)
        entries.push(
          `【图片未保留】${content.images} 张图片的像素不在摘要中；需要视觉核对时，按上面的文档、工作表、区域重新调用工具，不能把文字摘要当作看过图片。`,
        );
    }
  }
  return entries.join("\n\n");
}
