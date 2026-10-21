// 模型目录（09 §5）：打包的 models.dev 快照 + 覆盖文件；设置中"刷新模型目录"写入
// <数据目录>/cache/models-dev.json，更新失败不影响使用。目录只提供默认值与"官方声明"证据。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalogEntry } from "@excelmanus/protocol";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../catalog");

interface CatalogFile {
  updatedAt?: string;
  items: ModelCatalogEntry[];
}

function readFile(path: string): CatalogFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
  } catch {
    return undefined;
  }
}

export class ModelCatalog {
  private readonly cachePath: string;
  private readonly bundledDir: string;
  private items: ModelCatalogEntry[] = [];
  private updatedAt: string | null = null;
  private source: "bundled" | "cache" = "bundled";

  /** bundledDir：打包的快照目录（桌面安装包内为应用资源目录）。 */
  constructor(cacheDir: string, bundledDir: string = DEFAULT_DIR) {
    this.cachePath = join(cacheDir, "models-dev.json");
    this.bundledDir = bundledDir;
    this.load();
  }

  private load(): void {
    const cache = existsSync(this.cachePath) ? readFile(this.cachePath) : undefined;
    const base = cache ?? readFile(join(this.bundledDir, "models-dev.json")) ?? { items: [] };
    this.source = cache ? "cache" : "bundled";
    this.updatedAt = base.updatedAt ?? null;
    const overrides = readFile(join(this.bundledDir, "overrides.json"))?.items ?? [];
    const key = (e: ModelCatalogEntry) => `${e.provider}\0${e.model}`;
    const map = new Map(base.items.map((e) => [key(e), e]));
    for (const o of overrides) {
      const {
        sourceUrl: _s,
        verifiedAt: _v,
        ...entry
      } = o as ModelCatalogEntry & {
        sourceUrl?: string;
        verifiedAt?: string;
      };
      map.set(key(entry), { ...(map.get(key(entry)) ?? {}), ...entry });
    }
    this.items = [...map.values()];
  }

  list(provider?: string): {
    items: ModelCatalogEntry[];
    updatedAt: string | null;
    source: "bundled" | "cache";
  } {
    return {
      items: provider ? this.items.filter((e) => e.provider === provider) : this.items,
      updatedAt: this.updatedAt,
      source: this.source,
    };
  }

  lookup(provider: string, model: string): ModelCatalogEntry | undefined {
    const direct = this.items.find((e) => e.provider === provider && e.model === model);
    if (direct) return direct;
    // 自定义兼容接口/聚合路由：按模型 ID 跨提供商匹配（取第一条）
    const bare = model.includes("/") ? model.split("/").pop() : model;
    return this.items.find((e) => e.model === model || e.model === bare);
  }

  /** 联网刷新（只保留相同字段，写缓存后重载）。 */
  async refresh(fetchImpl: typeof fetch = fetch): Promise<void> {
    const res = await fetchImpl("https://models.dev/api.json", {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`models.dev 返回 HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, { models?: Record<string, RawModel> }>;
    const items: ModelCatalogEntry[] = [];
    for (const [preset, key] of Object.entries(CATALOG_PROVIDER_MAP)) {
      for (const m of Object.values(data[key]?.models ?? {})) items.push(fromRaw(preset, m));
    }
    if (items.length === 0) throw new Error("models.dev 返回内容为空");
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify({ updatedAt: new Date().toISOString(), items }));
    this.load();
  }
}

interface RawModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

/** 预设 id → models.dev 提供商 id（与 scripts/update-model-catalog.ts 一致）。 */
export const CATALOG_PROVIDER_MAP: Record<string, string> = {
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

function fromRaw(provider: string, m: RawModel): ModelCatalogEntry {
  return {
    provider,
    model: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.limit?.context ? { contextWindow: m.limit.context } : {}),
    ...(m.limit?.output ? { maxOutputTokens: m.limit.output } : {}),
    ...(m.tool_call !== undefined ? { tools: m.tool_call } : {}),
    vision: m.modalities?.input?.includes("image") ?? false,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.cost?.input !== undefined ? { inputPrice: m.cost.input } : {}),
    ...(m.cost?.output !== undefined ? { outputPrice: m.cost.output } : {}),
  };
}
