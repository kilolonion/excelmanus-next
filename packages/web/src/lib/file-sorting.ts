import type { FileEntry } from "@excelmanus/protocol";
import { normalizePath } from "./paths";
export const FILE_SORTS = {
  recent: "最近使用",
  modified: "最近修改",
  name: "文件名称",
  session: "本对话改动",
} as const;
export type FileSort = keyof typeof FILE_SORTS;
const KEY = "excelmanus.files-sort";
export function readFileSort(): FileSort {
  try {
    const v = localStorage.getItem(KEY);
    return v && Object.hasOwn(FILE_SORTS, v) ? (v as FileSort) : "recent";
  } catch {
    return "recent";
  }
}
export function saveFileSort(sort: FileSort): void {
  try {
    localStorage.setItem(KEY, sort);
  } catch {
    /* storage optional */
  }
}
const timestamp = (value?: string) => {
  const n = Date.parse(value ?? "");
  return Number.isFinite(n) ? n : 0;
};
/** Same natural Chinese ordering for flat lists and tree entries. */
export const compareFileNames = new Intl.Collator("zh-CN", { numeric: true }).compare;
/** Recent use never lets modification timestamps or conversation marks override openedAt. */
export function sortFiles(
  files: FileEntry[],
  sort: FileSort,
  marks?: ReadonlyMap<string, unknown>,
): FileEntry[] {
  return files
    .map((file) => ({
      file,
      marked: sort === "session" && marks?.has(normalizePath(file.path)) ? 1 : 0,
      time:
        file.kind !== "dir" && sort !== "name"
          ? timestamp(sort === "recent" ? file.openedAt : file.modifiedAt)
          : 0,
    }))
    .sort((a, b) => {
      if (a.file.kind !== b.file.kind) return a.file.kind === "dir" ? -1 : 1;
      if (a.file.kind !== "dir") {
        const markDelta = b.marked - a.marked;
        if (markDelta) return markDelta;
        const timeDelta = b.time - a.time;
        if (timeDelta) return timeDelta;
      }
      return compareFileNames(a.file.name, b.file.name) || a.file.path.localeCompare(b.file.path);
    })
    .map(({ file }) => file);
}
