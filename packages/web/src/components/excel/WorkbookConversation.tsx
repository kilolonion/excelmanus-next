// 对话与当前表格的关联：输入框上方的「表格引用」徽标，以及打开表格后的空对话引导页。
// 附带给代理的只有区域上下文（钉住的区域优先，其次当前选区，见 workbook-store.composerContext）。

import { parseRange } from "@excelmanus/core";
import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  ClipboardCheck,
  FileSpreadsheet,
  Lightbulb,
  type LucideIcon,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import { baseName, fileName } from "@/lib/paths";
import { cn } from "@/lib/utils";
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
import styles from "./WorkbookConversation.module.css";

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
  const { path, docId, status, context, pinned } = useWorkbookConversation();
  const open = useWorkbookStore((s) => s.panelOpen || s.fullView);
  if (!path || !open) return null;
  const contextPath = context && context.docId !== docId ? null : path;
  const range = context?.range;
  const label = range ? range : fileName(path);
  const contextState =
    status === "error" ? "error" : status === "loading" ? "loading" : range ? "selection" : "ready";
  const statusText =
    status === "error"
      ? "打开失败"
      : status === "loading"
        ? "正在打开"
        : range
          ? pinned
            ? "已钉住"
            : "当前选区"
          : "未选区域";

  return (
    <div
      className={cn(
        "em-composer-tab text-xs",
        range ? "em-composer-tab--selection" : "em-composer-tab--workbook",
      )}
      data-workbook-context={path}
      data-context-state={contextState}
      aria-label={range ? `本次提问附带区域：${range}` : `当前表格：${fileName(path)}`}
    >
      <span className="em-composer-tab-icon" aria-hidden="true">
        <FileSpreadsheet className="h-3.5 w-3.5" />
      </span>
      <span className="em-composer-tab-copy min-w-0">
        <span className="em-composer-tab-kind">{range ? "选区引用" : "当前表格"}</span>
        <button
          type="button"
          className="em-composer-tab-label min-w-0 truncate text-left font-mono"
          title={
            range ? `${contextPath ?? path} · ${range}（点击定位）` : `${path}（点击全屏查看）`
          }
          onClick={() => (range ? void focusRange(range) : setFullView(true))}
        >
          {label}
        </button>
      </span>
      {range ? (
        <button
          type="button"
          aria-label={pinned ? "取消钉住" : "钉住此区域"}
          title={pinned ? "取消钉住：随选区变化" : "钉住：选区变化后仍附带此区域"}
          className="em-composer-tab-action inline-flex shrink-0 items-center gap-1"
          onClick={() => pinSelection(!pinned)}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          <span className="em-composer-tab-action-label">{pinned ? "取消钉住" : "钉住"}</span>
        </button>
      ) : (
        <button
          type="button"
          aria-label="更换表格"
          title="打开另一份表格"
          className="em-composer-tab-action inline-flex shrink-0 items-center gap-1"
          onClick={() => useUIStore.getState().openWorkbookPicker("panel")}
        >
          <ArrowLeftRight className="h-3 w-3" />
          <span className="em-composer-tab-action-label">更换</span>
        </button>
      )}
      <span className="em-composer-tab-status shrink-0">
        <span className="em-composer-tab-status-dot" aria-hidden="true" />
        {statusText}
      </span>
      {range && (
        <button
          type="button"
          aria-label="不附带此区域"
          title="本条消息不附带区域"
          className="em-composer-tab-dismiss shrink-0"
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
    <main className={styles.page}>
      <section className={styles.hero} aria-labelledby="workbook-welcome-title">
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroContent}>
          <div className={styles.eyebrow}>
            <Sparkles /> 工作簿助手
          </div>
          <h1 id="workbook-welcome-title">
            和这份表格一起，<span>把问题变成结果。</span>
          </h1>
          <p className={styles.heroDescription}>从理解数据开始，快速完成检查、汇总、分析和整理。</p>
          {path && (
            <button
              type="button"
              className={styles.workbookCard}
              onClick={() => setFullView(true)}
              title="打开全屏表格"
            >
              <div className={styles.workbookIcon}>
                <FileSpreadsheet />
              </div>
              <div className={styles.workbookMeta}>
                <strong title={path}>{workbookName}</strong>
                <span>{sheet ? `当前工作表：${sheet}` : "当前工作簿"}</span>
              </div>
              <ArrowRight className={styles.workbookArrow} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={styles.heroPattern} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>

      <section className={styles.tasksSection} aria-labelledby="workbook-task-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionEyebrow}>快速开始</p>
            <h2 id="workbook-task-title">你想先做什么？</h2>
          </div>
          <span>点击即可把任务带入输入框</span>
        </div>
        <div className={styles.taskGrid}>
          {suggestions.map(({ label, prompt, description, icon: Icon }) => (
            <button
              type="button"
              key={prompt}
              onClick={() => onSuggestion(prompt)}
              className={styles.taskCard}
            >
              <span className={styles.taskIcon}>
                <Icon />
              </span>
              <span className={styles.taskCopy}>
                <strong>{label}</strong>
                <span>{description}</span>
              </span>
              <ArrowRight className={styles.taskArrow} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <section className={styles.tipStrip} aria-label="使用提示">
        <div className={styles.tipIcon}>
          <Lightbulb />
        </div>
        <div>
          <strong>让结果更准确</strong>
          <span>可以先选中表格区域，再告诉我你想比较或修改的内容。</span>
        </div>
      </section>

      {path && (
        <p className={styles.discussion}>
          <MessageSquare />
          <span>当前讨论</span>
          <strong title={path}>{workbookName}</strong>
          <button type="button" onClick={() => useUIStore.getState().openWorkbookPicker("panel")}>
            <ArrowLeftRight /> 更换
          </button>
        </p>
      )}
    </main>
  );
}

interface WorkbookSuggestion {
  label: string;
  prompt: string;
  description: string;
  icon: LucideIcon;
}
