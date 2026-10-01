// 构建时下载 models.dev 快照（09 §5，MIT 许可），只保留预设相关提供商与所需字段，
// 写入 packages/models/catalog/models-dev.json 随应用打包。用法：node scripts/update-model-catalog.ts [本地 api.json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 预设 id → models.dev 提供商 id
const MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai-cn",
  qwen: "alibaba-cn",
  zhipu: "zhipuai",
  doubao: "volcengine",
  minimax: "minimax-cn",
  mimo: "xiaomi",
  xai: "xai",
  openrouter: "openrouter",
};

interface Raw {
  models: Record<
    string,
    {
      id: string;
      name?: string;
      reasoning?: boolean;
      tool_call?: boolean;
      modalities?: { input?: string[] };
      limit?: { context?: number; output?: number };
      cost?: { input?: number; output?: number };
    }
  >;
}

const src = process.argv[2];
const data = (
  src
    ? JSON.parse(readFileSync(src, "utf8"))
    : await (
        await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) })
      ).json()
) as Record<string, Raw>;

const items = [];
for (const [preset, key] of Object.entries(MAP)) {
  for (const m of Object.values(data[key]?.models ?? {})) {
    if (m.tool_call === false && m.modalities?.input?.includes("text") !== true) continue;
    items.push({
      provider: preset,
      model: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.limit?.context ? { contextWindow: m.limit.context } : {}),
      ...(m.limit?.output ? { maxOutputTokens: m.limit.output } : {}),
      ...(m.tool_call !== undefined ? { tools: m.tool_call } : {}),
      vision: m.modalities?.input?.includes("image") ?? false,
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.cost?.input !== undefined ? { inputPrice: m.cost.input } : {}),
      ...(m.cost?.output !== undefined ? { outputPrice: m.cost.output } : {}),
    });
  }
}
const out = join(import.meta.dirname, "../packages/models/catalog/models-dev.json");
writeFileSync(
  out,
  `${JSON.stringify({ source: "https://models.dev (MIT)", updatedAt: new Date().toISOString(), items })}\n`,
);
console.log(`${items.length} 条 → ${out}`);
