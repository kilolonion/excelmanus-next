// 「打开表格」：从当前工作区挑一份表格（或从本地上传后打开），在侧栏或全屏工作台打开。

import type { FileEntry } from "@excelmanus/protocol";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { FileSpreadsheet, FolderOpen, Loader2, RefreshCw, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/backend/api";
import { isLegacySpreadsheetFile, isSpreadsheetFile } from "@/lib/file-kind";
import { dirName, samePath } from "@/lib/paths";
import { listAllFiles, uploadFiles, useFilesStore } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import { openWorkbook, useWorkbookStore } from "@/stores/workbook-store";

type Source = "workspace" | "open";

export function OpenWorkbookDialog() {
  const target = useUIStore((s) => s.workbookPicker);
  const close = useUIStore((s) => s.closeWorkbookPicker);
  const open = target !== null;
  const tabs = useWorkbookStore((s) => s.tabs);
  const filesVersion = useFilesStore((s) => s.version);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [source, setSource] = useState<Source>("workspace");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listAllFiles(4000, 8)
      .then((items) => {
        if (!cancelled)
          setFiles(
            items.filter((f) => isSpreadsheetFile(f.path) || isLegacySpreadsheetFile(f.path)),
          );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "文件列表加载失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload, filesVersion]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setOpening(null);
      setSource(tabs.length > 0 ? "open" : "workspace");
    }
    // 只在打开时决定默认来源
    // biome-ignore lint/correctness/useExhaustiveDependencies: tabs 变化不重置
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const rows =
      source === "open"
        ? tabs.map(
            (t) =>
              files.find((f) => samePath(f.path, t.path)) ??
              ({ path: t.path, name: t.path.split("/").pop() ?? t.path } as FileEntry),
          )
        : files;
    return rows.filter((f) => !q || f.path.toLocaleLowerCase().includes(q));
  }, [files, tabs, source, query]);

  const virtualizer = useVirtualizer({
    count: open ? candidates.length : 0,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => candidates[index]?.path ?? index,
    estimateSize: () => 60,
    overscan: 6,
    rangeExtractor: defaultRangeExtractor,
  });
  const virtualRows = virtualizer.getVirtualItems();
  // 对话框内容经 portal 渲染，首帧可能拿不到滚动容器：先显示前几行
  const rows =
    virtualRows.length > 0
      ? virtualRows
      : candidates.slice(0, 8).map((file, index) => ({ key: file.path, index, start: index * 60 }));
  const listHeight = Math.max(virtualizer.getTotalSize(), candidates.length * 60);

  const openPath = async (path: string) => {
    if (opening) return;
    setOpening(`正在打开 ${path.split("/").pop()}…`);
    setError(null);
    try {
      await openWorkbook(path, { full: target === "full" });
      if (useWorkbookStore.getState().loadError)
        throw new Error(useWorkbookStore.getState().loadError ?? "表格打开失败");
      close();
    } catch (err) {
      setError(errorMessage(err, "表格打开失败"));
    } finally {
      setOpening(null);
    }
  };

  const uploadAndOpen = async (file: File) => {
    if (opening) return;
    if (!isSpreadsheetFile(file.name)) {
      setError(
        isLegacySpreadsheetFile(file.name)
          ? "暂不支持 .xls / .xlsb，请先另存为 .xlsx"
          : "请选择 xlsx、xlsm、csv 或 tsv 表格",
      );
      return;
    }
    setError(null);
    setOpening(`正在上传 ${file.name}…`);
    try {
      const [path] = await uploadFiles([file]);
      setOpening(null);
      if (path) await openPath(path);
    } catch (err) {
      setError(errorMessage(err, "上传失败"));
      setOpening(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent
        className="sm:max-w-xl"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) void uploadAndOpen(file);
        }}
      >
        <DialogHeader>
          <DialogTitle>打开表格</DialogTitle>
          <DialogDescription>
            {target === "full"
              ? "选择后在全屏工作台打开，对话停靠在右侧。"
              : "选择后在对话旁的表格面板打开，可直接查看、提问或编辑。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1" aria-label="表格来源">
          {(
            [
              ["workspace", "工作区表格"],
              ["open", `已打开${tabs.length > 0 ? ` ${tabs.length}` : ""}`],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={source === key ? "secondary" : "ghost"}
              aria-pressed={source === key}
              onClick={() => setSource(key)}
            >
              {label}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto gap-1"
            aria-label="刷新文件列表"
            disabled={loading || Boolean(opening)}
            onClick={() => setReload((v) => v + 1)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
        <label className="flex items-center gap-2 rounded-lg border px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="搜索表格文件名"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名或路径"
            className="w-full min-w-0 bg-transparent text-sm outline-none"
          />
        </label>
        <div ref={listRef} className="max-h-72 min-h-32 overflow-y-auto" aria-busy={loading}>
          {loading && candidates.length === 0 ? (
            <p
              role="status"
              className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取文件列表…
            </p>
          ) : candidates.length > 0 ? (
            <div className="relative" style={{ height: listHeight }}>
              {rows.map((row) => {
                const file = candidates[row.index];
                if (!file) return null;
                const legacy = isLegacySpreadsheetFile(file.path);
                const alreadyOpen = tabs.some((t) => samePath(t.path, file.path));
                const dir = dirName(file.path);
                return (
                  <div
                    key={row.key}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <button
                      type="button"
                      disabled={legacy || Boolean(opening)}
                      title={
                        legacy ? "暂不支持在工作台打开 .xls / .xlsb，请另存为 .xlsx" : file.path
                      }
                      onClick={() => void openPath(file.path)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FileSpreadsheet className="h-5 w-5 shrink-0 text-[var(--em-primary)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{file.path.split("/").pop()}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {legacy ? "需另存为 .xlsx 后打开" : dir || "工作区根目录"}
                        </span>
                      </span>
                      {alreadyOpen ? (
                        <span className="shrink-0 rounded-full bg-[var(--em-primary-alpha-08)] px-2 py-0.5 text-xs text-[var(--em-primary)]">
                          已打开
                        </span>
                      ) : (
                        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {query
                ? "没有匹配的表格"
                : source === "open"
                  ? "还没有打开的表格"
                  : "工作区里还没有表格，可以从本地上传并打开"}
            </p>
          )}
        </div>
        {opening && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span className="break-all">{opening}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <Button
            variant="outline"
            disabled={Boolean(opening)}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            从本地上传并打开
          </Button>
          <span className="text-xs text-muted-foreground">也可将表格拖到这里</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xlsm,.csv,.tsv"
          className="hidden"
          aria-label="上传并打开表格"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void uploadAndOpen(file);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
