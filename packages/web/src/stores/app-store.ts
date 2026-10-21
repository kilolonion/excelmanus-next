// 应用级状态：启动/连接、部署信息、工作区、模型档案与提供商、全局设置。
// 启动编排在 lib/boot.ts；这里只放数据与刷新动作。

import type {
  AppSettings,
  ModelProfile,
  ProviderConnection,
  ProviderPreset,
  UpdateSettingsBody,
  Workspace,
} from "@excelmanus/protocol";
import { create } from "zustand";
import { api, type DesktopUpdateStatus } from "@/lib/backend/api";
import { onSync } from "@/lib/backend/channel";

export type BootStatus = "booting" | "ready" | "signed-out" | "auth-failed" | "protocol-mismatch";

interface AppState {
  status: BootStatus;
  bootMessage: string;
  /** 同步通道是否在线（断线时界面提示，编辑不会自动重发）。 */
  connected: boolean;
  /** 本次页面生命周期内是否连上过：用于区分"正在连接"与"连接中断"。 */
  everConnected: boolean;
  appVersion: string;
  shape: string;
  dataDir: string | null;
  features: Record<string, boolean>;
  hasModelProfile: boolean;
  workspaces: Workspace[];
  profiles: ModelProfile[];
  profilesLoaded: boolean;
  profilesLoading: boolean;
  profilesError: string | null;
  connections: ProviderConnection[];
  providers: ProviderPreset[];
  settings: AppSettings | null;
  /** 桌面版自动更新状态（检查中 / 下载中 / 已就绪 / 失败）。 */
  desktopUpdate: DesktopUpdateStatus | null;
}

export const useAppStore = create<AppState>()(() => ({
  status: "booting",
  bootMessage: "正在连接服务...",
  connected: false,
  everConnected: false,
  appVersion: "",
  shape: "local-web",
  dataDir: null,
  features: {},
  hasModelProfile: false,
  workspaces: [],
  profiles: [],
  profilesLoaded: false,
  profilesLoading: false,
  profilesError: null,
  connections: [],
  providers: [],
  settings: null,
  desktopUpdate: null,
}));

const set = useAppStore.setState;
let workspaceRead = 0;
let profileRead = 0;

let latestWorkspaceRead: Promise<Workspace[]> | null = null;

export function refreshWorkspaces(): Promise<Workspace[]> {
  const request = ++workspaceRead;
  const pending = readWorkspaces(request).catch((error: unknown) => {
    if (request !== workspaceRead && latestWorkspaceRead) return latestWorkspaceRead;
    throw error;
  });
  latestWorkspaceRead = pending;
  return pending;
}

async function readWorkspaces(request: number): Promise<Workspace[]> {
  const { items } = await api().listWorkspaces();
  if (request !== workspaceRead) return latestWorkspaceRead ?? useAppStore.getState().workspaces;
  set({ workspaces: items });
  return items;
}

export async function refreshProfiles(): Promise<void> {
  const request = ++profileRead;
  set({ profilesLoading: true, profilesError: null });
  try {
    const [profiles, providers, connections] = await Promise.all([
      api().listModelProfiles(),
      api().listProviders(),
      api().listProviderConnections(),
    ]);
    if (request !== profileRead) return;
    set({
      profiles: profiles.items,
      connections: connections.items,
      providers: providers.items,
      hasModelProfile: profiles.items.length > 0,
      profilesLoaded: true,
      profilesLoading: false,
      profilesError: null,
    });
  } catch (error) {
    if (request === profileRead)
      set({
        profilesLoading: false,
        profilesError: error instanceof Error ? error.message : "无法读取模型列表",
      });
    throw error;
  }
}

let settingsRead = 0;

export async function refreshSettings(): Promise<AppSettings> {
  const request = ++settingsRead;
  const { settings } = await api().getSettings();
  if (request === settingsRead) set({ settings });
  return settings;
}

export async function updateSettings(
  patch: UpdateSettingsBody,
): Promise<{ restartRequired: string[] }> {
  const res = await api().updateSettings(patch);
  settingsRead += 1;
  set({ settings: res.settings });
  return { restartRequired: res.restartRequired };
}

// ---------- 工作区登记 ----------

export async function addWorkspace(path: string, name?: string): Promise<Workspace> {
  const { workspace } = await api().addWorkspace(path, name);
  await refreshWorkspaces();
  return workspace;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const next = name.trim();
  if (!next) return;
  set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: next } : w)) }));
  try {
    await api().updateWorkspace(id, { name: next });
  } finally {
    await refreshWorkspaces().catch(() => undefined);
  }
}

export async function setDefaultWorkspace(id: string): Promise<void> {
  await api().updateWorkspace(id, { isDefault: true });
  await refreshWorkspaces();
}

/** 只删除登记，不删除磁盘文件；仍有会话使用时服务端拒绝。 */
export async function removeWorkspace(id: string): Promise<void> {
  await api().removeWorkspace(id);
  await refreshWorkspaces();
}

/** 侧栏拖动排序：先本地生效，失败时恢复。 */
export async function reorderWorkspaces(ids: string[]): Promise<void> {
  const previous = useAppStore.getState().workspaces;
  const byId = new Map(previous.map((w) => [w.id, w]));
  const ordered = [
    ...ids.flatMap((id) => byId.get(id) ?? []),
    ...previous.filter((w) => !ids.includes(w.id)),
  ];
  set({ workspaces: ordered });
  try {
    const { items } = await api().reorderWorkspaces(ids);
    set({ workspaces: items });
  } catch (error) {
    set({ workspaces: previous });
    throw error;
  }
}

export function defaultProfile(
  state: Pick<AppState, "profiles"> = useAppStore.getState(),
): ModelProfile | undefined {
  return state.profiles.find((p) => p.isDefault) ?? state.profiles[0];
}

export function workspaceById(id: string | null | undefined): Workspace | undefined {
  return id ? useAppStore.getState().workspaces.find((w) => w.id === id) : undefined;
}

type AppEvent = { type: string } & Record<string, unknown>;
const appListeners = new Set<(event: AppEvent) => void>();

/** 订阅 app 主题事件（MCP 状态、文件变化、会话增删等），返回取消函数。 */
export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  appListeners.add(listener);
  return () => appListeners.delete(listener);
}

onSync((message) => {
  if (message.type !== "app.event") return;
  const event = message.data as AppEvent;
  if (event.type === "workspaces.changed") void refreshWorkspaces().catch(() => undefined);
  if (event.type === "profiles.changed") void refreshProfiles().catch(() => undefined);
  for (const listener of appListeners) listener(event);
});
