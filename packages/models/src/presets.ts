// 提供商预设表（09 §2）：显示名、默认 Base URL、适配包、直连信息。
// 新增提供商只改这张表，不改运行时。

import type { ProviderPreset } from "@excelmanus/protocol";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    adapter: "openai",
    apiKeyHelpUrl: "https://platform.openai.com/api-keys",
    suggestedModels: ["gpt-5.1", "gpt-5-mini"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    adapter: "anthropic",
    apiKeyHelpUrl: "https://console.anthropic.com/settings/keys",
    suggestedModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  {
    id: "google",
    displayName: "Google Gemini",
    adapter: "google",
    apiKeyHelpUrl: "https://aistudio.google.com/apikey",
    suggestedModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    adapter: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    directChina: true,
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "moonshot",
    displayName: "Kimi（Moonshot）",
    adapter: "moonshotai",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    directChina: true,
    apiKeyHelpUrl: "https://platform.moonshot.cn/console/api-keys",
    suggestedModels: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
  },
  {
    id: "qwen",
    displayName: "通义千问（阿里云百炼）",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    directChina: true,
    apiKeyHelpUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    suggestedModels: ["qwen-max", "qwen-plus", "qwen3-coder-plus"],
  },
  {
    id: "zhipu",
    displayName: "智谱 GLM",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    directChina: true,
    apiKeyHelpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    suggestedModels: ["glm-4.6", "glm-4.5-air"],
  },
  {
    id: "doubao",
    displayName: "豆包（火山方舟）",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    directChina: true,
    apiKeyHelpUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    note: "模型处填写方舟控制台中的模型 ID 或推理接入点 ID",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    directChina: true,
    apiKeyHelpUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    suggestedModels: ["MiniMax-M2"],
  },
  {
    id: "mimo",
    displayName: "小米 MiMo",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    directChina: true,
    apiKeyHelpUrl: "https://xiaomimimo.com",
  },
  {
    id: "xai",
    displayName: "xAI Grok",
    adapter: "xai",
    apiKeyHelpUrl: "https://console.x.ai",
    suggestedModels: ["grok-4", "grok-4-fast"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyHelpUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    displayName: "Ollama（本机）",
    adapter: "openai-compatible",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    auth: "none",
  },
  {
    id: "chatgpt",
    displayName: "ChatGPT 订阅（Codex）",
    adapter: "chatgpt",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "subscription",
    note: "通过 ChatGPT 订阅账号访问的非公开接口：可用模型以登录后的发现结果为准，接口可能随时变化。",
    suggestedModels: ["gpt-5.1-codex", "gpt-5.1"],
  },
  {
    id: "custom-openai-compatible",
    displayName: "OpenAI 兼容接口（自定义）",
    adapter: "openai-compatible",
  },
];

export function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
