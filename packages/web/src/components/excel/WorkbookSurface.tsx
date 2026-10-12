// 工作台：打开的表格标签、功能区（开始 / 问 AI / 变更）、提示条与表格画布。
// 侧边面板与全屏视图共用这一个组件；同一时刻只挂一个 Univer 实例。

import type { PresenceParticipant } from "@excelmanus/protocol";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Columns2,
  Download,
  Eye,
  FileSpreadsheet,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointerSquareDashed,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/backend/api";
import { syncConnectionId } from "@/lib/backend/channel";
import { fileName } from "@/lib/paths";
import { lastUserSeq } from "@/lib/session/reducer";
import type { ChangeEntry } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { askAgent, referenceSelection } from "@/lib/workbook/ask";
import { DATA_ASKS, FORMULA_ASKS } from "@/lib/workbook/ask-actions";
import { changeDeadline } from "@/lib/workbook/change-highlights";
import { useChatStore } from "@/stores/chat-store";
import { downloadWorkspaceFile } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import {
  activateTab,
  closeTab,
  markChangesSeen,
  reloadDocument,
  setFollowAgent,
  setFullView,
  setPanelOpen,
  useWorkbookStore,
} from "@/stores/workbook-store";
import { ChangeNavigator } from "./ChangeNavigator";
import { FormatToolbar, type SheetApi } from "./FormatToolbar";
import { RevisionHistory } from "./RevisionHistory";
import { type OverlayVisibility, UniverSheet, useActivityOverlay } from "./UniverSheet";
import {
  AgentRereadBar,
  CheckpointErrorBar,
  DraftConflictBar,
  ExternalConflictBar,
  SubmitConflictBar,
} from "./WorkbookBars";
import { WorkbookInteractionBar } from "./WorkbookInteractionBar";
import { WorkbookLoadingState } from "./WorkbookLoadingState";

type RibbonTab = "home" | "ask" | "changes";

const OVERLAY_KEY = "excelmanus.overlayVisibility";
const DEFAULT_OVERLAY: OverlayVisibility = { activity: true, pending: true, changed: true };

function useOverlayVisibility() {
  const [visibility, setVisibility] = useState<OverlayVisibility>(() => {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(OVERLAY_KEY) ?? "{}",
      ) as Partial<OverlayVisibility>;
      return {
        activity: parsed.activity !== false,
        pending: parsed.pending !== false,
        changed: parsed.changed !== false,
      };
    } catch {
      return DEFAULT_OVERLAY;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(visibility));
    } catch {
      // 本地存储不可用时仍保留当前会话中的显示状态
    }
  }, [visibility]);
  return [visibility, setVisibility] as const;
}

/** 近期已提交、仍在闪烁期内的改动（清除只影响视觉反馈，不删改变更记录）。 */
function useRecentChanges(): ChangeEntry[] {
  const docId = useWorkbookStore((s) => s.doc?.docId ?? null);
  const seenSeq = useWorkbookStore((s) => s.changesSeenSeq);
  const session = useChatStore((s) => s.session);
  const key = useMemo(() => {
    if (!docId) return "[]";
    const since = Math.max(lastUserSeq(session), seenSeq);
    return JSON.stringify(
      session.changes.filter((c) => c.docId === docId && c.seq > since && c.ranges.length > 0),
    );
  }, [docId, seenSeq, session]);
  const changes = useMemo(() => JSON.parse(key) as ChangeEntry[], [key]);
  const [clock, setClock] = useState(Date.now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clock 在到期时触发重新计算
  const recent = useMemo(
    () => changes.filter((c) => changeDeadline(c) > Date.now()),
    [changes, clock],
  );
  useEffect(() => {
    if (recent.length === 0) return;
    const next = Math.min(...recent.map(changeDeadline));
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [recent]);
  return recent;
}

function IconAction({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            pressed
              ? "bg-[var(--em-primary-alpha-12)] text-[var(--em-primary)]"
              : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-border/80" aria-hidden />;
}

/** 保存状态：文档日志已提交 ≠ xlsx 已写回，按真实阶段表达。 */
function SaveState() {
  const doc = useWorkbookStore((s) => s.doc);
  const pending = useWorkbookStore(
    (s) => Object.values(s.docSync.pending).filter((p) => p.status === "pending").length,
  );
  if (!doc || doc.checkpointError || doc.externalConflict) return null;
  const cls =
    "flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground";
  if (pending > 0)
    return (
      <span className={cls} role="status">
        <Loader2 className="h-3 w-3 animate-spin" />
        提交中 {pending}
      </span>
    );
  const saved = doc.checkpointRev !== undefined && doc.checkpointRev >= doc.rev;
  return (
    <span
      className={cls}
      role="status"
      title={saved ? "所有修改都已写回文件" : "修改已保存在应用中，正在写回文件"}
    >
      {saved ? (
        <Check className="h-3 w-3 text-[var(--em-primary)]" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {saved ? "已保存" : "正在写回"}
    </span>
  );
}

function PresenceDot({ participant }: { participant: PresenceParticipant }) {
  const location = !participant.selection
    ? "未选择单元格"
    : participant.selection.includes("!") || !participant.sheet
      ? participant.selection
      : `${participant.sheet}!${participant.selection}`;
  return (
    <span
      role="img"
      aria-label={`另一个窗口 · ${location}`}
      title={`另一个窗口 · ${location}`}
      className="size-2.5 rounded-full border-2 border-background"
      style={{ backgroundColor: participant.color }}
    />
  );
}

/** 同一文档在其他窗口打开：小圆点 + 悬停说明位置。 */
function PresenceSummary() {
  const participants = useWorkbookStore((s) => s.presence);
  const self = syncConnectionId();
  const others = participants.filter((p) => p.participantId !== self);
  if (others.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center -space-x-0.5"
      role="status"
      aria-label={`${others.length} 个其他窗口`}
    >
      {others.slice(0, 3).map((p) => (
        <PresenceDot key={p.participantId} participant={p} />
      ))}
      {others.length > 3 && (
        <span className="pl-1.5 font-mono text-[10px] text-muted-foreground">
          +{others.length - 3}
        </span>
      )}
    </span>
  );
}

function ActivityChip({ visible }: { visible: boolean }) {
  const live = useActivityOverlay();
  const first = live[0];
  if (!visible || !first) return null;
  return (
    <span
      role="status"
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--em-cyan)_12%,transparent)] px-2 text-[11px] font-medium text-[var(--em-cyan)]"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-current" />
      {first.label}
    </span>
  );
}

/** 视图选项：跟随代理与表格叠加层；偏好保存在本机。 */
function ViewOptions({
  visibility,
  onChange,
}: {
  visibility: OverlayVisibility;
  onChange: (next: OverlayVisibility) => void;
}) {
  const follow = useWorkbookStore((s) => s.followAgent);
  const row = (
    id: string,
    label: string,
    hint: string,
    checked: boolean,
    set: (v: boolean) => void,
  ) => (
    <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{hint}</span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={set} />
    </label>
  );
  const toggle = (key: keyof OverlayVisibility) => (checked: boolean) =>
    onChange({ ...visibility, [key]: checked });
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="视图选项"
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors data-[state=open]:bg-[var(--em-primary-alpha-10)]",
                !follow || !visibility.activity || !visibility.pending || !visibility.changed
                  ? "text-[var(--em-primary)]"
                  : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
              )}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="text-xs">
          视图选项
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-3">
          {row(
            "follow-agent",
            "跟随代理",
            "代理读写表格时自动打开并定位；你手动切换后 5 秒内不打断。",
            follow,
            setFollowAgent,
          )}
          <div className="border-t border-border pt-3 text-[11px] font-medium text-muted-foreground">
            表格叠加层
          </div>
          {row(
            "overlay-activity",
            "正在读写",
            "代理读取或写入的区域（虚线 / 实线框）。",
            visibility.activity,
            toggle("activity"),
          )}
          {row(
            "overlay-pending",
            "计划修改",
            "等待你批准的写入区域与拟写入的值。",
            visibility.pending,
            toggle("pending"),
          )}
          {row(
            "overlay-changed",
            "刚修改",
            "代理刚提交的改动短暂描边。",
            visibility.changed,
            toggle("changed"),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChangeFeedback({ changes }: { changes: ChangeEntry[] }) {
  const latest = changes.at(-1);
  const count = new Set(changes.flatMap((c) => c.ranges)).size;
  const remaining = latest ? Math.max(0, changeDeadline(latest) - Date.now()) : 0;
  return (
    <AnimatePresence>
      {latest && (
        <motion.div
          key="feedback"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-none absolute bottom-10 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2.5 overflow-hidden rounded-xl border border-[var(--em-primary-alpha-25)] bg-background/95 py-2 pl-2.5 pr-1.5 shadow-lg backdrop-blur-sm"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--em-primary-alpha-12)] text-[var(--em-primary)]">
            <Check className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0" role="status" aria-live="polite" aria-atomic="true">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span>已修改 {count} 处</span>
              {latest.rev !== null && (
                <span className="font-mono text-[10px] font-normal text-muted-foreground">
                  修订 {latest.rev}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              在「变更」页签逐处查看修改前后
            </p>
          </div>
          <button
            type="button"
            onClick={markChangesSeen}
            className="pointer-events-auto ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="清除高亮（不影响变更记录）"
          >
            <X className="h-3 w-3" />
            清除
          </button>
          <motion.span
            key={latest.seq}
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[var(--em-primary)]/60"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: remaining / 1000, ease: "linear" }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FileTabs() {
  const tabs = useWorkbookStore((s) => s.tabs);
  const activePath = useWorkbookStore((s) => s.activePath);
  if (tabs.length <= 1) return null;
  return (
    <div
      className="flex min-h-[34px] flex-shrink-0 select-none items-stretch overflow-x-auto border-b border-[var(--em-line)] bg-[var(--em-panel-soft)] scrollbar-none"
      role="tablist"
      aria-label="打开的表格"
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => void activateTab(tab.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void activateTab(tab.path);
              }
            }}
            className={cn(
              "group relative flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/40 px-2.5 text-[11px] transition-colors",
              active
                ? "bg-[var(--em-panel)] text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
            title={tab.path}
          >
            {active && (
              <div
                className="absolute left-0 right-0 top-0 h-[2px]"
                style={{ backgroundColor: "var(--em-primary)" }}
              />
            )}
            <FileSpreadsheet className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="max-w-[120px] truncate">{fileName(tab.path)}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.path);
              }}
              className="ml-0.5 rounded p-0.5 opacity-0 transition-all hover:bg-muted hover:!opacity-100 group-hover:opacity-60"
              title="关闭"
              aria-label={`关闭 ${fileName(tab.path)}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function AskRibbon() {
  const button = (action: (typeof FORMULA_ASKS)[number]) => (
    <button
      key={`${action.kind}-${action.label}`}
      type="button"
      title={action.title}
      onClick={() => askAgent(action.kind)}
      className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs whitespace-nowrap text-foreground/85 transition-colors hover:bg-[var(--em-primary-alpha-08)] hover:text-foreground"
    >
      {action.label}
    </button>
  );
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none"
      role="toolbar"
      aria-label="问 AI"
    >
      <span className="shrink-0 pr-1 text-[10px] font-medium tracking-wide text-muted-foreground/80">
        公式
      </span>
      {FORMULA_ASKS.map(button)}
      <Divider />
      <span className="shrink-0 px-1 text-[10px] font-medium tracking-wide text-muted-foreground/80">
        数据
      </span>
      {DATA_ASKS.map(button)}
    </div>
  );
}

export function WorkbookSurface({ placement }: { placement: "panel" | "full" }) {
  const doc = useWorkbookStore((s) => s.doc);
  const loading = useWorkbookStore((s) => s.loading);
  const loadError = useWorkbookStore((s) => s.loadError);
  const activePath = useWorkbookStore((s) => s.activePath);
  const pinned = useWorkbookStore(
    (s) => s.pinnedSelection !== null && s.pinnedSelection.docId === s.doc?.docId,
  );
  const [tab, setTab] = useState<RibbonTab>("home");
  const [visibility, setVisibility] = useOverlayVisibility();
  const [sheetApi, setSheetApi] = useState<SheetApi | null>(null);
  const onApi = useCallback((api: SheetApi | null) => setSheetApi(api), []);
  const recentChanges = useRecentChanges();
  const changedCount = useChatStore((s) => {
    const docId = doc?.docId;
    return docId
      ? s.session.changes.filter((c) => c.docId === docId && c.seq > lastUserSeq(s.session)).length
      : 0;
  });

  const path = doc?.path ?? activePath;
  const close = () => {
    if (placement === "full") setFullView(false);
    else setPanelOpen(false);
  };
  const download = () => {
    if (path)
      void downloadWorkspaceFile(path).catch((error: unknown) =>
        toast({ tone: "error", title: errorMessage(error, "下载失败") }),
      );
  };
  const refresh = () => {
    void reloadDocument().catch((error: unknown) =>
      toast({ tone: "error", title: errorMessage(error, "刷新失败") }),
    );
  };

  const tabs: { key: RibbonTab; label: string; badge?: number }[] = [
    { key: "home", label: "开始" },
    { key: "ask", label: "问 AI" },
    { key: "changes", label: "变更", ...(changedCount > 0 ? { badge: changedCount } : {}) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-workbook-placement={placement}>
      <FileTabs />
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-[var(--em-line)] bg-[var(--em-panel-soft)] px-3">
        <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <h2 className="min-w-0 truncate text-[13px] font-semibold" title={path ?? undefined}>
          {path ? fileName(path) : "表格"}
        </h2>
        <SaveState />
        <span className="min-w-2 flex-1" />
        <ActivityChip visible={visibility.activity} />
        <PresenceSummary />
        <IconAction
          label={placement === "full" ? "收起到侧栏" : "展开为全屏表格"}
          onClick={() => setFullView(placement !== "full")}
        >
          {placement === "full" ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </IconAction>
        <IconAction label={placement === "full" ? "回到对话" : "关闭表格面板"} onClick={close}>
          <X className="h-3.5 w-3.5" />
        </IconAction>
      </div>

      {doc && (
        <div className="flex flex-shrink-0 flex-col border-b border-[var(--em-line)] bg-background">
          <div className="flex h-9 items-center gap-1 px-2" role="tablist" aria-label="功能区">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                onClick={() => setTab(item.key)}
                className={cn(
                  "relative inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[13px] transition-colors",
                  tab === item.key
                    ? "bg-[var(--em-primary-alpha-10)] font-semibold text-[var(--em-primary)]"
                    : "text-foreground/75 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
                )}
              >
                {item.key === "ask" && <Sparkles className="h-3 w-3" />}
                {item.label}
                {item.badge ? (
                  <span className="ml-0.5 rounded-full bg-[var(--em-primary)] px-1.5 text-[10px] font-semibold leading-4 text-white">
                    {item.badge}
                  </span>
                ) : null}
              </button>
            ))}
            <div className="min-w-2 flex-1" />
            <div className="flex shrink-0 items-center gap-0.5">
              <IconAction
                label={pinned ? "选区已加到对话" : "把选区加到对话"}
                pressed={pinned}
                onClick={referenceSelection}
              >
                <MousePointerSquareDashed className="h-3.5 w-3.5" />
              </IconAction>
              <ViewOptions visibility={visibility} onChange={setVisibility} />
              <RevisionHistory />
              <IconAction
                label="与另一个表格对比"
                onClick={() => useUIStore.getState().openCompare(doc.path)}
              >
                <Columns2 className="h-3.5 w-3.5" />
              </IconAction>
              <Divider />
              <IconAction label="刷新（重新读取最新内容）" onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction label="下载文件" onClick={download}>
                <Download className="h-3.5 w-3.5" />
              </IconAction>
            </div>
          </div>
          <div className="flex h-9 min-w-0 items-center border-t border-[var(--em-hairline)] px-2">
            {tab === "home" && (
              <FormatToolbar api={sheetApi} csv={/\.(csv|tsv)$/i.test(doc.path)} />
            )}
            {tab === "ask" && <AskRibbon />}
            {tab === "changes" && <ChangeNavigator />}
          </div>
        </div>
      )}

      <SubmitConflictBar api={sheetApi} />
      <DraftConflictBar api={sheetApi} />
      <ExternalConflictBar />
      <CheckpointErrorBar />
      <AgentRereadBar />

      <div className="relative isolate min-h-0 flex-1 overflow-hidden">
        {doc ? (
          <>
            <UniverSheet
              visibility={visibility}
              changes={recentChanges}
              onApi={onApi}
              onAsk={(kind) => askAgent(kind)}
              onReference={referenceSelection}
            />
            {visibility.changed && <ChangeFeedback changes={recentChanges} />}
          </>
        ) : loading ? (
          <WorkbookLoadingState label="正在打开表格" detail={path ? fileName(path) : undefined} />
        ) : loadError ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"
            role="alert"
          >
            <p>{loadError}</p>
            {path && (
              <button
                type="button"
                onClick={() => void activateTab(path)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-muted"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </button>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <FileSpreadsheet className="h-8 w-8 opacity-40" />
            <p>从左侧文件栏打开一个工作簿</p>
          </div>
        )}
      </div>

      <WorkbookInteractionBar />
    </div>
  );
}
