// API 客户端装配：本机 Web 形态通过同源 HttpOnly Cookie 自动建立会话；
// 桌面形态（13 §1.1）由预加载脚本注入后端地址与令牌，前端来源固定为 app://excelmanus。

import { createApiClient } from "@excelmanus/protocol";

const AUTH_PAUSED_KEY = "excelmanus.auth-paused";
const LEGACY_TOKEN_KEY = "excelmanus.token";

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
  // 兼容旧启动链接：只在本次请求中使用，成功后立即清除，不再写入浏览器存储。
  const m = /(?:^|#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (m?.[1]) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return m[1];
  }
  // 一次性迁移旧版本的 localStorage 令牌，成功请求后不再保留。
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  return legacy;
}

export function clearToken(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export function browserSessionPaused(): boolean {
  return localStorage.getItem(AUTH_PAUSED_KEY) === "1";
}

export function pauseBrowserSession(): void {
  localStorage.setItem(AUTH_PAUSED_KEY, "1");
}

export function resumeBrowserSession(): void {
  localStorage.removeItem(AUTH_PAUSED_KEY);
}

export function apiClient(token: string | null) {
  return createApiClient(backendBase(), token);
}

export function wsUrl(ticket: string): string {
  const base = new URL(backendBase());
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}/api/v1/sync?ticket=${ticket}`;
}
