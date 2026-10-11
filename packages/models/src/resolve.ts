// ResolvedModel → AI SDK LanguageModelV4。AI SDK 类型只出现在 models 包适配层。

import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import type { ResolvedModel } from "@excelmanus/protocol";
import { chatgptFetch } from "./chatgpt.ts";
import { presetFor } from "./presets.ts";

export function resolveLanguageModel(model: ResolvedModel): LanguageModelV4 {
  const preset = presetFor(model.provider);
  const adapter = preset?.adapter ?? "openai-compatible";
  const baseURL = model.baseUrl ?? preset?.defaultBaseUrl;
  const common = {
    apiKey: model.apiKey,
    baseURL,
    ...(model.extraHeaders ? { headers: model.extraHeaders } : {}),
    ...(model.fetch ? { fetch: model.fetch } : {}),
  };
  const id = model.model as never;
  switch (adapter) {
    case "openai":
      // OpenAI 默认 Responses API（09 §2）
      return createOpenAI(common).languageModel(id);
    case "anthropic":
      return createAnthropic(common).languageModel(id);
    case "deepseek":
      return createDeepSeek(common).languageModel(id);
    case "google":
      return createGoogleGenerativeAI(common).languageModel(id);
    case "moonshotai":
      return createMoonshotAI(common).languageModel(id);
    case "xai":
      return createXai(common).languageModel(id);
    case "chatgpt": {
      // 09 §4.2 薄适配：官方 Responses 实现 + 自定义 fetch 注入订阅令牌与接口约束
      if (!model.subscription) throw new Error("该档案未关联订阅账号，请在设置中重新登录");
      return createOpenAI({
        apiKey: "subscription",
        baseURL: baseURL ?? "https://chatgpt.com/backend-api/codex",
        ...(model.extraHeaders ? { headers: model.extraHeaders } : {}),
        fetch: chatgptFetch(model.subscription, model.fetch ?? fetch),
      }).responses(id);
    }
    default: {
      if (!baseURL) {
        throw new Error(`提供商 ${model.provider} 需要填写 Base URL（或该预设未提供默认值）`);
      }
      return createOpenAICompatible({
        name: preset?.id ?? "custom-openai-compatible",
        baseURL,
        apiKey: model.apiKey === "" ? undefined : model.apiKey,
        includeUsage: true,
        ...(model.extraHeaders ? { headers: model.extraHeaders } : {}),
        ...(model.fetch ? { fetch: model.fetch } : {}),
      }).chatModel(model.model);
    }
  }
}
