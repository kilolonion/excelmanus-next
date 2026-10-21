// 启动编排：建立后端会话 → 校验协议版本 → 打开同步通道 → 加载工作区/模型/设置/会话 → 进入上次的工作区。

import { protocolCompatible } from "@excelmanus/protocol";
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
import { openWorkspace, preferredWorkspaceId, refreshSessions } from "@/stores/session-store";
import "@/stores/workbook-store";
import { firstScreenMetrics } from "@/lib/first-screen-metrics";

const set = useAppStore.setState;
let booting: Promise<void> | null = null;

async function connectWithRetry(): Promise<"ok" | "signed-out" | "failed"> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await connectBackend();
    } catch {
      set({ bootMessage: `服务尚未就绪，正在重试（第 ${attempt + 1} 次）...` });
      await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** attempt, 2500)));
    }
  }
  return "failed";
}

async function boot(onProtocolReady?: () => void): Promise<void> {
  firstScreenMetrics?.mark("boot-start");
  const connected = await connectWithRetry();
  if (connected === "signed-out") return set({ status: "signed-out" });
  if (connected === "failed") return set({ status: "auth-failed" });
  firstScreenMetrics?.mark("backend-connected");
  try {
    const info = await api().bootstrap();
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
  void refreshProfiles().catch(() => undefined);
  void refreshSettings().catch(() => undefined);
  await Promise.all([refreshWorkspaces(), refreshSessions()]);
  if (useAppStore.getState().status !== "booting") return;
  const workspaceId = preferredWorkspaceId();
  if (workspaceId) await openWorkspace(workspaceId).catch(() => undefined);
  firstScreenMetrics?.mark("workspace-ready");
  if (useAppStore.getState().status === "booting") set({ status: "ready" });
}

export function bootApp(onProtocolReady?: () => void): Promise<void> {
  booting ??= boot(onProtocolReady).catch(() => {
    if (useAppStore.getState().status === "booting") set({ status: "auth-failed" });
  });
  return booting;
}
