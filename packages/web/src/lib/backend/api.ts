// 后端连接：契约客户端（前端只经它发 REST）、桌面预加载桥、浏览器会话鉴权与同步通道地址。
// 本机 Web 通过同源 HttpOnly Cookie 建立会话；桌面由预加载脚本注入后端地址与令牌（来源 app://excelmanus）。

import {
  type ApiClient,
  ApiError,
  type ApiReadOptions,
  createApiClient,
} from "@excelmanus/protocol";

const AUTH_PAUSED_KEY = "excelmanus.auth-paused";

/** 预加载脚本经 contextBridge 暴露的白名单接口（13 §1.2）。 */
export interface DesktopBridge {
  backendUrl: string;
  token: string;
  platform: string;
  openExternal(url: string): void;
  showInFolder(workspaceId: string, path: string): void;
  chooseDirectory(): Promise<string | null>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  installUpdate(): void;
  onMenu(fn: (action: string) => void): void;
  onFocusSession(fn: (sessionId: string) => void): void;
  onUpdateStatus(fn: (s: DesktopUpdateStatus) => void): void;
}

export interface DesktopUpdateStatus {
  status: string;
  version?: string;
  message?: string;
  percent?: number;
}

export function desktop(): DesktopBridge | undefined {
  return (globalThis as { excelmanusDesktop?: DesktopBridge }).excelmanusDesktop;
}

export function isDesktop(): boolean {
  return desktop() !== undefined;
}

function backendBase(): string {
  return desktop()?.backendUrl ?? `${window.location.protocol}//${window.location.host}`;
}

export function wsUrl(ticket: string): string {
  const base = new URL(backendBase());
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}/api/v1/sync?ticket=${ticket}`;
}

let client: ApiClient | null = null;

/** 已鉴权的契约客户端；启动完成前调用视为编程错误。 */
export function api(): ApiClient {
  if (!client) throw new Error("API 未初始化");
  return client;
}

export function browserSessionPaused(): boolean {
  try {
    return localStorage.getItem(AUTH_PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 建立后端会话。桌面带令牌直连；浏览器用同源 POST 换 HttpOnly Cookie（令牌不进 URL 与本地存储）。
 * 用户主动退出后不自动登录，返回 "signed-out"。
 */
export async function connectBackend(options?: ApiReadOptions): Promise<"ok" | "signed-out"> {
  const bridge = desktop();
  if (bridge) {
    client = createApiClient(bridge.backendUrl, bridge.token);
    return "ok";
  }
  if (browserSessionPaused()) return "signed-out";
  client = createApiClient(backendBase(), null);
  await client.createBrowserSession(options);
  return "ok";
}

export async function signOut(): Promise<void> {
  await client?.logoutBrowserSession().catch(() => undefined);
  try {
    localStorage.setItem(AUTH_PAUSED_KEY, "1");
  } catch {
    // 存储不可用时仍刷新页面，Cookie 已清除
  }
  window.location.reload();
}

export function resumeBrowserSession(): void {
  try {
    localStorage.removeItem(AUTH_PAUSED_KEY);
  } catch {
    // ignore
  }
  window.location.reload();
}

/** 面向用户的错误文案：契约错误取服务端消息，其余取 Error.message。 */
export function errorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export { ApiError };

/** 触发浏览器下载（Blob → 临时链接）。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|]+/g, "_") || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
