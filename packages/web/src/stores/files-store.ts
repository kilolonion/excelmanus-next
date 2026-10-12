// 当前工作区的文件树：按目录懒加载（GET /workspaces/{id}/files?path=），收到 files.changed 后刷新已加载目录。
// 文件管理统一走 POST /files/manage（删除进回收站，需要界面显式确认）。

import type { FileEntry } from "@excelmanus/protocol";
import { create } from "zustand";
import { api, errorMessage, saveBlob } from "@/lib/backend/api";
import { onAppEvent } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

interface FilesState {
  workspaceId: string | null;
  /** 目录相对路径（根为 ""）→ 条目。 */
  dirs: Record<string, FileEntry[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  expanded: string[];
  /** 任一目录内容变化时递增，供依赖文件列表的组件刷新。 */
  version: number;
}

export const useFilesStore = create<FilesState>()(() => ({
  workspaceId: null,
  dirs: {},
  loading: {},
  errors: {},
  expanded: [],
  version: 0,
}));

const set = useFilesStore.setState;
const get = useFilesStore.getState;

function requireWorkspace(): string {
  const id = get().workspaceId ?? useSessionStore.getState().activeWorkspaceId;
  if (!id) throw new Error("没有可用的工作区");
  return id;
}

export async function loadDir(path = ""): Promise<FileEntry[]> {
  const workspaceId = requireWorkspace();
  set((s) => ({ loading: { ...s.loading, [path]: true } }));
  try {
    const res = await api().listFiles(workspaceId, path);
    if (get().workspaceId !== workspaceId) return [];
    set((s) => {
      const errors = { ...s.errors };
      delete errors[path];
      return {
        dirs: { ...s.dirs, [path]: res.items },
        loading: { ...s.loading, [path]: false },
        errors,
        version: s.version + 1,
      };
    });
    return res.items;
  } catch (error) {
    set((s) => ({
      loading: { ...s.loading, [path]: false },
      errors: { ...s.errors, [path]: errorMessage(error, "文件列表加载失败") },
    }));
    return [];
  }
}

/** 刷新所有已加载过的目录（文件变化通知或用户手动刷新）。 */
export async function refreshFiles(): Promise<void> {
  const loaded = Object.keys(get().dirs);
  await Promise.all((loaded.length > 0 ? loaded : [""]).map((p) => loadDir(p)));
}

export function toggleDir(path: string, open?: boolean): void {
  const isOpen = get().expanded.includes(path);
  const next = open ?? !isOpen;
  set((s) => ({
    expanded: next ? [...new Set([...s.expanded, path])] : s.expanded.filter((p) => p !== path),
  }));
  if (next && !get().dirs[path]) void loadDir(path);
}

/** 有限深度的广度遍历，供 @ 提及与"打开工作簿"对话框使用。 */
export async function listAllFiles(limit = 2000, maxDepth = 6): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const next = queue.shift();
    if (!next) break;
    const items = get().dirs[next.path] ?? (await loadDir(next.path));
    for (const item of items) {
      if (item.kind === "dir") {
        if (next.depth + 1 < maxDepth) queue.push({ path: item.path, depth: next.depth + 1 });
      } else {
        out.push(item);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export async function uploadFiles(files: File[], directory = ""): Promise<string[]> {
  const workspaceId = requireWorkspace();
  const paths: string[] = [];
  for (const file of files) {
    const res = await api().uploadFile(workspaceId, {
      name: file.name,
      data: file,
      ...(directory ? { path: directory } : {}),
    });
    paths.push(res.path);
  }
  await loadDir(directory);
  return paths;
}

async function manage(
  ops: Parameters<ReturnType<typeof api>["manageFiles"]>[1]["ops"],
  confirmed = false,
): Promise<string[]> {
  const res = await api().manageFiles(requireWorkspace(), {
    ops,
    ...(confirmed ? { confirmed: true } : {}),
  });
  await refreshFiles();
  return res.paths;
}

export const createFolder = (path: string) => manage([{ op: "mkdir", path }]);

/** 新建空文件（.xlsx/.csv/.txt/.md）；没写扩展名时按 .xlsx 处理。返回实际路径。 */
export async function createEmptyFile(path: string): Promise<string> {
  const target = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.xlsx`;
  const res = await api().createFile(requireWorkspace(), target);
  await refreshFiles();
  return res.path;
}
export const moveEntry = (path: string, to: string) => manage([{ op: "move", path, to }]);
export const copyEntry = (path: string, to: string) => manage([{ op: "copy", path, to }]);
/** 删除进回收站（可在设置 → 工作区与备份里恢复）。 */
export const deleteEntries = (paths: string[]) =>
  manage(
    paths.map((path) => ({ op: "delete" as const, path })),
    true,
  );
export const backupEntry = (path: string) => manage([{ op: "backup", path }]);

export async function downloadWorkspaceFile(path: string): Promise<void> {
  const blob = await api().downloadFile(requireWorkspace(), path);
  saveBlob(blob, path.split("/").pop() || "download");
}

export async function fetchWorkspaceFile(path: string): Promise<Blob> {
  return api().downloadFile(requireWorkspace(), path);
}

useSessionStore.subscribe((state, prev) => {
  if (state.activeWorkspaceId === prev.activeWorkspaceId) return;
  set({
    workspaceId: state.activeWorkspaceId,
    dirs: {},
    loading: {},
    errors: {},
    expanded: [],
    version: get().version + 1,
  });
  if (state.activeWorkspaceId) void loadDir("");
});

onAppEvent((event) => {
  if (event.type !== "files.changed") return;
  if (event.workspaceId && event.workspaceId !== get().workspaceId) return;
  void refreshFiles();
});
