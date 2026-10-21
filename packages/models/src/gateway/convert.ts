// ContextItem[] → AI SDK ModelMessage[] 转换。AI SDK 类型只出现在 gateway 目录内。

import { type ContextItem, numericEvidence } from "@excelmanus/protocol";
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

type ImagePart = { type: "file"; data: { type: "data"; data: string }; mediaType: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Add copyable references after context truncation, using only this visible receipt.
 * This is guidance, not authority: present still checks visibility and freshness. */
function withNumericEvidence(item: Extract<ContextItem, { kind: "toolResult" }>): unknown {
  const original = record(item.output);
  if (!original) return item.output;
  // This name belongs to the host. Tool/script-provided lookalikes cannot authorize a reference.
  const { numericEvidence: _untrusted, ...output } = original;
  if (item.isError) return output;
  const evidence = numericEvidence(item.toolCallId, item.toolName, output);
  return evidence ? { ...output, numericEvidence: evidence } : output;
}

export function toModelMessages(
  history: ContextItem[],
  opts: {
    vision?: boolean;
    /**
     * Chat 协议的 tool 消息只能是字符串（openai-compatible、moonshotai）：工具结果图片改放在
     * 紧随这批 tool 消息之后的 user 消息里，避免被序列化成 base64 文本（P1-42）。
     */
    toolImagesAsUser?: boolean;
  } = {},
): ModelMessage[] {
  const raw: ModelMessage[] = [];
  // toolImagesAsUser 时暂存的工具结果图片：遇到下一条非 tool 消息前作为 user 消息发出
  let pendingImages: ImagePart[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    raw.push({
      role: "user",
      content: [{ type: "text", text: "（上面工具结果中的图片）" }, ...pendingImages],
    });
    pendingImages = [];
  };
  const out = {
    push(msg: ModelMessage) {
      if (msg.role !== "tool") flushImages();
      raw.push(msg);
    },
  };
  for (const item of history) {
    switch (item.kind) {
      case "user": {
        // 01 §3 / 04 §7：图片附件发给支持视觉的模型；否则（或内容缺失）以文字说明代替
        const images = item.images ?? [];
        const sendable = opts.vision === false ? [] : images.filter((img) => img.data);
        const skipped = images.length - sendable.length;
        const note =
          skipped > 0
            ? opts.vision === false
              ? `\n\n（附件图片 ${skipped} 张未发送：当前模型不支持图片）`
              : `\n\n（附件图片 ${skipped} 张已不可用，未发送）`
            : "";
        out.push({
          role: "user",
          content: [
            { type: "text", text: item.text + note },
            ...sendable.map((img) => ({
              type: "image" as const,
              image: img.data as string,
              mediaType: img.mediaType,
            })),
          ],
        });
        break;
      }
      case "assistant": {
        const content: AssistantModelMessage["content"] = [];
        if (item.reasoning != null && item.reasoning.length > 0) {
          content.push({
            type: "reasoning",
            text: item.reasoning,
            providerOptions: item.reasoningProviderOptions as never,
          });
        }
        if (item.text != null && item.text.length > 0) {
          content.push({ type: "text", text: item.text });
        }
        for (const tc of item.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          });
        }
        // 空输出（无文本/思考/工具调用）不发送：Anthropic 拒绝空 assistant 消息（P1-43）
        if (content.length === 0) break;
        out.push({ role: "assistant", content });
        break;
      }
      case "toolResult": {
        const outputValue = withNumericEvidence(item);
        // 06 §2.3：ToolResult.images 作为视觉输入；其余字段仍以 JSON 文本给模型。
        const images =
          outputValue && typeof outputValue === "object" && !item.isError
            ? ((outputValue as { images?: unknown }).images as
                | { mediaType: string; data: string }[]
                | undefined)
            : undefined;
        if (Array.isArray(images) && images.length > 0 && opts.vision === false) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: "json",
                  value: { ...rest, note: "当前模型不支持视觉，图片未发送" } as never,
                },
              },
            ],
          });
          break;
        }
        if (Array.isArray(images) && images.length > 0 && opts.toolImagesAsUser) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: "json",
                  value: { ...rest, note: `图片 ${images.length} 张见下一条消息` } as never,
                },
              },
            ],
          });
          pendingImages.push(
            ...images.map((img) => ({
              type: "file" as const,
              data: { type: "data" as const, data: img.data },
              mediaType: img.mediaType,
            })),
          );
          break;
        }
        if (Array.isArray(images) && images.length > 0) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: "content",
                  value: [
                    { type: "text", text: JSON.stringify(rest) },
                    ...images.map((img) => ({
                      type: "file" as const,
                      mediaType: img.mediaType,
                      data: { type: "data" as const, data: img.data },
                    })),
                  ],
                },
              },
            ],
          });
          break;
        }
        const part: ToolModelMessage["content"][number] = {
          type: "tool-result",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          output:
            typeof outputValue === "string"
              ? item.isError
                ? { type: "error-text", value: outputValue }
                : { type: "text", value: outputValue }
              : item.isError
                ? { type: "error-json", value: outputValue as never }
                : { type: "json", value: outputValue as never },
        };
        out.push({ role: "tool", content: [part] });
        break;
      }
    }
  }
  flushImages();
  return mergeAdjacentUsers(raw);
}

/** 跳过空 assistant 或插入图片消息后，相邻 user 消息合并为一条（保持角色交替）。 */
function mergeAdjacentUsers(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev?.role === "user" && msg.role === "user") {
      const asParts = (c: typeof msg.content) =>
        typeof c === "string" ? [{ type: "text" as const, text: c }] : c;
      merged[merged.length - 1] = {
        role: "user",
        content: [...asParts(prev.content), ...asParts(msg.content)],
      };
      continue;
    }
    merged.push(msg);
  }
  return merged;
}
