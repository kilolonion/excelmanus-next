// 文件面板的动作：上传、重命名/移动、删除（进回收站，需确认）、引用到输入框、拖动，以及备份的另存/替换/删除。
// 列表与树共用；结果用 toast 告知，表格标签随文件移动或删除同步。

import type { BackupEntry, FileEntry } from "@excelmanus/protocol";
import { WORKSPACE_FILE_MIME } from "@/components/chat/chat-drop";
import { formatFileMention } from "@/components/chat/chat-input-insert";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage, saveBlob } from "@/lib/backend/api";
import { fileName } from "@/lib/paths";
import { attachWorkspaceFile } from "@/stores/chat-store";
import {
  deleteEntries,
  moveEntries,
  moveEntry,
  uploadFiles,
  useFilesStore,
} from "@/stores/files-store";
import { useSessionStore } from "@/stores/session-store";
import { closeTab, relocateWorkbook, useWorkbookStore } from "@/stores/workbook-store";
import { isWithin, moveTarget, renameTarget } from "./file-tree-helpers";

// ---------- 拖动 ----------

/** 正在从文件面板拖动的条目（dragover 阶段读不到 dataTransfer 内容）。 */
let dragging: string[] = [];

export function draggingPaths(): string[] {
  return dragging;
}

/** 拖到输入框 = 引用；拖到文件夹 = 移动。 */
export function startFileDrag(event: React.DragEvent, entries: FileEntry[]): void {
  dragging = entries.map((e) => e.path);
  const files = entries.filter((e) => e.kind === "file");
  event.dataTransfer.setData(
    "text/plain",
    files.map((f) => formatFileMention({ path: f.path })).join(" "),
  );
  if (files.length > 0)
    event.dataTransfer.setData(
      WORKSPACE_FILE_MIME,
      JSON.stringify(files.map((f) => ({ path: f.path, filename: f.name }))),
    );
  event.dataTransfer.effectAllowed = "copyMove";
}

export function endFileDrag(): void {
  dragging = [];
}

/** 当前拖动的条目能否放进 folder。 */
export function canDropInto(folder: string): boolean {
  return dragging.length > 0 && dragging.some((path) => moveTarget(path, folder) !== null);
}

// ---------- 表格标签同步 ----------

function openTabsWithin(path: string): string[] {
  return useWorkbookStore
    .getState()
    .tabs.map((t) => t.path)
    .filter((p) => isWithin(p, path));
}

async function followMove(from: string, to: string, workspace: string | null): Promise<void> {
  if (workspace && useWorkbookStore.getState().workspaceId === workspace)
    relocateWorkbook(from, to);
}

// ---------- 文件操作 ----------

export async function uploadInto(files: File[], directory = ""): Promise<string[]> {
  if (files.length === 0) return [];
  const targetWorkspaceId =
    useFilesStore.getState().workspaceId ?? useSessionStore.getState().activeWorkspaceId;
  if (!targetWorkspaceId) {
    toast({ tone: "error", title: "无法上传文件", description: "没有可用的工作区" });
    return [];
  }
  const uploaded: string[] = [];
  let failed = 0;
  let lastError: unknown = null;
  for (const file of files) {
    try {
      uploaded.push(...(await uploadFiles([file], directory, targetWorkspaceId)));
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  }
  if (failed > 0)
    toast({
      tone: "error",
      title: `${failed} 个文件上传失败`,
      description: errorMessage(lastError, "请重试"),
    });
  else
    toast({
      tone: "success",
      title:
        uploaded.length === 1
          ? `已上传 ${fileName(uploaded[0] ?? "")}`
          : `已上传 ${uploaded.length} 个文件`,
    });
  return uploaded;
}

export async function moveInto(paths: string[], folder: string): Promise<void> {
  const workspace = useFilesStore.getState().workspaceId ?? workspaceId();
  const moves = paths.flatMap((path) => {
    const to = moveTarget(path, folder);
    return to ? [{ path, to }] : [];
  });
  try {
    if (moves.length) await moveEntries(moves);
    for (const { path, to } of moves) await followMove(path, to, workspace);
  } catch (error) {
    toast({ tone: "error", title: "整批移动未完成", description: errorMessage(error) });
    return;
  }
  if (moves.length > 0)
    toast({
      tone: "success",
      title: moves.length === 1 ? `已移动到 ${folder || "根目录"}` : `已移动 ${moves.length} 项`,
    });
}

/** 重命名；返回是否成功。 */
export async function renameItem(path: string, name: string): Promise<boolean> {
  const workspace = useFilesStore.getState().workspaceId ?? workspaceId();
  const to = renameTarget(path, name);
  if (!to) {
    if (name.trim() && name.trim() !== fileName(path))
      toast({ tone: "error", title: "名称不能包含 / 或 \\" });
    return false;
  }
  try {
    await moveEntry(path, to);
    await followMove(path, to, workspace);
    return true;
  } catch (error) {
    toast({ tone: "error", title: "重命名失败", description: errorMessage(error) });
    return false;
  }
}

/** 删除（移入回收站）：先确认；返回是否已删除。 */
export async function deleteWithConfirm(
  entries: Pick<FileEntry, "path" | "kind">[],
): Promise<boolean> {
  if (entries.length === 0) return false;
  const one = entries.length === 1 ? entries[0] : undefined;
  const ok = await confirmAction({
    title: one ? `删除「${fileName(one.path)}」？` : `删除所选 ${entries.length} 项？`,
    description:
      one?.kind === "dir"
        ? "文件夹及其中的全部内容将移入回收站，可在 设置 → 工作区 中恢复。"
        : "将移入回收站，可在 设置 → 工作区 中恢复。",
    confirmLabel: "移入回收站",
    tone: "danger",
  });
  if (!ok) return false;
  const paths = entries.map((e) => e.path);
  try {
    await deleteEntries(paths);
  } catch (error) {
    toast({ tone: "error", title: "删除失败", description: errorMessage(error) });
    return false;
  }
  for (const path of paths)
    for (const tab of openTabsWithin(path)) await closeTab(tab).catch(() => undefined);
  toast({
    tone: "success",
    title: one ? `已将「${fileName(one.path)}」移入回收站` : `已将 ${paths.length} 项移入回收站`,
  });
  return true;
}

/** 以 @路径 引用到输入框（不重复上传）。 */
export function mentionFiles(entries: FileEntry[]): void {
  const files = entries.filter((e) => e.kind === "file");
  for (const file of files) attachWorkspaceFile(file.path, file.size ?? 0);
  if (files.length > 1) toast({ title: `已引用 ${files.length} 个文件` });
}

// ---------- 备份 ----------

function workspaceId(): string | null {
  return useSessionStore.getState().activeWorkspaceId;
}

export async function listFileBackups(): Promise<BackupEntry[]> {
  const id = workspaceId();
  if (!id) return [];
  const { items } = await api().listBackups(id, "backups");
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveBackupAs(entry: BackupEntry): Promise<void> {
  const id = workspaceId();
  if (!id) return;
  try {
    const blob = await api().downloadBackup(id, "backups", entry.id);
    saveBlob(blob, fileName(entry.originalPath));
  } catch (error) {
    toast({ tone: "error", title: "下载备份失败", description: errorMessage(error) });
  }
}

/** 用备份替换回原文件：覆盖当前内容，必须确认。返回是否已替换。 */
export async function restoreBackupWithConfirm(entry: BackupEntry): Promise<boolean> {
  const id = workspaceId();
  if (!id) return false;
  const ok = await confirmAction({
    title: `用备份替换「${fileName(entry.originalPath)}」？`,
    description: `当前文件会被 ${new Date(entry.createdAt).toLocaleString("zh-CN")} 的备份覆盖；替换前的内容会另存一份备份。`,
    confirmLabel: "替换回原文件",
    tone: "danger",
  });
  if (!ok) return false;
  try {
    const res = await api().restoreBackup(id, "backups", entry.id);
    for (const tab of openTabsWithin(res.path)) await closeTab(tab).catch(() => undefined);
    toast({ tone: "success", title: `已恢复 ${fileName(res.path)}` });
    return true;
  } catch (error) {
    toast({ tone: "error", title: "恢复失败", description: errorMessage(error) });
    return false;
  }
}

export async function deleteBackupWithConfirm(entry: BackupEntry): Promise<boolean> {
  const id = workspaceId();
  if (!id) return false;
  const ok = await confirmAction({
    title: "删除这份备份？",
    description: `「${fileName(entry.originalPath)}」的这份备份将被永久删除，无法恢复。`,
    confirmLabel: "永久删除",
    tone: "danger",
  });
  if (!ok) return false;
  try {
    await api().deleteBackup(id, "backups", entry.id);
    return true;
  } catch (error) {
    toast({ tone: "error", title: "删除备份失败", description: errorMessage(error) });
    return false;
  }
}
