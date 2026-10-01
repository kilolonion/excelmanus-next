// API 客户端装配：本机 Web 形态令牌从 URL #token= 读入 → localStorage → 清掉 hash（11 §4）；
// 桌面形态（13 §1.1）由预加载脚本注入后端地址与令牌，前端来源固定为 app://excelmanus。

import { createApiClient } from "@excelmanus/protocol";

const TOKEN_KEY = "excelmanus.token";

/** 预加载脚本经 contextBridge 暴露的白名单接口（13 §1.2）。 */
export interface DesktopBridge {
  backendUrl: string;
  token: string;
  platform: string;
  openExternal(url: string): void;
  showInFolder(workspaceId: string, path: string): void;
  chooseDirectory(): Promise<string | null>;
  checkForUpdates(): Promise<{ status: string; version?: string; message?: string }>;
  installUpdate(): void;
  onMenu(fn: (action: string) => void): void;
  onFocusSession(fn: (sessionId: string) => void): void;
  onUpdateStatus(fn: (s: { status: string; version?: string; message?: string }) => void): void;
}

export function desktop(): DesktopBridge | undefined {
  return (globalThis as { excelmanusDesktop?: DesktopBridge }).excelmanusDesktop;
}

function backendBase(): string {
  return desktop()?.backendUrl ?? `${window.location.protocol}//${window.location.host}`;
}

export function bootstrapToken(): string | null {
  const d = desktop();
  if (d) return d.token;
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
  return createApiClient(backendBase(), token);
}

export function wsUrl(ticket: string): string {
  const base = new URL(backendBase());
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}/api/v1/sync?ticket=${ticket}`;
}
