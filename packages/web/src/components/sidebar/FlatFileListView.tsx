// 列表视图：工作区全部文件平铺（虚拟滚动），本会话改动过的文件排在前面并带标记。

import type { FileEntry } from "@excelmanus/protocol";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AtSign, Check, Folder, FolderOpen } from "lucide-react";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { workspaceFileOpenHint } from "@/lib/file-kind";
import { type FileSort, sortFiles } from "@/lib/file-sorting";
import { dirName, normalizePath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import styles from "./FilePanel.module.css";
import { FileRowMenu } from "./FileRowMenu";
import { endFileDrag, mentionFiles, renameItem, startFileDrag } from "./file-actions";
import { InlineRenameInput } from "./InlineInputs";
import { SESSION_MARK_LABEL, type SessionFileMark } from "./session-file-marks";

export interface FlatFileListViewProps {
  scrollRef?: RefObject<HTMLDivElement | null>;
  files: FileEntry[];
  sort?: FileSort;
  marks: Map<string, SessionFileMark>;
  openPaths: Set<string>;
  selectMode: boolean;
  selectedPaths: Set<string>;
  onOpen: (entry: FileEntry, full?: boolean) => void;
  /** 拖动所选的多个文件时携带全部所选条目。 */
  dragEntries: (entry: FileEntry) => FileEntry[];
  onInfo: (entry: FileEntry) => void;
  emptyMessage?: string;
}

export function SessionMarkBadge({ mark }: { mark: SessionFileMark | undefined }) {
  if (!mark) return null;
  return (
    <span
      className={cn(
        "flex-shrink-0 rounded px-1 py-px text-[9px] font-medium leading-tight",
        mark === "created"
          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
          : "bg-amber-500/12 text-amber-800 dark:text-amber-300",
      )}
    >
      {mark === "created" ? "新建" : "已改"}
    </span>
  );
}

export function FlatFileListView(props: FlatFileListViewProps) {
  const {
    files,
    marks,
    openPaths,
    selectMode,
    selectedPaths,
    onOpen,
    dragEntries,
    onInfo,
    emptyMessage = "暂无文件，点击上方上传",
  } = props;
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  const sort = props.sort ?? "recent";
  const sortMarks = sort === "session" ? marks : undefined;
  const flatFiles = useMemo(() => sortFiles(files, sort, sortMarks), [files, sort, sortMarks]);

  const pinnedPath = menuPath ?? renaming ?? draggingPath;
  const pinnedIndex =
    pinnedPath === null ? -1 : flatFiles.findIndex((file) => file.path === pinnedPath);
  const estimatedRowSize = 64;
  const getItemKey = useCallback((index: number) => flatFiles[index]?.path ?? index, [flatFiles]);
  const virtualizer = useVirtualizer({
    count: flatFiles.length,
    getScrollElement: () => props.scrollRef?.current ?? null,
    getItemKey,
    estimateSize: () => estimatedRowSize,
    overscan: 5,
    enabled: !!props.scrollRef,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range);
      return pinnedIndex < 0
        ? indices
        : [...new Set([...indices, pinnedIndex])].sort((a, b) => a - b);
    },
  });
  // 测量完成前仅预绘可见区，避免侧栏展开时先挂载整份文件列表。
  const virtualRows = props.scrollRef ? virtualizer.getVirtualItems() : [];
  const fallbackCount = props.scrollRef
    ? Math.ceil(
        (props.scrollRef.current?.clientHeight ||
          (typeof window === "undefined" ? 768 : window.innerHeight)) / estimatedRowSize,
      ) + 10
    : flatFiles.length;
  const fallbackStart = props.scrollRef
    ? Math.max(
        0,
        Math.min(
          Math.floor((props.scrollRef.current?.scrollTop ?? 0) / estimatedRowSize) - 5,
          flatFiles.length - fallbackCount,
        ),
      )
    : 0;
  const fallbackIndices = virtualRows.length
    ? []
    : Array.from(
        { length: Math.max(0, Math.min(fallbackCount, flatFiles.length - fallbackStart)) },
        (_, i) => fallbackStart + i,
      );
  if (!virtualRows.length && pinnedIndex >= 0 && !fallbackIndices.includes(pinnedIndex))
    fallbackIndices.push(pinnedIndex);
  const rows =
    virtualRows.length > 0
      ? virtualRows
      : fallbackIndices.map((index) => ({
          key: flatFiles[index]?.path ?? index,
          index,
          start: index * estimatedRowSize,
        }));

  if (flatFiles.length === 0) {
    return (
      <div className={styles.empty}>
        <FolderOpen aria-hidden="true" />
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      style={
        props.scrollRef ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined
      }
    >
      {rows.map((row) => {
        const file = flatFiles[row.index];
        if (!file) return null;
        const isActive = openPaths.has(file.path);
        const isSelected = selectedPaths.has(file.path);
        const isRenaming = renaming === file.path;
        const mark = marks.get(normalizePath(file.path));
        const dirPart = dirName(file.path);

        return (
          <div
            key={row.key}
            data-index={row.index}
            className={styles.rowSlot}
            ref={props.scrollRef ? virtualizer.measureElement : undefined}
            style={
              props.scrollRef
                ? {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                  }
                : undefined
            }
          >
            <div
              draggable={(!selectMode || isSelected) && !isRenaming}
              onDragStart={(e) => {
                setDraggingPath(file.path);
                startFileDrag(e, dragEntries(file));
              }}
              onDragEnd={() => {
                setDraggingPath(null);
                endFileDrag();
              }}
              onClick={() => !isRenaming && onOpen(file)}
              onDoubleClick={() => !selectMode && !isRenaming && onOpen(file, true)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(file);
                }
                if (event.key === "F2" && !selectMode) setRenaming(file.path);
              }}
              role={selectMode ? "checkbox" : "button"}
              aria-checked={selectMode ? isSelected : undefined}
              aria-label={selectMode ? `选择 ${file.name}` : `打开 ${file.name}`}
              tabIndex={0}
              data-active={isActive}
              data-selected={isSelected}
              data-dragging={draggingPath === file.path}
              className={cn("em-file-row group relative", styles.fileRow)}
              title={selectMode ? undefined : `${workspaceFileOpenHint(file.name)}\n${file.path}`}
            >
              {selectMode && (
                <span className={styles.checkbox} data-checked={isSelected} aria-hidden="true">
                  {isSelected && <Check />}
                </span>
              )}
              <span className={styles.fileIcon} aria-hidden="true">
                <FileTypeIcon filename={file.name} />
              </span>

              <div className={styles.fileInfo}>
                {isRenaming ? (
                  <InlineRenameInput
                    defaultValue={file.name}
                    onConfirm={(name) => {
                      setRenaming(null);
                      void renameItem(file.path, name);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className={styles.fileName}>
                    <span>{file.name}</span>
                    {isActive && <span className={styles.openDot} aria-label="已在工作台打开" />}
                    {mark && (
                      <span aria-label={SESSION_MARK_LABEL[mark]}>
                        <SessionMarkBadge mark={mark} />
                      </span>
                    )}
                  </span>
                )}
                {dirPart && (
                  <span className={styles.filePath}>
                    <Folder aria-hidden="true" />
                    <span>{dirPart}</span>
                  </span>
                )}
              </div>

              {!selectMode && !isRenaming && (
                <>
                  <button
                    type="button"
                    aria-label={`引用 ${file.name} 到输入框`}
                    className="touch-show flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--em-primary-alpha-10)] hover:text-[var(--em-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      mentionFiles([file]);
                    }}
                  >
                    <AtSign className="h-3.5 w-3.5" />
                  </button>
                  <FileRowMenu
                    entry={file}
                    pinned={isActive}
                    onRename={() => setRenaming(file.path)}
                    onInfo={() => onInfo(file)}
                    onOpenChange={(open) => setMenuPath(open ? file.path : null)}
                  />
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
