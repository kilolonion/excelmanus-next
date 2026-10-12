// 表格画布：Univer 1.0.2 实例由活文档快照创建。本端编辑产生的 mutation 经 doc.submit 提交
// （baseRev = 编辑开始时看到的修订），远端修订逐条回放；叠加层显示代理读写、待审批区域与刚提交的改动。

import "@univerjs/preset-sheets-core/lib/index.css";
import { formatRange, isDerivedWorkbookMutation, parseRange } from "@excelmanus/core";
import { axisGroupMutation, sheetObjectsMutation, WorkbookObjects } from "@excelmanus/protocol";
import {
  CommandType,
  ICommandService,
  IUniverInstanceService,
  LifecycleService,
  LifecycleStages,
  type Workbook,
} from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";
import { UniverSheetsDataValidationPlugin } from "@univerjs/sheets-data-validation";
import { UniverSheetsFilterPlugin } from "@univerjs/sheets-filter";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { glassMenuItemClass, glassMenuPanelClass } from "@/components/ui/menu-panel";
import type { ChangeEntry } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { type AskKind, SELECTION_ASKS } from "@/lib/workbook/ask-actions";
import {
  CHANGE_HIGHLIGHT_MS,
  changeDeadline,
  changeHighlightFrame,
  changeHighlights,
} from "@/lib/workbook/change-highlights";
import { EditTracker } from "@/lib/workbook/edit-session";
import { keepEditingRoom, withEditingRoom } from "@/lib/workbook/editing-room";
import { overlayStyles, rgba } from "@/lib/workbook/overlay-colors";
import { pendingWriteTargets } from "@/lib/workbook/pending-writes";
import { dropEditorThemeColor, jadeTheme } from "@/lib/workbook/univer-theme";
import { captureView, isFreshView, restoreView, type ViewState } from "@/lib/workbook/view-state";
import { useChatStore } from "@/stores/chat-store";
import {
  noteManualView,
  registerDocumentEditor,
  reloadDocument,
  setDraftConflict,
  setSelection,
  submitDocumentMutation,
  useWorkbookStore,
} from "@/stores/workbook-store";
import type { SheetApi } from "./FormatToolbar";

export interface OverlayVisibility {
  activity: boolean;
  pending: boolean;
  changed: boolean;
}

type Sheet = NonNullable<ReturnType<FWorkbook["getActiveSheet"]>>;
type PopupProps = { popup: { extraProps?: Record<string, unknown> } };

/** 解析区域并按表格当前尺寸截断（写入可能新增行列）；不在当前表或完全越界返回 null。 */
function clampedRange(sheet: Sheet, key: string) {
  const p = parseRange(key);
  if (p.sheet && p.sheet !== sheet.getSheetName()) return null;
  const maxRow = sheet.getMaxRows();
  const maxCol = sheet.getMaxColumns();
  const r0 = p.startRow - 1;
  const c0 = p.startCol - 1;
  if (r0 >= maxRow || c0 >= maxCol) return null;
  const r1 = Math.min(p.endRow - 1, maxRow - 1);
  const c1 = Math.min(p.endCol - 1, maxCol - 1);
  return sheet.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1);
}

/** 当前文档上待审批写入的目标区域（拟修改），按行拼成稳定键。 */
function usePendingRanges(): string {
  const approvals = useChatStore((s) => s.session.approvals);
  const doc = useWorkbookStore((s) => s.doc);
  return useMemo(() => {
    if (!doc) return "";
    const out: string[] = [];
    for (const approval of Object.values(approvals)) {
      if (approval.status !== "pending") continue;
      const plan = pendingWriteTargets(approval);
      if (!plan) continue;
      if (plan.docId ? plan.docId !== doc.docId : plan.path !== doc.path) continue;
      out.push(...plan.ranges);
    }
    return [...new Set(out)].join("\n");
  }, [approvals, doc]);
}

/** 待审批区域首格的拟写入值：{ 区域: 值 }，序列化为稳定键。 */
function usePendingValues(): string {
  const approvals = useChatStore((s) => s.session.approvals);
  const doc = useWorkbookStore((s) => s.doc);
  return useMemo(() => {
    if (!doc) return "";
    const out: Record<string, unknown> = {};
    for (const approval of Object.values(approvals)) {
      if (approval.status !== "pending") continue;
      const plan = pendingWriteTargets(approval);
      if (!plan) continue;
      if (plan.docId ? plan.docId !== doc.docId : plan.path !== doc.path) continue;
      for (const [r, v] of Object.entries(plan.values)) out[r] = v[0]?.[0] ?? "";
    }
    return JSON.stringify(out);
  }, [approvals, doc]);
}

export interface DocActivity {
  kind: "read" | "write";
  ranges: string[];
  label: string;
}

/** 当前文档上各代理正在进行的活动（含代理名标签）。 */
function useDocActivity(): DocActivity[] {
  const doc = useWorkbookStore((s) => s.doc);
  const live = useChatStore((s) => s.session.live);
  const roster = useChatStore((s) => s.session.roster);
  const raw = useMemo(() => {
    if (!doc) return "";
    const out: { kind: string; ranges: string[]; agent: string }[] = [];
    for (const [agentId, state] of Object.entries(live)) {
      for (const a of state.activity) {
        if (a.docId ? a.docId !== doc.docId : a.path !== doc.path) continue;
        out.push({ kind: a.kind, ranges: a.ranges, agent: agentId });
      }
    }
    return out.length === 0 ? "" : JSON.stringify(out);
  }, [doc, live]);
  return useMemo(() => {
    if (raw === "") return [];
    return (JSON.parse(raw) as { kind: "read" | "write"; ranges: string[]; agent: string }[]).map(
      (a) => {
        const who = a.agent === "main" ? null : (roster[a.agent]?.name ?? a.agent);
        const verb = a.kind === "read" ? "正在读取" : "正在写入";
        return { kind: a.kind, ranges: a.ranges, label: who ? `${who} · ${verb}` : verb };
      },
    );
  }, [raw, roster]);
}

/** 叠加层用的活动：结束后再保留 1.2 秒，让很快的读取也能被看见。 */
export function useActivityOverlay(): DocActivity[] {
  const live = useDocActivity();
  const [shown, setShown] = useState(live);
  useEffect(() => {
    if (live.length > 0) {
      setShown(live);
      return;
    }
    const t = setTimeout(() => setShown([]), 1200);
    return () => clearTimeout(t);
  }, [live]);
  return shown;
}

function ChartPlaceholder({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  return (
    <div
      data-em-chart=""
      className="pointer-events-none flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/90 p-3 text-sm text-foreground"
      style={{ width: Number(p.width ?? 640), height: Number(p.height ?? 360) }}
    >
      <strong>{String(p.title ?? "")}</strong>
      <span>
        {p.type === "image"
          ? "图片（原样保留，表格内暂不显示）"
          : "图表（原样保留，表格内暂不显示）"}
      </span>
      <span className="text-xs text-muted-foreground">{String(p.range ?? "")}</span>
    </div>
  );
}

/** 叠加层角标：计划修改 · 待确认 / 正在读取 / 正在写入。 */
function OverlayTag({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  const kind = String(p.kind);
  return (
    <span
      data-em-overlay=""
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-sans text-[11px] font-medium whitespace-nowrap shadow-xs",
        kind === "pending" &&
          "border-dashed border-[var(--em-gold)] bg-[color-mix(in_srgb,var(--em-gold)_14%,var(--background))] text-[color-mix(in_srgb,var(--em-gold)_70%,var(--foreground))]",
        kind === "reading" &&
          "border-dashed border-[var(--em-cyan)] bg-[color-mix(in_srgb,var(--em-cyan)_10%,var(--background))] text-[var(--em-cyan)]",
        kind === "writing" &&
          "border-[var(--em-cyan)] bg-[color-mix(in_srgb,var(--em-cyan)_12%,var(--background))] text-[var(--em-cyan)]",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {String(p.text ?? "")}
    </span>
  );
}

/** 修改前后对比浮层（拟修改，尚未写入）。 */
function OverlayDiff({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  return (
    <div
      data-em-overlay=""
      className="flex w-56 flex-col gap-1.5 rounded-xl border border-[var(--em-hairline)] bg-popover p-2.5 font-sans text-xs text-foreground shadow-lg"
      role="note"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">{String(p.cell ?? "")}</span>
        <span>拟修改</span>
        {Number(p.total) > 1 && <span>（共 {Number(p.total)} 处）</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-[11px] text-muted-foreground">修改前</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground line-through">
          {String(p.before ?? "")}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-[11px] text-muted-foreground">修改后</span>
        <span className="min-w-0 truncate font-mono font-semibold text-[var(--em-primary)]">
          {String(p.after ?? "")}
        </span>
      </div>
    </div>
  );
}

/** 画布上的右键菜单：只放「交给代理」的动作，不接管 Univer 的编辑命令。 */
function SheetContextMenu({
  enabled,
  onAsk,
  onReference,
  children,
}: {
  enabled: boolean;
  onAsk: (kind: AskKind) => void;
  onReference: () => void;
  children: ReactNode;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const chosen = useRef(false);
  return (
    <DropdownMenu
      open={point !== null && enabled}
      onOpenChange={(open) => !open && setPoint(null)}
      modal={false}
    >
      <div
        className="absolute inset-0"
        onContextMenuCapture={(event) => {
          if (!enabled) return;
          event.preventDefault();
          event.stopPropagation();
          chosen.current = false;
          setPoint({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (enabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setPoint({ x: rect.left + 48, y: rect.top + 48 });
          }
        }}
      >
        {children}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="交给代理"
            tabIndex={-1}
            style={{
              position: "fixed",
              left: point?.x ?? 0,
              top: point?.y ?? 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className={glassMenuPanelClass}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium tracking-wide text-muted-foreground">
            交给代理
          </div>
          <DropdownMenuItem
            className={glassMenuItemClass}
            onSelect={() => {
              chosen.current = true;
              setPoint(null);
              onReference();
            }}
          >
            添加到对话框
          </DropdownMenuItem>
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
          {SELECTION_ASKS.map((action) => (
            <DropdownMenuItem
              key={action.kind}
              className={glassMenuItemClass}
              title={action.title}
              onSelect={() => {
                chosen.current = true;
                setPoint(null);
                onAsk(action.kind);
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  );
}

export function UniverSheet({
  visibility,
  changes,
  onApi,
  onAsk,
  onReference,
}: {
  visibility: OverlayVisibility;
  /** 需要闪烁的近期已提交改动。 */
  changes: ChangeEntry[];
  /** 实例就绪 / 销毁时通知外层（格式工具栏执行命令用）。 */
  onApi: (api: SheetApi | null) => void;
  onAsk: (kind: AskKind) => void;
  onReference: () => void;
}) {
  const doc = useWorkbookStore((s) => s.doc);
  const docId = doc?.docId;
  const snapshot = doc?.snapshot;
  const focus = useWorkbookStore((s) => s.rangeFocus);
  const preview = useWorkbookStore((s) => s.rangePreview);
  const hasSelection = useWorkbookStore(
    (s) => s.selection !== null && s.selection.docId === s.doc?.docId,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SheetApi | null>(null);
  // 快照重读会重建表格实例；销毁前记下位置，重建后接着看
  const viewRef = useRef<ViewState | null>(null);
  const [ready, setReady] = useState(0);
  const [snapshotLoad, setSnapshotLoad] = useState<"loading" | "error" | null>(null);
  // 实例创建时刻：canvas 浮层要等首轮布局完成后才能拿到单元格坐标
  const createdAt = useRef(0);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // 主题切换后重绘叠加层（颜色取自 token）
  const [themeKey, setThemeKey] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const pending = usePendingRanges();
  const pendingValues = usePendingValues();
  const activity = useActivityOverlay();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docId || !snapshot) return;
    const current = useWorkbookStore.getState().doc;
    if (current?.docId === docId && current.snapshotRev < current.rev) {
      // 工作台换了位置（侧栏 ↔ 全屏）或期间有远端修订：先取最新快照再建表
      let alive = true;
      setSnapshotLoad("loading");
      void reloadDocument().catch(() => {
        if (alive) setSnapshotLoad("error");
      });
      return () => {
        alive = false;
      };
    }
    setSnapshotLoad(null);
    const { univer, univerAPI } = createUniver({
      theme: jadeTheme,
      plugins: [
        UniverSheetsConditionalFormattingPlugin,
        UniverSheetsDataValidationPlugin,
        UniverSheetsFilterPlugin,
      ],
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN) },
      presets: [
        // 公式栏与工作表标签用 Univer 自带的；工具栏与右键菜单不开放（只放写回支持的命令）
        UniverSheetsCorePreset({
          container: host,
          header: true,
          toolbar: false,
          formulaBar: true,
          footer: { sheetBar: true, statisticBar: true, menus: false, zoomSlider: true },
          contextMenu: false,
        }),
      ],
    });
    const injector = univer.__getInjector();
    const sheetOf = (unitId: string, sheetId: string) =>
      injector.get(IUniverInstanceService).getUnit<Workbook>(unitId)?.getSheetBySheetId(sheetId);
    injector
      .get(ICommandService)
      .registerCommand(sheetObjectsMutation(CommandType.MUTATION, sheetOf));
    injector.get(ICommandService).registerCommand(axisGroupMutation(CommandType.MUTATION, sheetOf));
    const wb = univerAPI.createWorkbook(withEditingRoom(snapshot));
    // 工作台编辑与代理共用 doc.submit；服务端负责串行化与冲突判定
    wb.setEditable(true);
    const sheetApi: SheetApi = { univer, univerAPI, wb };
    apiRef.current = sheetApi;
    onApi(sheetApi);
    if (import.meta.env.DEV) (window as { __emUniverAPI?: unknown }).__emUniverAPI = univerAPI;
    const chartSub = univerAPI.registerComponent("em-chart-placeholder", ChartPlaceholder as never);
    const tagSub = univerAPI.registerComponent("em-overlay-tag", OverlayTag as never);
    const diffSub = univerAPI.registerComponent("em-overlay-diff", OverlayDiff as never);
    createdAt.current = Date.now();
    setReady((n) => n + 1);
    // 表格跟随应用主题
    const syncTheme = () => {
      const dark = document.documentElement.classList.contains("dark");
      univerAPI.toggleDarkMode(dark);
      setThemeKey(dark);
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributeFilter: ["class"] });
    const sheetSub = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () =>
      setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null),
    );
    // 用户正在编辑单元格时不被跟随打断；同时记下编辑开始时的修订与键入的草稿
    const editing = new EditTracker();
    const editSub = univerAPI.addEvent(univerAPI.Event.SheetEditStarted, (p) => {
      noteManualView();
      editing.start(
        p.worksheet.getSheetId(),
        p.row,
        p.column,
        useWorkbookStore.getState().docSync.rev,
      );
    });
    const changingSub = univerAPI.addEvent(univerAPI.Event.SheetEditChanging, (p) => {
      const text = (p.value as { toPlainText?: () => string } | undefined)?.toPlainText?.();
      if (typeof text === "string") editing.typed(text);
    });
    const editEndSub = univerAPI.addEvent(univerAPI.Event.SheetEditEnded, () => editing.end());
    setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null);
    let applyingRemote = false;
    registerDocumentEditor({
      docId,
      applyRemote: async (mutations, source) => {
        applyingRemote = true;
        try {
          for (const mutation of mutations) {
            const clash = editing.remote(mutation);
            if (clash) setDraftConflict({ docId, ...clash, source });
            const ok = await univerAPI.executeCommand(
              mutation.id,
              keepEditingRoom(wb, mutation.id, mutation.params),
              { fromCollab: true },
            );
            if (!ok) throw new Error(`远端修订无法回放：${mutation.id}`);
          }
        } finally {
          applyingRemote = false;
        }
      },
    });
    const view = viewRef.current;
    viewRef.current = null;
    let disposed = false;
    if (isFreshView(view, docId))
      // 滚动控制器要等首轮渲染完成才可用
      void injector
        .get(LifecycleService)
        .onStage(LifecycleStages.Rendered)
        .then(() => {
          if (!disposed) restoreView(wb, view);
        });
    const commandSub = wb.onCommandExecuted((command, options) => {
      if (applyingRemote || options?.fromCollab || options?.fromChangeset) return;
      if (command.type !== CommandType.MUTATION) return;
      if (isDerivedWorkbookMutation(command)) return;
      const mutation = dropEditorThemeColor({ id: command.id, params: command.params ?? {} });
      submitDocumentMutation(docId, mutation, editing.baseRevFor(mutation));
    });
    // 选区跟随：鼠标、键盘与 activate() 都经 set-selections 操作
    const selectionSub = wb.onCommandExecuted((command) => {
      if (command.id !== "sheet.operation.set-selections") return;
      const sheet = wb.getActiveSheet();
      const sel = sheet?.getSelection()?.getActiveRange()?.getRange();
      if (!sheet || !sel) return;
      setSelection(
        formatRange({
          sheet: sheet.getSheetName(),
          startCol: sel.startColumn + 1,
          startRow: sel.startRow + 1,
          endCol: sel.endColumn + 1,
          endRow: sel.endRow + 1,
        }),
      );
    });
    return () => {
      disposed = true;
      viewRef.current = captureView(docId, wb);
      themeObserver.disconnect();
      chartSub.dispose();
      tagSub.dispose();
      diffSub.dispose();
      commandSub.dispose();
      sheetSub.dispose();
      editSub.dispose();
      changingSub.dispose();
      editEndSub.dispose();
      selectionSub.dispose();
      registerDocumentEditor(null);
      apiRef.current = null;
      onApi(null);
      univer.dispose();
    };
  }, [docId, snapshot, onApi]);

  // 图表与图片：表格内只放占位（原样保留在文件里）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 修订、工作表切换与实例重建时重新挂载
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb) return;
    const disposers: { dispose(): void }[] = [];
    const timer = setTimeout(
      () => {
        const sheet = wb.getActiveSheet();
        if (!sheet) return;
        const data = wb.save().sheets[sheet.getSheetId()];
        const parsed = WorkbookObjects.safeParse(data?.custom?.excelmanusObjects);
        if (!parsed.success) return;
        for (const chart of [
          ...parsed.data.charts,
          ...parsed.data.images.map((image) => ({ ...image, type: "image", range: "" })),
        ]) {
          const range = parseRange(chart.anchor);
          const popup = sheet
            .getRange(range.startRow - 1, range.startCol - 1, 1, 1)
            .attachRangePopup({
              componentKey: "em-chart-placeholder",
              direction: "bottom",
              extraProps: {
                title: chart.title,
                type: chart.type,
                range: chart.range,
                width: chart.width,
                height: chart.height,
              },
            });
          if (popup) disposers.push(popup);
        }
      },
      Math.max(20, 800 - (Date.now() - createdAt.current)),
    );
    return () => {
      clearTimeout(timer);
      for (const d of disposers) d.dispose();
    };
  }, [doc?.rev, activeSheet, ready]);

  // 定位：切到工作表、选中并滚动到区域，短暂高亮
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !focus) return;
    try {
      const parsed = parseRange(focus.range);
      const sheet = parsed.sheet ? wb.getSheetByName(parsed.sheet) : wb.getActiveSheet();
      if (!sheet) return;
      const range = sheet.getRange(
        parsed.startRow - 1,
        parsed.startCol - 1,
        parsed.endRow - parsed.startRow + 1,
        parsed.endCol - parsed.startCol + 1,
      );
      wb.setActiveSheet(sheet);
      range.activate();
      sheet.scrollToCell(parsed.startRow - 1, parsed.startCol - 1);
      const highlight = range.highlight({ fill: rgba("read", 0.14), stroke: rgba("read", 1) });
      const timer = setTimeout(() => highlight.dispose(), 2000);
      return () => {
        clearTimeout(timer);
        highlight.dispose();
      };
    } catch {
      useWorkbookStore.setState({ referenceError: "invalid-range" });
    }
  }, [focus, ready]);

  // 悬停区域引用时的虚线预览
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !preview) return;
    try {
      const parsed = parseRange(preview);
      const sheet = wb.getActiveSheet();
      if (!sheet || (parsed.sheet && sheet.getSheetName() !== parsed.sheet)) return;
      const highlight = sheet
        .getRange(
          parsed.startRow - 1,
          parsed.startCol - 1,
          parsed.endRow - parsed.startRow + 1,
          parsed.endCol - parsed.startCol + 1,
        )
        .highlight({ strokeDash: 4, stroke: rgba("read", 1) });
      return () => highlight.dispose();
    } catch {
      return;
    }
  }, [preview]);

  // 「计划修改」来自待审批记录，批准或拒绝后消失
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    const visiblePending = visibility.pending ? pending : "";
    if (!wb || visiblePending === "") return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const style = overlayStyles().pending;
    for (const key of visiblePending.split("\n")) {
      try {
        const r = clampedRange(sheet, key);
        if (r) disposers.push(r.highlight(style));
      } catch {
        // 引用无法解析时跳过该区域
      }
    }
    // 浮层要等 Univer 首轮布局出单元格坐标后再挂；布局稳定后再重挂一次拿到最终坐标
    let cancelled = false;
    const popups: { dispose(): void }[] = [];
    const values = JSON.parse(pendingValues || "{}") as Record<string, unknown>;
    const firstKey = visiblePending.split("\n")[0] ?? null;
    const attachAll = () => {
      for (const d of popups.splice(0)) d.dispose();
      if (cancelled) return;
      // 文字角标：不只靠颜色区分。数量多时只标前几处，完整列表在审批卡与变更导航
      for (const key of visiblePending.split("\n").slice(0, 3)) {
        try {
          const d = clampedRange(sheet, key)?.attachRangePopup({
            componentKey: "em-overlay-tag",
            direction: "top",
            extraProps: { kind: "pending", text: "计划修改 · 待确认" },
          });
          if (d) popups.push(d);
        } catch {
          // 区域不可见或无法解析时不加角标
        }
      }
      // 修改前后对比：首个待审批区域的首格，原值取自当前表格，新值取自审批参数
      if (firstKey && firstKey in values) {
        try {
          const p = parseRange(firstKey);
          const cellRef = formatRange({
            startCol: p.startCol,
            startRow: p.startRow,
            endCol: p.startCol,
            endRow: p.startRow,
          });
          const cell = clampedRange(sheet, p.sheet ? `${p.sheet}!${cellRef}` : cellRef);
          if (cell) {
            const before = cell.getValue();
            const d = cell.attachPopup({
              componentKey: "em-overlay-diff",
              direction: "right",
              extraProps: {
                cell: cellRef,
                before:
                  before === null || before === undefined || before === ""
                    ? "（空）"
                    : String(before),
                after: String(values[firstKey] ?? ""),
                total: visiblePending.split("\n").length,
              },
            });
            if (d) popups.push(d);
          }
        } catch {
          // 对比浮层失败不影响审批
        }
      }
    };
    const firstDelay = Math.max(60, createdAt.current + 800 - Date.now());
    const attachTimer = setTimeout(attachAll, firstDelay);
    const reattachTimer = setTimeout(attachAll, firstDelay + 700);
    return () => {
      cancelled = true;
      clearTimeout(attachTimer);
      clearTimeout(reattachTimer);
      for (const d of popups) d.dispose();
      for (const d of disposers) d.dispose();
    };
  }, [pending, pendingValues, activeSheet, ready, themeKey, visibility.pending]);

  // 已提交改动的短时边框：计时绑定提交时间，主题/选区/工作表切换不会重新播放旧改动
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const sheet = apiRef.current?.wb.getActiveSheet();
    if (!sheet || !visibility.changed || changes.length === 0) return;
    const marks = changeHighlights(changes, sheet.getSheetName());
    if (marks.length === 0) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const painted = new Map<string, { signature: string; dispose(): void }>();
    let timer: ReturnType<typeof setTimeout>;
    const draw = () => {
      const now = Date.now();
      let remaining = false;
      let nextDelay = CHANGE_HIGHLIGHT_MS;
      for (const mark of marks) {
        const age = now - (changeDeadline(mark.entry) - CHANGE_HIGHLIGHT_MS);
        const frame = changeHighlightFrame(age, motion.matches);
        const key = `${mark.entry.seq}:${mark.range}`;
        const previous = painted.get(key);
        if (frame.stroke === 0) {
          previous?.dispose();
          painted.delete(key);
          continue;
        }
        remaining = true;
        nextDelay = Math.min(
          nextDelay,
          motion.matches
            ? CHANGE_HIGHLIGHT_MS - age
            : age < 650 || age >= CHANGE_HIGHLIGHT_MS - 900
              ? 40
              : CHANGE_HIGHLIGHT_MS - 900 - age,
        );
        const signature = JSON.stringify(frame);
        if (previous?.signature === signature) continue;
        previous?.dispose();
        painted.delete(key);
        try {
          const range = clampedRange(sheet, mark.range);
          if (range) {
            const shape = range.highlight({
              fill: rgba("ok", frame.fill),
              stroke: rgba("ok", frame.stroke),
              strokeWidth: frame.width,
            });
            painted.set(key, { signature, dispose: () => shape.dispose() });
          }
        } catch {
          // 无法定位时保留导航，不扩展网格
        }
      }
      if (remaining) timer = setTimeout(draw, Math.max(1, nextDelay));
    };
    const onMotionChange = () => {
      clearTimeout(timer);
      draw();
    };
    motion.addEventListener("change", onMotionChange);
    draw();
    return () => {
      clearTimeout(timer);
      motion.removeEventListener("change", onMotionChange);
      for (const shape of painted.values()) shape.dispose();
    };
  }, [changes, activeSheet, ready, themeKey, visibility.changed]);

  // 「正在读取 / 正在写入」：来自 workbook_activity 瞬时增量，结束后淡出
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !visibility.activity || activity.length === 0) return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const styles = overlayStyles();
    let tagged = false;
    for (const a of activity) {
      for (const key of a.ranges) {
        try {
          const r = clampedRange(sheet, key);
          if (!r) continue;
          disposers.push(r.highlight(a.kind === "read" ? styles.reading : styles.writing));
          if (!tagged) {
            const d = r.attachRangePopup({
              componentKey: "em-overlay-tag",
              direction: "top",
              extraProps: { kind: a.kind === "read" ? "reading" : "writing", text: a.label },
            });
            if (d) disposers.push(d);
            tagged = true;
          }
        } catch {
          // 区域不在当前表或无法解析
        }
      }
    }
    return () => {
      for (const d of disposers) d.dispose();
    };
  }, [activity, activeSheet, ready, themeKey, visibility.activity]);

  return (
    <SheetContextMenu
      enabled={hasSelection && snapshotLoad === null}
      onAsk={onAsk}
      onReference={onReference}
    >
      <div className="univer-host absolute inset-0" ref={hostRef} />
      {snapshotLoad !== null && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background">
          {snapshotLoad === "error" ? (
            <div
              className="flex flex-col items-center gap-3 text-sm text-muted-foreground"
              role="alert"
            >
              表格内容读取失败
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSnapshotLoad("loading");
                  void reloadDocument().catch(() => setSnapshotLoad("error"));
                }}
              >
                重新读取
              </Button>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取最新内容…
            </span>
          )}
        </div>
      )}
    </SheetContextMenu>
  );
}
