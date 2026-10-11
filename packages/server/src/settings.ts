// 应用设置（10 §3.1 settings 表、11 §4 GET/PATCH /settings）：键与默认值集中在这里。
// 代理设置（09 §7）：设置中的 HTTP(S) 代理优先，否则使用系统环境变量；可设置不走代理的地址。

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@excelmanus/core";
import type { AppSettings } from "@excelmanus/protocol";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultPermissionMode: "standard",
  defaultDispatchMode: "steer",
  subAgentProfileId: null,
  compactionProfileId: null,
  autoCompact: true,
  maxConcurrentSubAgents: 4,
  httpProxy: null,
  noProxy: null,
  memoryInjection: true,
};

/** 修改后需要重启才生效的键。 */
export const RESTART_KEYS: readonly (keyof AppSettings)[] = ["maxConcurrentSubAgents"];

export class SettingsStore {
  private readonly db: DatabaseSync;
  private cache: AppSettings | undefined;
  private fetchCache: { key: string; fetch: typeof fetch } | undefined;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(): AppSettings {
    if (this.cache) return this.cache;
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (r.key in DEFAULT_SETTINGS) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          // 损坏的值回退默认
        }
      }
    }
    this.cache = out as AppSettings;
    return this.cache;
  }

  patch(patch: Partial<AppSettings>): { settings: AppSettings; restartRequired: string[] } {
    const now = nowIso();
    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    const before = this.get();
    const restart: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
      upsert.run(k, JSON.stringify(v), now);
      if (RESTART_KEYS.includes(k as keyof AppSettings) && before[k as keyof AppSettings] !== v)
        restart.push(k);
    }
    this.cache = undefined;
    return { settings: this.get(), restartRequired: restart };
  }

  /** 模型请求与联网操作使用的 fetch：带代理设置（未配置时仍尊重 HTTP(S)_PROXY 环境变量）。 */
  fetch(): typeof fetch {
    const s = this.get();
    const key = `${s.httpProxy ?? ""}|${s.noProxy ?? ""}|${process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ""}|${process.env.HTTP_PROXY ?? process.env.http_proxy ?? ""}`;
    if (this.fetchCache?.key === key) return this.fetchCache.fetch;
    const hasEnv = Boolean(
      process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy,
    );
    let f: typeof fetch = globalThis.fetch;
    if (s.httpProxy || hasEnv) {
      const dispatcher = new EnvHttpProxyAgent({
        ...(s.httpProxy ? { httpProxy: s.httpProxy, httpsProxy: s.httpProxy } : {}),
        ...(s.noProxy ? { noProxy: s.noProxy } : { noProxy: "localhost,127.0.0.1,::1" }),
      });
      f = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        undiciFetch(
          input as never,
          { ...(init as object), dispatcher } as never,
        )) as unknown as typeof fetch;
    }
    this.fetchCache = { key, fetch: f };
    return f;
  }
}
