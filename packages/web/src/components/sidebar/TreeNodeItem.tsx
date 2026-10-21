// 文件夹视图的一行：文件夹按需加载子目录（files-store），可拖入文件移动、拖入本机文件上传。

import type { FileEntry } from "@excelmanus/protocol";
import {
  AtSign,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  Loader2,
  Square,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { isSpreadsheetFile, workspaceFileOpenHint } from "@/lib/file-kind";
import { type FileSort, sortFiles } from "@/lib/file-sorting";
import { openWorkspaceFile } from "@/lib/open-file";
import { joinPath, normalizePath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import {
  createEmptyFile,
  createFolder,
  loadDir,
  toggleDir,
  useFilesStore,
} from "@/stores/files-store";
import { FileRowMenu } from "./FileRowMenu";
import { SessionMarkBadge } from "./FlatFileListView";
import {
  canDropInto,
  draggingPaths,
  endFileDrag,
  mentionFiles,
  moveInto,
  renameItem,
  startFileDrag,
  uploadInto,
} from "./file-actions";
import { isSystemEntry } from "./file-tree-helpers";
import { InlineCreateInput, InlineRenameInput } from "./InlineInputs";
import type { SessionFileMark } from "./session-file-marks";

export interface TreeContext {
  marks: Map<string, SessionFileMark>;
  openPaths: Set<string>;
  selectMode: boolean;
  selectedPaths: Set<string>;
  showSystem: boolean;
  sort?: FileSort;
  onOpen: (entry: FileEntry, full?: boolean) => void;
  dragEntries: (entry: FileEntry) => FileEntry[];
  onInfo: (entry: FileEntry) => void;
  onUploadTo: (folder: string) => void;
}

/** 拖放到文件夹（或根目录）：面板内拖动 = 移动，本机文件 = 上传到该文件夹。 */
export function useFolderDrop(folder: string, onDropped?: () => void) {
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) =>
    canDropInto(folder) || Array.from(e.dataTransfer.types).includes("Files");
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = draggingPaths().length > 0 ? "move" : "copy";
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const paths = draggingPaths();
        const files = Array.from(e.dataTransfer.files ?? []);
        if (paths.length === 0 && files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        endFileDrag();
        if (paths.length > 0) void moveInto(paths, folder);
        else void uploadInto(files, folder);
        onDropped?.();
      },
    },
  };
}

export function TreeNodeItem({
  entry,
  depth,
  ctx,
}: {
  entry: FileEntry;
  depth: number;
  ctx: TreeContext;
}) {
  return entry.kind === "dir" ? (
    <FolderNode entry={entry} depth={depth} ctx={ctx} />
  ) : (
    <FileNode entry={entry} depth={depth} ctx={ctx} />
  );
}

export type CreateKind = "folder" | "file";

/** 目录内容（根目录与展开的文件夹共用）。 */
export function DirChildren({
  path,
  depth,
  ctx,
  creating,
  onCreated,
}: {
  path: string;
  depth: number;
  ctx: TreeContext;
  /** 正在这个目录里新建：文件夹或空文件。 */
  creating?: CreateKind | null;
  onCreated?: () => void;
}) {
  const items = useFilesStore((s) => s.dirs[path]);
  const loading = useFilesStore((s) => s.loading[path] ?? false);
  const error = useFilesStore((s) => s.errors[path]);
  const [visible, setVisible] = useState(100);
  const sort = ctx.sort ?? "recent";
  const sortMarks = sort === "session" ? ctx.marks : undefined;
  const showSystem = ctx.showSystem;
  const listed = useMemo(
    () => (items ?? []).filter((entry) => showSystem || !isSystemEntry(entry)),
    [items, showSystem],
  );
  const entries = useMemo(() => sortFiles(listed, sort, sortMarks), [listed, sort, sortMarks]);
  const indent = depth * 12 + 4 + 16;

  const create = async (name: string) => {
    const kind = creating;
    const workspaceId = useFilesStore.getState().workspaceId;
    onCreated?.();
    try {
      if (kind === "file") {
        const created = await createEmptyFile(joinPath(path, name.trim()));
        if (useFilesStore.getState().workspaceId !== workspaceId) return;
        if (path) toggleDir(path, true);
        if (isSpreadsheetFile(created)) openWorkspaceFile(created);
      } else {
        await createFolder(joinPath(path, name.trim()));
        if (useFilesStore.getState().workspaceId !== workspaceId) return;
        if (path) toggleDir(path, true);
      }
    } catch (err) {
      toast({
        tone: "error",
        title: kind === "file" ? "新建文件失败" : "新建文件夹失败",
        description: errorMessage(err),
      });
    }
  };

  return (
    <div>
      {creating && (
        <div className="flex items-center gap-1.5 py-1.5" style={{ paddingLeft: `${indent}px` }}>
          {creating === "file" ? (
            <FilePlus2 className="h-4 w-4 flex-shrink-0 text-[var(--em-primary-light)]" />
          ) : (
            <Folder className="h-4.5 w-4.5 flex-shrink-0 text-[var(--em-primary-light)]" />
          )}
          <InlineCreateInput
            placeholder={
              creating === "file" ? "文件名（默认 .xlsx，可写 .csv / .md / .txt）" : "文件夹名称"
            }
            onConfirm={(name) => void create(name)}
            onCancel={() => onCreated?.()}
          />
        </div>
      )}
      {!items && loading && (
        <div
          className="flex items-center gap-1.5 py-1.5 text-[11px] text-muted-foreground"
          style={{ paddingLeft: `${indent}px` }}
        >
          <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
        </div>
      )}
      {error && !loading && (
        <div
          role="alert"
          className="py-1.5 text-[11px] text-destructive"
          style={{ paddingLeft: `${indent}px` }}
        >
          <span>{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-1 h-6 px-2 text-xs"
            onClick={() => void loadDir(path, true)}
          >
            重试
          </Button>
        </div>
      )}
      {items && entries.length === 0 && depth > 0 && !creating && (
        <div
          className="py-1.5 text-[11px] text-muted-foreground/60"
          style={{ paddingLeft: `${indent}px` }}
        >
          空文件夹
        </div>
      )}
      {entries.slice(0, visible).map((child) => (
        <TreeNodeItem key={child.path} entry={child} depth={depth} ctx={ctx} />
      ))}
      {entries.length > visible && (
        <button
          type="button"
          className="w-full p-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setVisible((count) => count + 100)}
        >
          显示更多（剩余 {entries.length - visible} 项）
        </button>
      )}
    </div>
  );
}

function FolderNode({ entry, depth, ctx }: { entry: FileEntry; depth: number; ctx: TreeContext }) {
  const expanded = useFilesStore((s) => s.expanded.includes(entry.path));
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const drop = useFolderDrop(entry.path, () => toggleDir(entry.path, true));
  const indent = depth * 12;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-lg py-1.5 pr-1 text-[13px] text-muted-foreground transition-colors duration-100 hover:text-foreground",
          drop.over
            ? "bg-[var(--em-primary-alpha-15)] ring-1 ring-[var(--em-primary)]"
            : "hover:bg-accent/30",
        )}
        style={{ paddingLeft: `${indent + 4}px` }}
        draggable={!ctx.selectMode && !renaming}
        onDragStart={(e) => startFileDrag(e, [entry])}
        onDragEnd={endFileDrag}
        {...drop.handlers}
      >
        <button
          type="button"
          onClick={() => toggleDir(entry.path)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="h-4.5 w-4.5 flex-shrink-0 text-[var(--em-primary-light)]" />
          ) : (
            <Folder className="h-4.5 w-4.5 flex-shrink-0 text-[var(--em-primary-light)]" />
          )}
          {renaming ? (
            <InlineRenameInput
              defaultValue={entry.name}
              onConfirm={(name) => {
                setRenaming(false);
                void renameItem(entry.path, name);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span className="truncate">{entry.name}</span>
          )}
        </button>
        {!ctx.selectMode && !renaming && (
          <FileRowMenu
            entry={entry}
            onRename={() => setRenaming(true)}
            onCreateFolder={() => {
              setCreating("folder");
              toggleDir(entry.path, true);
            }}
            onCreateFile={() => {
              setCreating("file");
              toggleDir(entry.path, true);
            }}
            onUploadHere={() => ctx.onUploadTo(entry.path)}
          />
        )}
      </div>
      {expanded && (
        <DirChildren
          path={entry.path}
          depth={depth + 1}
          ctx={ctx}
          creating={creating}
          onCreated={() => setCreating(null)}
        />
      )}
    </div>
  );
}

function FileNode({ entry, depth, ctx }: { entry: FileEntry; depth: number; ctx: TreeContext }) {
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const isSelected = ctx.selectedPaths.has(entry.path);
  const isActive = ctx.openPaths.has(entry.path);
  const mark = ctx.marks.get(normalizePath(entry.path));
  const indent = depth * 12;

  return (
    <div
      draggable={(!ctx.selectMode || isSelected) && !renaming}
      onDragStart={(e) => {
        setDragging(true);
        startFileDrag(e, ctx.dragEntries(entry));
      }}
      onDragEnd={() => {
        setDragging(false);
        endFileDrag();
      }}
      onClick={() => !renaming && ctx.onOpen(entry)}
      onDoubleClick={() => !ctx.selectMode && !renaming && ctx.onOpen(entry, true)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          ctx.onOpen(entry);
        }
        if (event.key === "F2" && !ctx.selectMode) setRenaming(true);
      }}
      role={ctx.selectMode ? "checkbox" : "button"}
      aria-checked={ctx.selectMode ? isSelected : undefined}
      tabIndex={0}
      className={cn(
        "em-file-row group relative flex cursor-pointer items-center gap-2.5 rounded-lg py-2 pr-1 text-[13px] transition-colors duration-100",
        isSelected ? "bg-accent/80" : isActive ? "bg-accent/60" : "hover:bg-accent/40",
        dragging && "scale-[0.98] opacity-70",
      )}
      style={{ paddingLeft: `${indent + 4 + 16}px` }}
      title={ctx.selectMode ? undefined : `${workspaceFileOpenHint(entry.name)}\n${entry.path}`}
    >
      {ctx.selectMode ? (
        isSelected ? (
          <CheckSquare
            className="h-4.5 w-4.5 flex-shrink-0"
            style={{ color: "var(--em-primary)" }}
          />
        ) : (
          <Square className="h-4.5 w-4.5 flex-shrink-0 text-muted-foreground/50" />
        )
      ) : (
        <FileTypeIcon filename={entry.name} className="h-4.5 w-4.5 flex-shrink-0" />
      )}

      {renaming ? (
        <InlineRenameInput
          defaultValue={entry.name}
          onConfirm={(name) => {
            setRenaming(false);
            void renameItem(entry.path, name);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate leading-snug",
            isActive ? "font-medium text-foreground" : "text-foreground/80",
          )}
        >
          {entry.name}
        </span>
      )}
      <SessionMarkBadge mark={mark} />

      {!ctx.selectMode && !renaming && (
        <>
          <button
            type="button"
            aria-label={`引用 ${entry.name} 到输入框`}
            className="touch-show flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--em-primary-alpha-10)] hover:text-[var(--em-primary)] group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              mentionFiles([entry]);
            }}
          >
            <AtSign className="h-3.5 w-3.5" />
          </button>
          <FileRowMenu
            entry={entry}
            pinned={isActive}
            onRename={() => setRenaming(true)}
            onInfo={() => ctx.onInfo(entry)}
          />
        </>
      )}
    </div>
  );
}
