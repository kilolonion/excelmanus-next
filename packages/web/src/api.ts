// API 客户端装配：令牌从 URL #token= 读入 → localStorage → 清掉 hash（11 §4）。

import { createApiClient } from "@excelmanus/protocol";

const TOKEN_KEY = "excelmanus.token";

export function bootstrapToken(): string | null {
  const hash = window.location.hash;
  const m = /(?:^|#|&)token=([A-Za-z0-9_-]+)/.exec(hash);
  if (m?.[1]) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function apiClient(token: string) {
  const base = `${window.location.protocol}//${window.location.host}`;
  return createApiClient(base, token);
}

export function wsUrl(ticket: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/sync?ticket=${ticket}`;
}
