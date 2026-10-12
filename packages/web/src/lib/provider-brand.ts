// 服务商品牌：颜色、显示名与图标（public/providers/*.svg）。品牌优先按模型本身识别，
// 这样经 OpenRouter / 自定义网关接入的模型也能显示正确的图标。

const BRANDS: Record<string, { color: string; name: string; logo?: string }> = {
  openai: { color: "#10a37f", name: "OpenAI", logo: "openai" },
  anthropic: { color: "#d4a574", name: "Anthropic", logo: "anthropic" },
  gemini: { color: "#4285f4", name: "Google Gemini", logo: "gemini" },
  deepseek: { color: "#4d6bfe", name: "DeepSeek", logo: "deepseek" },
  qwen: { color: "#ff6a00", name: "阿里云百炼", logo: "qwen" },
  zhipu: { color: "#2563eb", name: "智谱", logo: "zhipu" },
  moonshot: { color: "#7c3aed", name: "Moonshot", logo: "moonshot" },
  xai: { color: "#f28834", name: "xAI", logo: "xai" },
  mistral: { color: "#fa520f", name: "Mistral", logo: "mistral" },
  meta: { color: "#0467df", name: "Meta", logo: "meta" },
  openrouter: { color: "#7c3aed", name: "OpenRouter", logo: "openrouter" },
  tencent: { color: "#1ebafc", name: "腾讯", logo: "qq" },
  bytedance: { color: "#3c8cff", name: "字节跳动", logo: "bytedance" },
  baidu: { color: "#2932e1", name: "百度", logo: "baidu" },
  perplexity: { color: "#1fb8cd", name: "Perplexity", logo: "perplexity" },
  nvidia: { color: "#76b900", name: "NVIDIA", logo: "nvidia" },
  huggingface: { color: "#ffd21e", name: "Hugging Face", logo: "huggingface" },
  siliconflow: { color: "#06b6d4", name: "SiliconFlow", logo: "siliconcloud" },
  minimax: { color: "#ec5f27", name: "MiniMax", logo: "minimax" },
  alibabacloud: { color: "#ff6a00", name: "阿里云", logo: "alibabacloud" },
  huawei: { color: "#ff0000", name: "华为", logo: "huawei" },
  mimo: { color: "#ff6900", name: "小米 MiMo", logo: "xiaomi" },
  ollama: { color: "#111827", name: "Ollama", logo: "ollama" },
};

/** 二代提供商预设 id → 品牌。 */
const PRESET_BRAND: Record<string, string> = {
  openai: "openai",
  chatgpt: "openai",
  anthropic: "anthropic",
  google: "gemini",
  deepseek: "deepseek",
  moonshot: "moonshot",
  qwen: "qwen",
  zhipu: "zhipu",
  doubao: "bytedance",
  minimax: "minimax",
  mimo: "mimo",
  xai: "xai",
  openrouter: "openrouter",
  ollama: "ollama",
};

const MODEL_BRAND_PATTERNS: Array<[string, RegExp]> = [
  ["deepseek", /deep[-_\s]?seek/],
  ["anthropic", /anthropic|claude/],
  ["gemini", /gemini|generativelanguage\.googleapis/],
  ["qwen", /qwen|tongyi|dashscope|aliyuncs/],
  ["zhipu", /zhipu|\bglm[-_\s\d/]|bigmodel/],
  ["moonshot", /moonshot|kimi/],
  ["xai", /\bxai\b|\bgrok|api\.x\.ai/],
  ["mistral", /mistral|codestral|pixtral/],
  ["meta", /meta[-_\s/]?llama|\bllama/],
  ["tencent", /tencent|hunyuan|腾讯|混元/],
  ["bytedance", /bytedance|doubao|volcengine|volces|字节|豆包/],
  ["baidu", /baidu|ernie|qianfan|文心/],
  ["perplexity", /perplexity|\bpplx/],
  ["nvidia", /nvidia|nemotron/],
  ["huggingface", /huggingface|hugging[-_\s]?face|\bhf\//],
  ["siliconflow", /siliconflow|siliconcloud/],
  ["minimax", /minimax/],
  ["huawei", /huawei|pangu|华为|盘古/],
  ["mimo", /\bmimo|xiaomimimo|小米/],
  ["openai", /openai|chatgpt|\bgpt(?:[-_\s/]|\d)|\bo[134](?:[-_\s/]|$)|codex/],
];

function brandFromText(value: string | undefined | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  for (const [brand, pattern] of MODEL_BRAND_PATTERNS) if (pattern.test(normalized)) return brand;
  return null;
}

/** 识别模型品牌：模型名 → 提供商预设 → 接口地址。 */
export function inferModelBrand(source: {
  model?: string | null;
  name?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
}): string {
  return (
    brandFromText([source.model, source.name].filter(Boolean).join(" ")) ??
    (source.provider ? PRESET_BRAND[source.provider] : undefined) ??
    brandFromText(source.baseUrl) ??
    (source.provider || "unknown")
  );
}

export function presetBrand(providerId: string): string {
  return PRESET_BRAND[providerId] ?? providerId;
}

export function getProviderColor(brand: string): string {
  return BRANDS[brand]?.color ?? "#6b7280";
}

export function getProviderDisplayName(brand: string): string {
  return BRANDS[brand]?.name ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "未知");
}

export function providerLogoSlug(brand: string): string | undefined {
  return BRANDS[brand]?.logo;
}
