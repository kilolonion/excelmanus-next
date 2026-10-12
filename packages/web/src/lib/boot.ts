// 启动编排：建立后端会话 → 校验协议版本 → 打开同步通道 → 加载工作区/模型/设置/会话 → 进入上次的工作区。

import { protocolCompatible } from "@excelmanus/protocol";
import { api, connectBackend } from "@/lib/backend/api";
import { onConnection, startChannel, subscribeTopic } from "@/lib/backend/channel";
import {
  refreshProfiles,
  refreshSettings,
  refreshWorkspaces,
  useAppStore,
} from "@/stores/app-store";
import { openWorkspace, preferredWorkspaceId, refreshSessions } from "@/stores/session-store";
// 以下 store 在导入时注册同步通道处理器
import "@/stores/files-store";
import "@/stores/workbook-store";

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

async function boot(): Promise<void> {
  const connected = await connectWithRetry();
  if (connected === "signed-out") return set({ status: "signed-out" });
  if (connected === "failed") return set({ status: "auth-failed" });
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
  onConnection((online) =>
    set((s) => ({ connected: online, everConnected: s.everConnected || online })),
  );
  subscribeTopic("app");
  startChannel({ onIncompatible: () => set({ status: "protocol-mismatch" }) });
  await Promise.all([
    refreshWorkspaces(),
    refreshProfiles().catch(() => undefined),
    refreshSettings().catch(() => undefined),
  ]);
  await refreshSessions();
  const workspaceId = preferredWorkspaceId();
  if (workspaceId) await openWorkspace(workspaceId).catch(() => undefined);
  set({ status: "ready" });
}

export function bootApp(): Promise<void> {
  booting ??= boot().catch(() => set({ status: "auth-failed" }));
  return booting;
}
