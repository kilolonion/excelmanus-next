// ResolvedModel → AI SDK LanguageModelV4。AI SDK 类型只出现在 models 包适配层。

import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ResolvedModel } from "@excelmanus/protocol";
import { presetFor } from "./presets.ts";

export function resolveLanguageModel(model: ResolvedModel): LanguageModelV4 {
  const preset = presetFor(model.provider);
  const adapter = preset?.adapter ?? "openai-compatible";
  const baseURL = model.baseUrl ?? preset?.defaultBaseUrl;
  switch (adapter) {
    case "openai":
      // OpenAI 默认 Responses API（09 §2）
      return createOpenAI({ apiKey: model.apiKey, baseURL }).languageModel(model.model as never);
    case "anthropic":
      return createAnthropic({ apiKey: model.apiKey, baseURL }).languageModel(model.model as never);
    case "deepseek":
      return createDeepSeek({ apiKey: model.apiKey, baseURL }).languageModel(model.model as never);
    default: {
      if (!baseURL) {
        throw new Error(`提供商 ${model.provider} 需要填写 Base URL（或该预设未提供默认值）`);
      }
      return createOpenAICompatible({
        name: preset?.id ?? "custom-openai-compatible",
        baseURL,
        apiKey: model.apiKey,
        includeUsage: true,
      }).chatModel(model.model);
    }
  }
}
