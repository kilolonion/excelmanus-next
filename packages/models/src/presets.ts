// 提供商预设表（09 §2）：显示名、默认 Base URL、适配包、直连信息。
// 新增提供商只改这张表，不改运行时。

import type { ProviderPreset } from "@excelmanus/protocol";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    adapter: "openai",
    apiKeyHelpUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    adapter: "anthropic",
    apiKeyHelpUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    adapter: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    directChina: true,
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
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
    id: "custom-openai-compatible",
    displayName: "OpenAI 兼容接口（自定义）",
    adapter: "openai-compatible",
  },
];

export function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
