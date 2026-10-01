// 拉取远端模型列表（09 §7）：按提供商使用正确的鉴权头与端点。

import type { ResolvedModel } from "@excelmanus/protocol";
import { presetFor } from "./presets.ts";
import { registerModelSecrets, registerSecret } from "./secrets.ts";

export interface RemoteModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  moonshotai: "https://api.moonshot.cn/v1",
  deepseek: "https://api.deepseek.com",
};

export async function listRemoteModels(model: ResolvedModel): Promise<RemoteModel[]> {
  const preset = presetFor(model.provider);
  const adapter = preset?.adapter ?? "openai-compatible";
  const base = (model.baseUrl ?? preset?.defaultBaseUrl ?? DEFAULT_BASE[adapter] ?? "").replace(
    /\/+$/,
    "",
  );
  const f = model.fetch ?? fetch;
  const signal = AbortSignal.timeout(20_000);
  registerModelSecrets(model);
  if (adapter === "chatgpt") {
    if (!model.subscription) throw new Error("该档案未关联订阅账号");
    const token = await model.subscription.accessToken();
    registerSecret(token);
    const res = await f(`${base}/models?client_version=0.60.0`, {
      headers: {
        authorization: `Bearer ${token}`,
        originator: "codex_cli_rs",
        ...(model.subscription.accountId
          ? { "chatgpt-account-id": model.subscription.accountId }
          : {}),
      },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      models?: { slug: string; visibility?: string; supported_in_api?: boolean }[];
    };
    return (body.models ?? []).filter((m) => m.visibility !== "hide").map((m) => ({ id: m.slug }));
  }
  if (!base) throw new Error("需要填写 Base URL");
  if (adapter === "anthropic") {
    const res = await f(`${base}/models?limit=100`, {
      headers: { "x-api-key": model.apiKey, "anthropic-version": "2023-06-01" },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id }));
  }
  if (adapter === "google") {
    const res = await f(`${base}/models?pageSize=200`, {
      headers: { "x-goog-api-key": model.apiKey },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      models?: {
        name: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }[];
    };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}),
        ...(m.outputTokenLimit ? { maxOutputTokens: m.outputTokenLimit } : {}),
      }));
  }
  const res = await f(`${base}/models`, {
    headers: {
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      ...(model.extraHeaders ?? {}),
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id: string; context_length?: number }[] };
  return (body.data ?? [])
    .map((m) => ({ id: m.id, ...(m.context_length ? { contextWindow: m.context_length } : {}) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
