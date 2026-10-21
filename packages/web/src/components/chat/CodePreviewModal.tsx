import { hasPreviewMatch } from "@/lib/preview-line-search";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Download,
  Eye,
  FileCode,
  Loader2,
  Search,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { HIGHLIGHT_WORKER_THRESHOLD } from "@/lib/highlight-policy";
import { ensureHljs, highlightCode, plainCodeLines } from "@/lib/hljs-utils";
import { createTextLines, type TextLines } from "@/lib/text-lines";
import { usePreviewSearch } from "@/lib/use-preview-search";
import { downloadWorkspaceFile, useFilesStore } from "@/stores/files-store";
import { loadTextPreview, usePreviewStore } from "@/stores/preview-store";

interface CodePreviewModalProps {
  filePath: string;
  filename: string;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface PreviewTab {
  filePath: string;
  filename: string;
}

const previewTabKey = (tab: PreviewTab) => tab.filePath;

const CODE_LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".go": "go",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "plaintext",
  ".log": "plaintext",
  ".env": "bash",
  ".gitignore": "plaintext",
  ".dockerignore": "plaintext",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "xml",
  ".svelte": "xml",
  ".ex": "erlang",
  ".exs": "erlang",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".fs": "fsharp",
  ".clj": "clojure",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".groovy": "groovy",
};

/* ─── Language color mapping (VS Code–style) ─── */
const LANG_COLORS: Record<string, string> = {
  python: "#3572A5",
  javascript: "#f1e05a",
  typescript: "#3178c6",
  json: "#292929",
  ruby: "#701516",
  rust: "#dea584",
  java: "#b07219",
  c: "#555555",
  cpp: "#f34b7d",
  csharp: "#178600",
  php: "#4F5D95",
  swift: "#F05138",
  kotlin: "#A97BFF",
  scala: "#c22d40",
  go: "#00ADD8",
  bash: "#89e051",
  sql: "#e38c00",
  html: "#e34c26",
  css: "#563d7c",
  scss: "#c6538c",
  less: "#1d365d",
  xml: "#0060ac",
  yaml: "#cb171e",
  toml: "#9c4221",
  ini: "#d1dbe0",
  markdown: "#083fa1",
  plaintext: "#999999",
  graphql: "#e10098",
  erlang: "#B83998",
  haskell: "#5e5086",
  ocaml: "#3be133",
  fsharp: "#b845fc",
  clojure: "#db5855",
  lua: "#000080",
  r: "#198CE7",
  dart: "#00B4AB",
  groovy: "#4298b8",
};

function getLanguage(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return CODE_LANGUAGE_MAP[ext] || "plaintext";
}

function getLangColor(lang: string): string {
  return LANG_COLORS[lang] || "#999";
}

/* ─── Breadcrumb from path ─── */
function pathToBreadcrumb(filePath: string): string[] {
  const parts = filePath.replace(/^\/+/, "").split("/");
  return parts.length > 4 ? ["...", ...parts.slice(-3)] : parts;
}

type TabItem = PreviewTab;

const LINE_HEIGHT = 20;
const EMPTY_HIGHLIGHT_LINES: TextLines = { length: 0, get: () => undefined };

export function CodePreviewModal({
  filePath,
  filename,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: CodePreviewModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(next);
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );
  const [activeFile, setActiveFile] = useState<TabItem>({ filePath, filename });
  const workspaceId = useFilesStore((s) => s.workspaceId);
  const textContent = usePreviewStore((s) => s.textContent);
  const matches =
    textContent?.workspaceId === workspaceId && textContent?.path === activeFile.filePath;
  const content = matches ? textContent.content : "";
  const loading = !matches || textContent.loading;
  const error = matches ? textContent.error : "";
  const [copied, setCopied] = useState(false);
  const [activeLine, setActiveLine] = useState<number>(-1);
  const [mdPreview, setMdPreview] = useState(false);
  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 标签页：最近预览过的文本文件（preview-store.recent），本窗口内关闭的不再显示
  const recent = usePreviewStore((s) => s.recent);
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());
  const previewTabs = useMemo(
    () =>
      recent
        .map((r) => ({ filePath: r.path, filename: r.filename }))
        .filter((t) => !closedTabs.has(t.filePath)),
    [recent, closedTabs],
  );
  const workspaceFilesVersion = useFilesStore((s) => s.version);

  // ── Virtualizer ──
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && workspaceId)
      void loadTextPreview(workspaceId, activeFile.filePath, workspaceFilesVersion);
  }, [open, workspaceId, activeFile.filePath, workspaceFilesVersion]);

  // ── Highlight with shared module (lazy) ──
  const [highlighted, setHighlighted] = useState<{
    content: string;
    filename: string;
    lines: TextLines;
  }>({ content: "", filename: "", lines: EMPTY_HIGHLIGHT_LINES });
  const rawLines = useMemo(() => createTextLines(content), [content]);
  const highlightedLines =
    highlighted.content === content && highlighted.filename === activeFile.filename
      ? highlighted.lines
      : null;
  useEffect(() => {
    if (!content) {
      setHighlighted({ content: "", filename: activeFile.filename, lines: EMPTY_HIGHLIGHT_LINES });
      return;
    }
    let cancelled = false;
    let worker: Worker | null = null;
    const complete = (html: string | null) => {
      if (!cancelled && html !== null)
        setHighlighted({ content, filename: activeFile.filename, lines: createTextLines(html) });
    };
    const language = getLanguage(activeFile.filename);
    if (content.length >= HIGHLIGHT_WORKER_THRESHOLD) {
      // Large grammars can block the UI for seconds. Keep plain text visible while working.
      try {
        worker = new Worker(new URL("../../lib/preview-highlight.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<string | null>) => {
          complete(event.data);
          worker?.terminate();
          worker = null;
        };
        worker.onerror = () => {
          worker?.terminate();
          worker = null;
        };
        worker.postMessage({ code: content, language, output: "html" });
      } catch {
        worker?.terminate();
        worker = null; // Optional highlighting failed; the escaped original remains usable.
      }
    } else {
      ensureHljs(language).then(() => {
        if (!cancelled) complete(highlightCode(content, language));
      });
    }
    return () => {
      cancelled = true;
      worker?.terminate();
      worker = null;
    };
  }, [content, activeFile.filename]);

  const { matches: searchMatches, pending: searchPending } = usePreviewSearch(
    content,
    searchQuery,
    rawLines,
  );
  const lineCount = highlightedLines?.length ?? rawLines.length;

  // ── Virtualizer instance ──
  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  // ── Open → register tab + fetch + reset state ──
  useEffect(() => {
    if (!open) return;
    const tab: TabItem = { filePath, filename };
    setClosedTabs((prev) => {
      if (!prev.has(filePath)) return prev;
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
    setActiveFile(tab);
    setActiveLine(-1);
    setMdPreview(false);
    setSearchOpen(false);
    setSearchQuery("");
  }, [open, filePath, filename]);

  // ── Body scroll lock ──
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
        } else setOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, searchOpen, setOpen]);

  // Only the current query's completed results may move the preview.
  useEffect(() => {
    setSearchIdx(0);
    if (searchMatches.length > 0) virtualizer.scrollToIndex(searchMatches[0], { align: "center" });
  }, [searchMatches, virtualizer]);

  const searchNext = useCallback(() => {
    if (searchMatches.length === 0) return;
    const next = (searchIdx + 1) % searchMatches.length;
    setSearchIdx(next);
    virtualizer.scrollToIndex(searchMatches[next], { align: "center" });
  }, [searchIdx, searchMatches, virtualizer]);

  const searchPrev = useCallback(() => {
    if (searchMatches.length === 0) return;
    const prev = (searchIdx - 1 + searchMatches.length) % searchMatches.length;
    setSearchIdx(prev);
    virtualizer.scrollToIndex(searchMatches[prev], { align: "center" });
  }, [searchIdx, searchMatches, virtualizer]);

  // ── Tab actions ──
  const handleTabClick = useCallback((tab: TabItem) => {
    setActiveFile(tab);
    setActiveLine(-1);
    setMdPreview(false);
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleTabClose = useCallback(
    (e: React.MouseEvent, tab: TabItem) => {
      e.stopPropagation();
      setClosedTabs((prev) => new Set(prev).add(tab.filePath));
      if (previewTabKey(tab) === previewTabKey(activeFile)) {
        const remaining = previewTabs.filter((item) => previewTabKey(item) !== previewTabKey(tab));
        const next = remaining[remaining.length - 1];
        if (next) {
          setActiveFile(next);
        } else {
          setOpen(false);
        }
      }
    },
    [activeFile, previewTabs, setOpen],
  );

  // ── Toolbar actions ──
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  }, [content]);

  const handleDownload = useCallback(async () => {
    await downloadWorkspaceFile(activeFile.filePath).catch(() => {});
  }, [activeFile]);

  // ── Derived state ──
  const language = getLanguage(activeFile.filename);
  const langColor = getLangColor(language);
  const isMarkdown = language === "markdown";
  const breadcrumb = useMemo(() => pathToBreadcrumb(activeFile.filePath), [activeFile.filePath]);
  const lineDigits = useMemo(() => String(lineCount).length, [lineCount]);
  const currentSearchLine = searchMatches.length > 0 ? searchMatches[searchIdx] : -1;

  /* ─── Portal overlay ─── */
  const overlay = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (searchOpen) event.preventDefault();
        }}
        className="em-preview-modal z-[9999] flex flex-col gap-0 h-[85vh] overflow-hidden rounded-xl bg-white dark:bg-[#1e1e1e] p-0"
        style={{ width: "95vw", maxWidth: "1200px" }}
      >
        <DialogTitle className="sr-only">预览 {activeFile.filename}</DialogTitle>
        {/* ── Tab bar ── */}
        <div className="em-preview-tabs flex items-center bg-[#f3f3f3] dark:bg-[#252526] border-b border-gray-200 dark:border-gray-700 min-h-[36px] select-none overflow-x-auto scrollbar-none">
          <div className="flex items-center flex-1 min-w-0">
            {previewTabs.map((tab) => {
              const isActive = previewTabKey(tab) === previewTabKey(activeFile);
              const tabLang = getLanguage(tab.filename);
              const tabColor = getLangColor(tabLang);
              return (
                <div
                  key={previewTabKey(tab)}
                  onClick={() => handleTabClick(tab)}
                  className={`group relative flex items-center gap-1.5 px-3 h-[36px] text-[12px] cursor-pointer shrink-0 border-r border-gray-200/60 dark:border-gray-700/60 transition-colors ${
                    isActive
                      ? "bg-white dark:bg-[#1e1e1e] text-gray-800 dark:text-gray-200"
                      : "text-gray-500 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-[#2a2a2a]"
                  }`}
                >
                  {isActive && (
                    <div className="absolute top-0 left-0 right-0 h-[2px] bg-[var(--em-primary)]" />
                  )}
                  {/* Language color dot */}
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/5 dark:ring-white/10"
                    style={{ backgroundColor: tabColor }}
                  />
                  <span className="truncate max-w-[120px]">{tab.filename}</span>
                  <button
                    onClick={(e) => handleTabClose(e, tab)}
                    className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all"
                    title="关闭"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
          {/* Close all button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            className="shrink-0 p-2 mx-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-600/40 transition-all"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Breadcrumb + Toolbar bar ── */}
        <div className="em-preview-toolbar flex items-center gap-1.5 px-3 h-[32px] bg-[#fafafa] dark:bg-[#1e1e1e] border-b border-gray-100 dark:border-gray-800 text-[11px] text-gray-400 dark:text-gray-500 select-none overflow-hidden">
          {breadcrumb.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 opacity-50" />}
              <span
                className={
                  i === breadcrumb.length - 1
                    ? "text-gray-600 dark:text-gray-300 font-medium truncate"
                    : "truncate"
                }
              >
                {seg}
              </span>
            </React.Fragment>
          ))}
          <div className="flex-1" />
          {/* Action buttons — prominent */}
          <div className="em-preview-actions flex items-center gap-1">
            {isMarkdown && !loading && !error && (
              <button
                onClick={() => setMdPreview(!mdPreview)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  mdPreview
                    ? "bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)] border border-[var(--em-primary-alpha-20)]"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200/80 dark:hover:bg-gray-700"
                }`}
                title={mdPreview ? "显示源码" : "预览 Markdown"}
              >
                {mdPreview ? <Code2 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                <span>{mdPreview ? "源码" : "预览"}</span>
              </button>
            )}
            <button
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                searchOpen
                  ? "bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)] border border-[var(--em-primary-alpha-20)]"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200/80 dark:hover:bg-gray-700"
              }`}
              title="搜索 (Ctrl+F)"
            >
              <Search className="w-3.5 h-3.5" />
              <span>搜索</span>
            </button>
          </div>
        </div>

        {/* ── Search bar (animated) ── */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 36, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden shrink-0"
            >
              <div className="em-preview-search flex items-center gap-2 px-3 h-[36px] bg-[#f5f5f5] dark:bg-[#252526] border-b border-gray-200 dark:border-gray-700">
                <Search className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.shiftKey ? searchPrev() : searchNext();
                    }
                    if (e.key === "Escape") {
                      setSearchOpen(false);
                      setSearchQuery("");
                    }
                  }}
                  placeholder="搜索…"
                  className="flex-1 bg-white dark:bg-[#3c3c3c] border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-[12px] text-gray-800 dark:text-gray-200 placeholder:text-gray-400 outline-none focus:border-[var(--em-primary)] focus:ring-1 focus:ring-[var(--em-primary)]/30 transition-all"
                />
                <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
                  {searchPending
                    ? "正在搜索…"
                    : searchMatches.length > 0
                      ? `${searchIdx + 1}/${searchMatches.length}`
                      : searchQuery
                        ? "无结果"
                        : ""}
                </span>
                <button
                  onClick={searchPrev}
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  title="上一个"
                >
                  <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
                </button>
                <button
                  onClick={searchNext}
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  title="下一个"
                >
                  <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
                </button>
                <button
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  title="关闭搜索"
                >
                  <X className="w-3.5 h-3.5 text-gray-500" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Content area ── */}
        <div className="em-preview-content flex-1 overflow-hidden bg-white dark:bg-[#1e1e1e]">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <Loader2 className="w-7 h-7 animate-spin text-[var(--em-primary)] opacity-40" />
              <span className="text-xs text-gray-400">加载中…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-gray-500">
              <div className="w-16 h-16 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <FileCode className="w-8 h-8" />
              </div>
              <span role="alert" className="text-sm font-medium">
                {error}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!workspaceId}
                onClick={() => {
                  if (workspaceId)
                    void loadTextPreview(workspaceId, activeFile.filePath, workspaceFilesVersion);
                }}
              >
                重新读取
              </Button>
              <span className="text-xs text-gray-300 dark:text-gray-600">按 Esc 关闭</span>
            </div>
          ) : mdPreview && isMarkdown ? (
            <MarkdownPreview content={content} />
          ) : (
            /* ── Virtualized code view ── */
            <div ref={scrollContainerRef} className="h-full overflow-auto">
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
                className="font-mono text-[13px] leading-[20px]"
              >
                {virtualizer.getVirtualItems().map((vItem) => {
                  const lineIdx = vItem.index;
                  const isActive_l = lineIdx === activeLine;
                  const isSearchMatch = hasPreviewMatch(searchMatches, lineIdx);
                  const isCurrentSearch = lineIdx === currentSearchLine;
                  return (
                    <div
                      key={vItem.key}
                      data-index={vItem.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vItem.start}px)`,
                        minHeight: LINE_HEIGHT,
                      }}
                      className={`flex cursor-pointer transition-colors duration-75 ${
                        isCurrentSearch
                          ? "bg-amber-200/40 dark:bg-amber-500/20"
                          : isSearchMatch
                            ? "bg-amber-100/30 dark:bg-amber-600/10"
                            : isActive_l
                              ? "bg-[var(--em-primary-alpha-06)]"
                              : "hover:bg-gray-50 dark:hover:bg-[#ffffff06]"
                      }`}
                      onClick={() => setActiveLine(lineIdx === activeLine ? -1 : lineIdx)}
                    >
                      {/* Line number */}
                      <span
                        className={`select-none text-right pr-4 pl-4 shrink-0 tabular-nums border-r ${
                          isActive_l
                            ? "text-gray-600 dark:text-gray-300 bg-gray-100/60 dark:bg-[#ffffff0a] border-gray-200 dark:border-gray-700"
                            : "text-gray-400 dark:text-gray-600 bg-gray-50/80 dark:bg-[#1e1e1e] border-gray-100 dark:border-gray-800"
                        }`}
                        style={{ minWidth: `${lineDigits * 0.6 + 2}em` }}
                      >
                        {lineIdx + 1}
                      </span>
                      {/* Code content */}
                      <span className="pl-4 pr-4 whitespace-pre flex-1 min-w-0">
                        <PreviewLineContent
                          raw={rawLines.get(lineIdx) ?? ""}
                          html={highlightedLines?.get(lineIdx)}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Status bar (VS Code–style) ── */}
        <div className="em-preview-status flex items-center justify-between px-3 h-[24px] bg-[var(--em-primary)] text-white text-[11px] select-none shrink-0">
          <div className="flex items-center gap-3">
            <span
              className="w-2 h-2 rounded-full ring-1 ring-white/20"
              style={{ backgroundColor: langColor }}
            />
            <span className="opacity-90 truncate max-w-[200px]" title={activeFile.filename}>
              {activeFile.filename}
            </span>
            <span className="opacity-60 uppercase text-[10px]">{language}</span>
            <span className="opacity-60 tabular-nums">{lineCount} 行</span>
            {activeLine >= 0 && (
              <span className="opacity-70 tabular-nums">行 {activeLine + 1}</span>
            )}
            <span className="opacity-60">UTF-8</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              disabled={!content || loading}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded opacity-80 hover:opacity-100 hover:bg-white/15 disabled:opacity-30 transition-all"
              title="复制内容"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownload();
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded opacity-80 hover:opacity-100 hover:bg-white/15 transition-all"
              title="下载"
            >
              <Download className="w-3 h-3" />
              <span>下载</span>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {trigger !== undefined && trigger !== null && (
        <span
          className="inline"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {trigger}
        </span>
      )}
      {overlay}
    </>
  );
}

/** A mounted visible line owns its markup; unrelated controls do not escape/parse it again. */
function PreviewLineContent({ raw, html }: { raw: string; html?: string }) {
  return useMemo(
    () => (
      <code
        className="hljs"
        dangerouslySetInnerHTML={{ __html: (html ?? plainCodeLines(raw)[0]) || "\u00a0" }}
      />
    ),
    [raw, html],
  );
}

/* ─── Markdown preview sub-component (lazy react-markdown) ─── */
export function MarkdownPreview({ content }: { content: string }) {
  const [MdRenderer, setMdRenderer] = useState<React.ComponentType<{ children: string }> | null>(
    null,
  );

  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    Promise.all([import("react-markdown"), import("remark-gfm")])
      .then(([mdMod, gfmMod]) => {
        if (cancelled) return;
        const ReactMarkdown = mdMod.default;
        const remarkGfm = gfmMod.default;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Wrapper = ({ children }: { children: string }) => (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
        );
        setMdRenderer(() => Wrapper);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const body = useMemo(
    () => (MdRenderer ? <MdRenderer>{content}</MdRenderer> : null),
    [MdRenderer, content],
  );

  if (failed) {
    return (
      <div className="h-full overflow-auto px-8 py-6">
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
          <span>排版预览加载失败，仍可查看原文。</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            重新加载预览
          </Button>
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-sm">{content}</pre>
      </div>
    );
  }

  if (!MdRenderer) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <article className="prose prose-sm dark:prose-invert max-w-none">{body}</article>
    </div>
  );
}

export { getLanguage };
