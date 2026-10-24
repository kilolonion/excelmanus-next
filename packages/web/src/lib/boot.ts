// 启动编排：建立后端会话 → 校验协议版本 → 打开同步通道 → 加载工作区/模型/设置/会话 → 进入上次的工作区。

import { type ApiReadOptions, protocolCompatible } from "@excelmanus/protocol";
import { api, connectBackend } from "@/lib/backend/api";
import { onConnection, onSync, startChannel, subscribeTopic } from "@/lib/backend/channel";
import {
  refreshProfiles,
  refreshSettings,
  refreshWorkspaces,
  useAppStore,
} from "@/stores/app-store";
// 以下 store 在导入时注册同步通道处理器
import { refreshFiles } from "@/stores/files-store";
import {
  openWorkspace,
  preferredWorkspaceId,
  refreshSessions,
  restoreSavedWorkspace,
} from "@/stores/session-store";
import "@/stores/workbook-store";
import { firstScreenMetrics } from "@/lib/first-screen-metrics";

const set = useAppStore.setState;
let booting: Promise<void> | null = null;

async function connectWithRetry(signal: AbortSignal): Promise<"ok" | "signed-out" | "failed"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      return await connectBackend({ signal, timeoutMs: 12000 });
    } catch (error) {
      signal.throwIfAborted();
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403 || (status !== undefined && status < 500))
        return "failed";
      if (attempt === 1) break;
      set({ bootMessage: "服务暂时未响应，正在重试..." });
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 400);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  return "failed";
}

async function boot(signal: AbortSignal, onProtocolReady?: () => void): Promise<void> {
  const options: ApiReadOptions = { signal, timeoutMs: 15000 };
  firstScreenMetrics?.mark("boot-start");
  const connected = await connectWithRetry(signal);
  if (connected === "signed-out") return set({ status: "signed-out" });
  if (connected === "failed") return set({ status: "auth-failed" });
  firstScreenMetrics?.mark("backend-connected");
  try {
    const info = await api().bootstrap(options);
    signal.throwIfAborted();
    if (!protocolCompatible(info.protocolVersion)) return set({ status: "protocol-mismatch" });
    set({
      appVersion: info.appVersion,
      shape: info.shape,
      dataDir: info.dataDir ?? null,
      features: info.features,
      hasModelProfile: info.hasModelProfile,
      bootMessage: "服务已连接，正在加载工作区...",
    });
  } catch {
    return set({ status: "auth-failed" });
  }
  onProtocolReady?.();
  firstScreenMetrics?.mark("bootstrap-ready");
  let refreshAfterSubscribe = false;
  onConnection((online) => {
    const previous = useAppStore.getState();
    if (!online) refreshAfterSubscribe = false;
    else if (!previous.connected && previous.everConnected) refreshAfterSubscribe = true;
    set({ connected: online, everConnected: previous.everConnected || online });
  });
  onSync((message) => {
    if (message.type !== "sub.ok" || message.topic !== "app" || !refreshAfterSubscribe) return;
    refreshAfterSubscribe = false;
    // Start the read after app events are live, closing the socket-open/subscription gap.
    void refreshFiles({ loadedOnly: true });
  });
  subscribeTopic("app");
  startChannel({ onIncompatible: () => set({ status: "protocol-mismatch" }) });
  // Optional configuration must not hold workspace navigation behind a slow read.
  void refreshProfiles(options).catch(() => undefined);
  void refreshSettings(options).catch(() => undefined);
  const sessions = refreshSessions(options);
  // Observe early rejection while workspaces resolve; both branches must succeed before ready.
  void sessions.catch(() => undefined);
  await refreshWorkspaces(options);
  signal.throwIfAborted();
  if (useAppStore.getState().status !== "booting") return;
  const workspaceId = preferredWorkspaceId();
  const [, restored] = await Promise.all([
    sessions,
    workspaceId ? restoreSavedWorkspace(workspaceId, options) : Promise.resolve(false),
  ]);
  signal.throwIfAborted();
  if (!restored) {
    await sessions;
    signal.throwIfAborted();
    if (useAppStore.getState().status !== "booting") return;
    if (workspaceId) await openWorkspace(workspaceId, options);
  }
  signal.throwIfAborted();
  firstScreenMetrics?.mark("workspace-ready");
  if (useAppStore.getState().status === "booting") set({ status: "ready" });
}

export function bootApp(onProtocolReady?: () => void): Promise<void> {
  if (!booting) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException("连接超时，请重试", "TimeoutError");
        controller.abort(error);
        reject(error);
      }, 45000);
    });
    booting = Promise.race([boot(controller.signal, onProtocolReady), deadline])
      .catch(() => {
        controller.abort();
        if (useAppStore.getState().status === "booting") set({ status: "auth-failed" });
      })
      .finally(() => {
        clearTimeout(timer);
        if (useAppStore.getState().status !== "ready") controller.abort();
      });
  }
  return booting;
}
