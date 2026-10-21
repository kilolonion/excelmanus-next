// 侧栏「文件」页（02 §6）：工作区切换器、当前工作区文件（列表 / 文件夹两种视图）、
// 上传、新建文件夹、重命名、拖放移动、删除进回收站、本会话改动标记，以及修改前备份分组。

import type { BackupEntry, FileEntry } from "@excelmanus/protocol";
import {
  AtSign,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus2,
  FolderPlus,
  FolderTree,
  History,
  List,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/backend/api";
import { WORKSPACE_FILE_INPUT_ACCEPT } from "@/lib/file-kind";
import { FILE_SORTS, type FileSort, readFileSort, saveFileSort } from "@/lib/file-sorting";
import { openWorkspaceFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { listAllFiles, loadDir, refreshFiles, useFilesStore } from "@/stores/files-store";
import { openWorkspace, sessionError, useSessionStore } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkbookStore } from "@/stores/workbook-store";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";
import { BackupRow, FileInfoDialog } from "./FileInfoDialog";
import styles from "./FilePanel.module.css";
import { FlatFileListView } from "./FlatFileListView";
import { deleteWithConfirm, listFileBackups, mentionFiles, uploadInto } from "./file-actions";
import { useSessionFileMarks } from "./session-file-marks";
import { type CreateKind, DirChildren, type TreeContext, useFolderDrop } from "./TreeNodeItem";
import { useFileListing } from "./use-file-listing";

const VIEW_KEY = "excelmanus.files-view";

function readView(): "list" | "tree" {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/* ── 工作区切换器 ── */

function WorkspaceSwitcher() {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeId = useSessionStore((s) => s.activeWorkspaceId);
  const sessions = useSessionStore((s) => s.sessions);
  const [adding, setAdding] = useState(false);
  const active = workspaces.find((w) => w.id === activeId);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) m.set(s.workspaceId, (m.get(s.workspaceId) ?? 0) + 1);
    return m;
  }, [sessions]);

  const switchTo = (id: string) => {
    if (id === activeId) return;
    void openWorkspace(id).catch((error) =>
      toast({ tone: "error", title: "无法打开工作区", description: sessionError(error) }),
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-[10px] border border-[var(--em-line)] bg-[var(--em-panel)] px-2.5 py-2 text-left transition-colors hover:border-[var(--em-primary-alpha-30)]"
            aria-label="切换工作区"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <span className="truncate">{active?.name ?? "未选择工作区"}</span>
                {active?.isDefault && (
                  <Star
                    className="h-3 w-3 flex-shrink-0 fill-current text-[var(--em-primary)]"
                    aria-label="默认工作区"
                  />
                )}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {active?.path ?? "选择或添加一个文件夹"}
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          className="w-[min(18rem,calc(100vw-2rem))]"
        >
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            工作区
          </DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => switchTo(w.id)} className="items-start">
              <span className="mt-0.5 w-4 flex-shrink-0">
                {w.id === activeId && <Check className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{w.name}</span>
                  {w.isDefault && (
                    <span className="rounded bg-[var(--em-primary-alpha-10)] px-1 text-[9px] text-[var(--em-primary)]">
                      默认
                    </span>
                  )}
                  <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground">
                    {counts.get(w.id) ?? 0} 个会话
                  </span>
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {w.path}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <FolderPlus className="h-4 w-4" />
            添加文件夹
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => useUIStore.getState().openSettings("workspace")}>
            <Settings2 className="h-4 w-4" />
            管理工作区
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddWorkspaceDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(workspace) => {
          if (workspace) switchTo(workspace.id);
        }}
      />
    </>
  );
}

/* ── 备份分组 ── */

function BackupsSection() {
  const workspaceId = useSessionStore((s) => s.activeWorkspaceId);
  const version = useFilesStore((s) => s.version);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BackupEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listFileBackups());
    } catch (err) {
      setError(errorMessage(err, "备份列表加载失败"));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 工作区或文件变化时重新读取
  useEffect(() => {
    if (open) void load();
  }, [open, load, workspaceId, version]);

  return (
    <div className="flex-shrink-0 border-t border-[var(--em-line)] pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <History className="h-3.5 w-3.5" />
        修改前备份
        {items && items.length > 0 && (
          <span className="ml-auto text-[10px] tabular-nums">{items.length}</span>
        )}
      </button>
      {open && (
        <div className="max-h-[min(30vh,240px)] overflow-y-auto pb-1">
          {items === null && !error ? (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> 正在读取…
            </div>
          ) : error ? (
            <p role="alert" className="px-2 py-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : items && items.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">
              暂无备份。代理在会话中首次修改已有文件前会自动备份。
            </p>
          ) : (
            items?.map((b) => (
              <div key={b.id}>
                <div className="truncate px-2 pt-1 text-[11px] font-medium text-foreground/80">
                  {b.originalPath}
                </div>
                <BackupRow backup={b} onChanged={() => void load()} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── 文件面板 ── */

export function ExcelFilesBar() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadInputId = useId();
  const uploadTarget = useRef("");
  const workspaceId = useFilesStore((s) => s.workspaceId);
  const dirs = useFilesStore((s) => s.dirs);
  const rootLoaded = useFilesStore((s) => s.dirs[""] !== undefined);
  const rootLoading = useFilesStore((s) => s.loading[""] ?? false);
  const rootError = useFilesStore((s) => s.errors[""]);
  const tabs = useWorkbookStore((s) => s.tabs);
  const marks = useSessionFileMarks();

  const [view, setView] = useState<"list" | "tree">(readView);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FileSort>(readFileSort);
  const [showSystem, setShowSystem] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creatingRoot, setCreatingRoot] = useState<CreateKind | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<FileEntry | null>(null);

  const listing = view === "list" || query.trim().length > 0;

  // 首次进入（或切换工作区）时加载根目录；列表视图与搜索需要完整文件列表
  useEffect(() => {
    if (!workspaceId) return;
    if (!rootLoaded && !rootLoading) void loadDir("");
    if (listing) void listAllFiles().catch(() => undefined);
  }, [workspaceId, listing, rootLoaded, rootLoading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换工作区时退出多选
  useEffect(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, [workspaceId]);

  const { allFiles, visibleFiles, hiddenCount } = useFileListing(dirs, showSystem, query);
  const openPaths = useMemo(() => new Set(tabs.map((t) => t.path)), [tabs]);
  const selectedEntries = useMemo(
    () => allFiles.filter((f) => selected.has(f.path)),
    [allFiles, selected],
  );
  const visiblePaths = visibleFiles.map((f) => f.path);
  const allSelected = visiblePaths.length > 0 && visiblePaths.every((p) => selected.has(p));

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const onOpen = useCallback(
    (entry: FileEntry, full?: boolean) => {
      if (selectMode) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        return;
      }
      openWorkspaceFile(entry.path, full ? { intent: "full" } : {});
    },
    [selectMode],
  );

  const dragEntries = useCallback(
    (entry: FileEntry) => (selectMode && selected.has(entry.path) ? selectedEntries : [entry]),
    [selectMode, selected, selectedEntries],
  );

  const openUpload = useCallback(
    (folder = "") => {
      if (uploading) return;
      uploadTarget.current = folder;
      const input = uploadRef.current;
      if (!input) return;
      try {
        if (typeof input.showPicker === "function") {
          input.showPicker();
          return;
        }
      } catch {
        // 不支持 showPicker 的 WebView 退回 click()
      }
      input.click();
    },
    [uploading],
  );

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    try {
      await uploadInto(files, uploadTarget.current);
    } finally {
      setUploading(false);
    }
  };

  const ctx: TreeContext = {
    marks,
    openPaths,
    selectMode,
    selectedPaths: selected,
    showSystem,
    sort,
    onOpen,
    dragEntries,
    onInfo: setInfo,
    onUploadTo: openUpload,
  };

  const rootDrop = useFolderDrop("");
  const emptyMessage = query.trim()
    ? "未找到匹配文件"
    : hiddenCount > 0 && !showSystem
      ? `${hiddenCount} 个系统文件已隐藏`
      : "暂无文件，点击上方上传，或把文件拖到这里";

  if (!workspaceId) {
    return (
      <div className={styles.panel}>
        <WorkspaceSwitcher />
        <div className={styles.empty}>正在打开工作区…</div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <WorkspaceSwitcher />

      <div className={styles.controls} data-coach-id="coach-sidebar-file-tools">
        <div className={styles.heading}>
          <div className="min-w-0">
            <div className={styles.title}>
              <span>工作区文件</span>
              <span className={styles.count}>
                {allFiles.length - (showSystem ? 0 : hiddenCount)}
              </span>
            </div>
            <p className={styles.subtitle}>
              {query.trim()
                ? `找到 ${visibleFiles.length} 个匹配项`
                : rootLoading && !rootLoaded
                  ? "正在同步文件列表…"
                  : "单击打开，拖到输入框即可引用"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => openUpload("")}
            disabled={uploading}
            className={styles.upload}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {uploading ? "上传中…" : "上传文件"}
          </button>
        </div>

        <div className={styles.search}>
          <Search className={styles.searchIcon} />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              scrollRef.current?.scrollTo({ top: 0 });
            }}
            placeholder="搜索文件名或路径"
            aria-label="搜索工作区文件"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清除文件搜索"
              className={styles.clearSearch}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className={styles.toolbar}>
          <div className={styles.viewSwitch} role="group" aria-label="文件视图">
            {(
              [
                ["list", List, "列表"],
                ["tree", FolderTree, "文件夹"],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setView(mode);
                  try {
                    localStorage.setItem(VIEW_KEY, mode);
                  } catch {
                    // 偏好写不进去不影响功能
                  }
                }}
                aria-label={`${label}视图`}
                aria-pressed={view === mode}
                className={styles.viewButton}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className={styles.toolbarActions}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                  className={styles.iconButton}
                  aria-pressed={selectMode}
                  aria-label={selectMode ? "退出多选" : "批量选择"}
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{selectMode ? "退出多选" : "批量选择"}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={styles.iconButton} aria-label="更多文件操作">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="end"
                className="w-48"
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <DropdownMenuItem disabled={uploading} onSelect={() => openUpload("")}>
                  <Plus className="h-4 w-4" />
                  上传文件
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setView("tree");
                    setQuery("");
                    setCreatingRoot("file");
                  }}
                >
                  <FilePlus2 className="h-4 w-4" />
                  新建文件
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setView("tree");
                    setQuery("");
                    setCreatingRoot("folder");
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void refreshFiles()}>
                  <RefreshCw className={cn("h-4 w-4", rootLoading && "animate-spin")} />
                  刷新文件列表
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShowSystem((v) => !v)}>
                  {showSystem ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {showSystem
                    ? "隐藏系统文件"
                    : `显示系统文件${hiddenCount > 0 ? `（${hiddenCount} 个）` : ""}`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 pb-2 text-xs text-muted-foreground">
        <span>{sort === "recent" ? "打开过的表格优先" : "文件排序"}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted"
              aria-label={`文件排序：${FILE_SORTS[sort]}`}
            >
              {FILE_SORTS[sort]}
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(FILE_SORTS) as FileSort[]).map((value) => (
              <DropdownMenuItem
                key={value}
                onSelect={() => {
                  setSort(value);
                  saveFileSort(value);
                  scrollRef.current?.scrollTo({ top: 0 });
                }}
              >
                <Check className={cn("h-3 w-3", sort !== value && "invisible")} />
                {FILE_SORTS[value]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {selectMode && (
        <div className={styles.selection} role="region" aria-label="文件批量操作">
          <div className={styles.selectionHeader}>
            <button
              type="button"
              onClick={() => setSelected(allSelected ? new Set() : new Set(visiblePaths))}
              className={styles.selectAll}
              aria-label={allSelected ? "取消全选" : "全选"}
            >
              <span
                className={styles.checkbox}
                data-checked={allSelected}
                data-mixed={selected.size > 0 && !allSelected}
                aria-hidden="true"
              >
                {selected.size > 0 && (allSelected ? <Check /> : <Minus />)}
              </span>
              全选
            </button>
            <span className={styles.selectionCount} role="status">
              已选 <strong>{selected.size}</strong> 项
            </span>
            <button type="button" onClick={exitSelect} className={styles.done}>
              完成
            </button>
          </div>
          {selected.size > 0 ? (
            <div className={styles.selectionActions}>
              <button
                type="button"
                onClick={() => {
                  mentionFiles(selectedEntries);
                  exitSelect();
                }}
                className={cn(styles.action, styles.primaryAction)}
              >
                <AtSign />
                引用到聊天
              </button>
              <button
                type="button"
                onClick={() =>
                  void deleteWithConfirm(selectedEntries).then((ok) => ok && exitSelect())
                }
                className={cn(styles.action, styles.dangerAction)}
              >
                <Trash2 />
                删除所选
              </button>
            </div>
          ) : (
            <p className={styles.selectionHint}>选择文件，批量引用或删除</p>
          )}
        </div>
      )}

      {rootError && (
        <div role="alert" className="px-2 py-2 text-xs text-destructive">
          {rootError}
          <button type="button" className="ml-1 underline" onClick={() => void loadDir("")}>
            重试
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        data-file-scroll-viewport
        className={cn(
          styles.viewport,
          rootDrop.over && "rounded-lg ring-1 ring-[var(--em-primary)]",
        )}
        {...rootDrop.handlers}
      >
        {!rootLoaded ? (
          rootError ? null : (
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground/60">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-[11px]">加载文件列表…</span>
            </div>
          )
        ) : listing ? (
          <FlatFileListView
            scrollRef={scrollRef}
            files={visibleFiles}
            sort={sort}
            marks={marks}
            openPaths={openPaths}
            selectMode={selectMode}
            selectedPaths={selected}
            onOpen={onOpen}
            dragEntries={dragEntries}
            onInfo={setInfo}
            emptyMessage={emptyMessage}
          />
        ) : (
          <>
            <DirChildren
              path=""
              depth={0}
              ctx={ctx}
              creating={creatingRoot}
              onCreated={() => setCreatingRoot(null)}
            />
            {(dirs[""] ?? []).length === 0 && !creatingRoot && (
              <div className={styles.empty}>{emptyMessage}</div>
            )}
          </>
        )}
      </div>

      <BackupsSection />

      <input
        id={uploadInputId}
        data-file-picker="sidebar-upload"
        ref={uploadRef}
        type="file"
        className="sr-only"
        accept={WORKSPACE_FILE_INPUT_ACCEPT}
        multiple
        disabled={uploading}
        onChange={(e) => void handleUpload(e)}
      />

      <FileInfoDialog entry={info} onOpenChange={(open) => !open && setInfo(null)} />
    </div>
  );
}
