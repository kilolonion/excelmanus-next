// 模型设置页的纯函数：档案分组、品牌、显示文案。
import type { ModelProfile, ProviderPreset, RemoteModel } from "@excelmanus/protocol";
import {
  getProviderColor,
  getProviderDisplayName,
  inferModelBrand,
  presetBrand,
} from "@/lib/provider-brand";

type ProfileLike = Pick<ModelProfile, "provider" | "model"> & {
  name?: string | null;
  baseUrl?: string | null;
};

export interface ProviderGroup {
  /** 提供商预设 id（自定义接口按主机名区分）。 */
  id: string;
  label: string;
  /** 用于头像的品牌。 */
  logoId: string;
  color: string;
  profiles: ModelProfile[];
}

export function hostnameOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 分组键：预设 id；自定义 OpenAI 兼容接口按主机名拆开。 */
export function getProfileProviderId(profile: ProfileLike): string {
  if (profile.provider === "custom-openai-compatible") {
    const host = hostnameOf(profile.baseUrl);
    return host ? `custom:${host}` : `custom:${profile.name || "unnamed"}`;
  }
  return profile.provider;
}

export function getProviderGroupLabel(
  id: string,
  fallbackName?: string,
  providers: ProviderPreset[] = [],
): string {
  if (id.startsWith("custom:")) return fallbackName || id.slice("custom:".length);
  return providers.find((p) => p.id === id)?.displayName ?? getProviderDisplayName(presetBrand(id));
}

export function profileBrand(profile: ProfileLike): string {
  return inferModelBrand({
    model: profile.model,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
  });
}

export function groupProfilesByProvider(
  profiles: ModelProfile[],
  providers: ProviderPreset[],
): ProviderGroup[] {
  const map = new Map<string, ModelProfile[]>();
  for (const profile of profiles) {
    const id = getProfileProviderId(profile);
    const list = map.get(id);
    if (list) list.push(profile);
    else map.set(id, [profile]);
  }
  return Array.from(map.entries()).map(([id, list]) => {
    const brand = id.startsWith("custom:") ? profileBrand(list[0]) : presetBrand(id);
    return {
      id,
      label: getProviderGroupLabel(id, hostnameOf(list[0]?.baseUrl) || list[0]?.name, providers),
      logoId: brand,
      color: getProviderColor(brand),
      profiles: list,
    };
  });
}

export function filterDetectedModels<T extends { id: string }>(models: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => model.id.toLowerCase().includes(needle));
}

/** 128000 → "128K"，1048576 → "1M"。 */
export function formatTokens(value: number | null | undefined): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function remoteModelHint(model: RemoteModel): string {
  return model.contextWindow ? `${formatTokens(model.contextWindow)} 上下文` : "";
}

/** 新档案的默认名称：模型 ID 短名，重名时追加序号。 */
export function uniqueProfileName(modelId: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  const short = (modelId.split("/").pop() || modelId).trim() || "model";
  if (!taken.has(short)) return short;
  let index = 2;
  while (taken.has(`${short} ${index}`)) index += 1;
  return `${short} ${index}`;
}

export const REASONING_LABELS: Record<string, string> = {
  "provider-default": "服务商默认",
  none: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};
