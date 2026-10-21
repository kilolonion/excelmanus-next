// 对话与当前表格的关联：输入框上方的「表格引用」徽标，以及打开表格后的空对话引导页。
// 附带给代理的只有区域上下文（钉住的区域优先，其次当前选区，见 workbook-store.composerContext）。

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseRange } from "@excelmanus/core";
import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  ClipboardCheck,
  FileSpreadsheet,
  type LucideIcon,
  Pin,
  PinOff,
  Search,
  Table2,
  X,
} from "lucide-react";
import styles from "@/components/welcome/WelcomePage.module.css";
import { baseName, fileName } from "@/lib/paths";
import { useChatStore } from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";
import {
  composerContext,
  dismissContext,
  focusRange,
  pinSelection,
  type SelectionRef,
  setFullView,
  useWorkbookStore,
} from "@/stores/workbook-store";

export type WorkbookContextStatus = "loading" | "ready" | "error";

export interface WorkbookConversation {
  sessionId: string | null;
  /** 工作台打开了表格时非空（空对话页据此切换为表格引导）。 */
  target: { path: string; docId: string | null } | null;
  /** 工作台当前打开的表格（未打开时为 null）。 */
  path: string | null;
  docId: string | null;
  /** 当前选区所在的工作表（选区不带表名时为 null）。 */
  sheet: string | null;
  status: WorkbookContextStatus | null;
  /** 本条消息将附带的区域上下文。 */
  context: SelectionRef | null;
  pinned: boolean;
}

function sheetOf(range: string | undefined): string | null {
  if (!range) return null;
  try {
    return parseRange(range).sheet ?? null;
  } catch {
    return null;
  }
}

export function useWorkbookConversation(): WorkbookConversation {
  const sessionId = useChatStore((s) => s.sessionId);
  const path = useWorkbookStore((s) => s.doc?.path ?? s.activePath);
  const docId = useWorkbookStore((s) => s.doc?.docId ?? null);
  const status = useWorkbookStore((s): WorkbookContextStatus | null =>
    s.loadError ? "error" : s.loading ? "loading" : s.doc ? "ready" : null,
  );
  const pinnedSelection = useWorkbookStore((s) => s.pinnedSelection);
  const selection = useWorkbookStore((s) => s.selection);
  const selectionDismissed = useWorkbookStore((s) => s.selectionDismissed);
  const context = composerContext({ pinnedSelection, selection, selectionDismissed });
  return {
    sessionId,
    target: path ? { path, docId } : null,
    path,
    docId,
    sheet: sheetOf(context?.range ?? selection?.range),
    status,
    context,
    pinned: pinnedSelection !== null,
  };
}

/** 输入框上方的表格引用：显示随消息附带的区域，可钉住、定位或移除。 */
export function WorkbookContextChip() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { path, docId, status, context, pinned } = useWorkbookConversation();
  const open = useWorkbookStore((s) => s.panelOpen || s.fullView);
  const tabs = useWorkbookStore((s) => s.tabs);
  if (!context && (!path || !open)) return null;
  const contextPath = context
    ? (context.path ??
      (context.docId === docId ? path : tabs.find((tab) => tab.docId === context.docId)?.path))
    : path;
  const displayPath = contextPath ?? context?.docId ?? "工作簿";
  const range = context?.range;
  const label = range ? `${fileName(displayPath)} · ${range}` : fileName(displayPath);
  const contextState = range
    ? "selection"
    : status === "error"
      ? "error"
      : status === "loading"
        ? "loading"
        : "ready";
  const statusText = range
    ? pinned
      ? "已钉住"
      : "自动跟随选区"
    : status === "error"
      ? "打开失败"
      : status === "loading"
        ? "正在打开"
        : "未附带区域";

  return (
    <div
      className="em-workbook-context"
      role="group"
      data-workbook-context={displayPath}
      data-context-state={contextState}
      aria-label={range ? `本次附带：${label}` : `当前打开：${label}，未附带区域`}
    >
      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="em-workbook-context-label"
            title={`${displayPath}${range ? ` · ${range}` : ""}（查看引用详情）`}
          >
            <span className="em-workbook-context-kind">{range ? "本次附带" : "当前打开"}</span>
            <span className="em-workbook-context-file">{fileName(displayPath)}</span>
            {range && <span className="em-workbook-context-range">{range}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-[calc(100vw-24px)] text-xs">
          <p className="break-all font-medium">{displayPath}</p>
          <p className="mt-1 break-all text-muted-foreground">
            {range ? `${range} · ${statusText} · 随本条消息发送` : "当前打开，未附带区域"}
          </p>
          <button
            type="button"
            className="mt-3 text-[var(--em-primary)]"
            onClick={() => {
              setDetailsOpen(false);
              if (context) void focusRange(context.range, { docId: context.docId });
              else setFullView(true);
            }}
          >
            {range ? "打开并定位" : "查看表格"}
          </button>
        </PopoverContent>
      </Popover>
      {range ? (
        <button
          type="button"
          aria-label={pinned ? "取消钉住" : "钉住此区域"}
          title={pinned ? "取消钉住：随选区变化" : "钉住：选区变化后仍附带此区域"}
          className="em-workbook-context-action"
          onClick={() => pinSelection(!pinned)}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      ) : (
        <button
          type="button"
          aria-label="更换表格"
          title="打开另一份表格"
          className="em-workbook-context-action"
          onClick={() => useUIStore.getState().openWorkbookPicker("panel")}
        >
          <ArrowLeftRight className="h-3 w-3" />
          <span className="hidden sm:inline">更换</span>
        </button>
      )}
      <span className="em-workbook-context-status">{statusText}</span>
      {range && (
        <button
          type="button"
          aria-label="不附带此区域"
          title="本条消息不附带区域"
          className="em-workbook-context-action"
          onClick={dismissContext}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function WorkbookConversationWelcome({
  onSuggestion,
}: {
  onSuggestion: (text: string) => void;
}) {
  const { path, sheet } = useWorkbookConversation();
  const workbookName = path ? baseName(path) : "当前工作簿";

  const suggestions: WorkbookSuggestion[] = [
    {
      label: "先了解这张表",
      prompt: "这张表主要记录什么？",
      description: "快速梳理字段、结构和数据含义",
      icon: Table2,
    },
    {
      label: "检查数据质量",
      prompt: "检查这张表是否有重复或缺失的数据",
      description: "找出重复、缺失和格式异常",
      icon: ClipboardCheck,
    },
    {
      label: "汇总关键数据",
      prompt: "帮我汇总这份表格的关键数据",
      description: "提炼指标，给出清晰的结论",
      icon: BarChart3,
    },
    {
      label: "找出值得关注的地方",
      prompt: "找出这份表格中值得关注的异常和趋势",
      description: "发现异常值、变化和潜在趋势",
      icon: Search,
    },
  ];

  return (
    <main className={styles.viewport} data-empty-home="workbook">
      <div className={styles.layout}>
        <section className={styles.hero} aria-labelledby="workbook-welcome-title">
          <div className={styles.heroContent}>
            <h1 id="workbook-welcome-title" className={styles.title}>
              想对这张表做什么？
            </h1>
            {path && (
              <button
                type="button"
                className={styles.workbook}
                onClick={() => setFullView(true)}
                title={`${path}（打开全屏表格）`}
              >
                <FileSpreadsheet size={16} />
                <strong>{workbookName}</strong>
                {sheet && <span>{sheet}</span>}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
        <div className={styles.heading}>
          <h2 id="workbook-task-title">快速开始</h2>
          <p>选中区域，或直接描述需求</p>
        </div>
        <section className={styles.tasks} aria-labelledby="workbook-task-title">
          {suggestions.map(({ label, prompt, description, icon: Icon }) => (
            <button
              type="button"
              key={prompt}
              onClick={() => onSuggestion(prompt)}
              className={styles.card}
              title={description}
            >
              <span className={styles.cardContent}>
                <span className={styles.cardHeader}>
                  <span className={styles.icon}>
                    <Icon />
                  </span>
                  <strong className={styles.label}>{label}</strong>
                </span>
                <span className={styles.copy}>{description}</span>
              </span>
            </button>
          ))}
        </section>
      </div>
    </main>
  );
}

interface WorkbookSuggestion {
  label: string;
  prompt: string;
  description: string;
  icon: LucideIcon;
}
