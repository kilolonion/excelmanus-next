import type { FileEntry } from "@excelmanus/protocol";
import { useMemo } from "react";
import { flattenFiles, isSystemEntry } from "./file-tree-helpers";

export function useFileListing(
  dirs: Record<string, FileEntry[]>,
  showSystem: boolean,
  query: string,
) {
  const allFiles = useMemo(() => flattenFiles(dirs, true), [dirs]);
  const userFiles = useMemo(() => allFiles.filter((file) => !isSystemEntry(file)), [allFiles]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: discard normalized paths when directory contents change
  const searchPaths = useMemo(() => new Map<FileEntry, string>(), [allFiles]);
  const visibleFiles = useMemo(() => {
    const files = showSystem ? allFiles : userFiles;
    const q = query.trim().toLocaleLowerCase();
    return q
      ? files.filter((file) => {
          let path = searchPaths.get(file);
          if (path === undefined) {
            path = file.path.toLocaleLowerCase();
            searchPaths.set(file, path);
          }
          return path.includes(q);
        })
      : files;
  }, [allFiles, userFiles, searchPaths, showSystem, query]);
  const hiddenCount = allFiles.length - userFiles.length;
  return { allFiles, visibleFiles, hiddenCount };
}
