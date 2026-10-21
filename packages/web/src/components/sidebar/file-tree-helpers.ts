// 文件面板的纯函数：系统文件过滤、排序、拖放移动目标与扁平列表。
// 数据来自 files-store（按目录懒加载的 FileEntry）。

import type { FileEntry } from "@excelmanus/protocol";
import { createDateLabels } from "@/lib/date-labels";
import { compareFileNames } from "@/lib/file-sorting";
import { dirName, fileName, joinPath, normalizePath } from "@/lib/paths";

/** 默认隐藏的目录名（任意层级的第一段）。 */
const SYSTEM_DIR_NAMES = new Set(["__pycache__", "node_modules", ".git", ".excelmanus"]);

/** 默认隐藏的文件扩展名。 */
const SYSTEM_EXTENSIONS = [".pyc", ".pyo", ".log", ".db", ".db-shm", ".db-wal", ".ds_store"];

/** 系统/内部文件：点开头的条目、缓存目录、日志与数据库等，默认不显示。 */
export function isSystemEntry(entry: Pick<FileEntry, "path" | "kind">): boolean {
  const parts = normalizePath(entry.path).split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith(".") || SYSTEM_DIR_NAMES.has(part.toLowerCase())))
    return true;
  if (entry.kind === "dir") return false;
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name.startsWith("~$")) return true; // Office 锁文件
  return SYSTEM_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 先文件夹后文件，各自按名称自然排序。 */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return compareFileNames(a.name, b.name);
  });
}

/** 已加载目录里的全部文件（扁平列表与搜索用）。 */
export function flattenFiles(dirs: Record<string, FileEntry[]>, showSystem: boolean): FileEntry[] {
  const seen = new Map<string, FileEntry>();
  for (const items of Object.values(dirs)) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      if (!showSystem && isSystemEntry(item)) continue;
      seen.set(item.path, item);
    }
  }
  return [...seen.values()];
}

/** 拖放移动：把 source 放进 folder（"" 为根目录）后的新路径；无效移动返回 null。 */
export function moveTarget(source: string, folder: string): string | null {
  const from = normalizePath(source);
  const into = normalizePath(folder);
  if (!from) return null;
  if (dirName(from) === into) return null;
  if (into === from || into.startsWith(`${from}/`)) return null;
  return joinPath(into, fileName(from));
}

/** 重命名：同目录下的新路径；名称无效（空、含分隔符）返回 null。 */
export function renameTarget(path: string, name: string): string | null {
  const next = name.trim();
  if (!next || /[\\/]/.test(next) || next === "." || next === "..") return null;
  const target = joinPath(dirName(path), next);
  return target === normalizePath(path) ? null : target;
}

/** 路径是否在某个条目之内（条目本身或其子孙）。 */
export function isWithin(path: string, entry: string): boolean {
  const p = normalizePath(path);
  const e = normalizePath(entry);
  return p === e || p.startsWith(`${e}/`);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Share one date formatter within a rendered record list, preserving the file-time fallback. */
export function createFileTimeFormatter() {
  const format = createDateLabels({
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (iso: string | undefined) => (iso ? format(iso) : "-");
}
