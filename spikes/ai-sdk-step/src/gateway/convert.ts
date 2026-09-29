// ContextItem[] → AI SDK ModelMessage[] 转换。AI SDK 类型只出现在 gateway 目录内。

import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import type { ContextItem } from "../neutral.ts";

export function toModelMessages(history: ContextItem[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const item of history) {
    switch (item.kind) {
      case "user":
        out.push({ role: "user", content: [{ type: "text", text: item.text }] });
        break;
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
        out.push({ role: "assistant", content });
        break;
      }
      case "toolResult": {
        const outputValue = item.output;
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
  return out;
}
