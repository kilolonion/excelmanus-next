import { ContextAction } from "./ui/context-action.tsx";
// 表格工作台（02 §2、§4）：文档标题与保存状态、选区栏与「问代理」、Univer 1.0.2 编辑、变更导航。

import { formatRange, isDerivedWorkbookMutation, parseRange } from "@excelmanus/core";
import {
  axisGroupMutation,
  type PresenceParticipant,
  sheetObjectsMutation,
  WorkbookObjects,
} from "@excelmanus/protocol";
import {
  CommandType,
  ICommandService,
  IUniverInstanceService,
  type IWorkbookData,
  type Univer,
  type Workbook,
} from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";
import { UniverSheetsDataValidationPlugin } from "@univerjs/sheets-data-validation";
import { UniverSheetsFilterPlugin } from "@univerjs/sheets-filter";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CHANGE_HIGHLIGHT_MS,
  changeDeadline,
  changeHighlightFrame,
  changeHighlights,
} from "../change-highlights.ts";
import { focusComposer } from "../dom-ids.ts";
import {
  type ChangeEntry,
  changeRanges,
  lastUserSeq,
  latestDocConflict,
  pendingWriteTargets,
} from "../reduce.ts";
import type { OpenDoc } from "../store.ts";
import {
  apiClientOf,
  closeDocument,
  dismissDocConflict,
  focusRange,
  markChangesSeen,
  noteManualView,
  openWorkspaceFile,
  registerDocumentEditor,
  reloadDocument,
  send,
  setFollowAgent,
  setLayout,
  setNarrowTab,
  setSelection,
  submitDocumentMutation,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { useConfirm } from "./ui/confirm.tsx";
import { SegmentedControl, Switch } from "./ui/controls.tsx";
import { Alert, Badge, RangeChip, Separator } from "./ui/display.tsx";
import { Label } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/overlay.tsx";
import { Dots, Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

/** 叠加层语义色取自主题 token；已修改通过短时边框反馈。 */
const FALLBACK = { read: "#4f46e5", ok: "#059669", warn: "#d97706" } as const;

type OverlayVisibility = {
  activity: boolean;
  pending: boolean;
  changed: boolean;
};

const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  activity: true,
  pending: true,
  changed: true,
};
const OVERLAY_VISIBILITY_STORAGE_KEY = "excelmanus.overlayVisibility";

function readOverlayVisibility(): OverlayVisibility {
  if (typeof window === "undefined") return DEFAULT_OVERLAY_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(OVERLAY_VISIBILITY_STORAGE_KEY);
    if (!raw) return DEFAULT_OVERLAY_VISIBILITY;
    const parsed = JSON.parse(raw) as Partial<OverlayVisibility>;
    return {
      activity: parsed.activity !== false,
      pending: parsed.pending !== false,
      changed: parsed.changed !== false,
    };
  } catch {
    return DEFAULT_OVERLAY_VISIBILITY;
  }
}

function useOverlayVisibility() {
  const [visibility, setVisibility] = useState<OverlayVisibility>(readOverlayVisibility);
  useEffect(() => {
    try {
      window.localStorage.setItem(OVERLAY_VISIBILITY_STORAGE_KEY, JSON.stringify(visibility));
    } catch {
      // 本地存储不可用时仍保留当前会话中的显示状态。
    }
  }, [visibility]);
  return [visibility, setVisibility] as const;
}

function tokenRgb(name: keyof typeof FALLBACK): [number, number, number] {
  const raw =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const hex = /^#([0-9a-f]{6})$/i.test(raw) ? raw : FALLBACK[name];
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (name: keyof typeof FALLBACK, a: number) => {
  const [r, g, b] = tokenRgb(name);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
};

function overlayStyles() {
  return {
    reading: { fill: rgba("read", 0.06), stroke: rgba("read", 1), strokeWidth: 1.5, strokeDash: 4 },
    writing: { fill: rgba("read", 0.1), stroke: rgba("read", 1), strokeWidth: 1.5 },
    pending: { fill: rgba("warn", 0.08), stroke: rgba("warn", 1), strokeWidth: 1.5, strokeDash: 5 },
  };
}

function UniverViewer({
  visibility,
  changes,
}: {
  visibility: OverlayVisibility;
  changes: ChangeEntry[];
}) {
  const doc = useApp((s) => s.doc);
  const docId = doc?.docId;
  const snapshot = doc?.snapshot;
  const focus = useApp((s) => s.rangeFocus);
  const preview = useApp((s) => s.rangePreview);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ univer: Univer; wb: FWorkbook } | null>(null);
  const [ready, setReady] = useState(0);
  const [snapshotLoad, setSnapshotLoad] = useState<"loading" | "error" | null>(null);
  // 实例创建时刻：canvas 浮层要等首轮布局完成后才能拿到单元格坐标
  const createdAt = useRef(0);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // 主题切换后重绘叠加层（颜色取自 token）
  const [themeKey, setThemeKey] = useState(() => document.documentElement.dataset.theme ?? "");
  const pending = usePendingRanges();
  const pendingValues = usePendingValues();
  const activity = useActivityOverlay();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docId || !snapshot) return;
    const current = useApp.getState().doc;
    if (current?.docId === docId && current.snapshotRev < current.rev) {
      let alive = true;
      setSnapshotLoad("loading");
      void reloadDocument(docId).catch(() => {
        if (alive) setSnapshotLoad("error");
      });
      return () => {
        alive = false;
      };
    }
    setSnapshotLoad(null);
    const { univer, univerAPI } = createUniver({
      plugins: [
        UniverSheetsConditionalFormattingPlugin,
        UniverSheetsDataValidationPlugin,
        UniverSheetsFilterPlugin,
      ],
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN) },
      presets: [
        // 公式栏与工作表标签由同版本 Univer 提供（16 §2.2）；工具栏/菜单不开放（编辑走同一写入路径）
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
    univer
      .__getInjector()
      .get(ICommandService)
      .registerCommand(
        sheetObjectsMutation(CommandType.MUTATION, (unitId, sheetId) =>
          univer
            .__getInjector()
            .get(IUniverInstanceService)
            .getUnit<Workbook>(unitId)
            ?.getSheetBySheetId(sheetId),
        ),
      );
    univer
      .__getInjector()
      .get(ICommandService)
      .registerCommand(
        axisGroupMutation(CommandType.MUTATION, (unitId, sheetId) =>
          univer
            .__getInjector()
            .get(IUniverInstanceService)
            .getUnit<Workbook>(unitId)
            ?.getSheetBySheetId(sheetId),
        ),
      );
    const wb = univerAPI.createWorkbook(structuredClone(snapshot) as unknown as IWorkbookData);
    // 工作台编辑与代理共用 doc.submit；服务端负责串行化与冲突判定。
    wb.setEditable(true);
    apiRef.current = { univer, wb };
    // 叠加层角标与对比浮层（对齐清单 C1、C2）；组件无状态，只读 popup.extraProps
    const chartSub = univerAPI.registerComponent("em-chart-placeholder", ChartPlaceholder as never);
    const tagSub = univerAPI.registerComponent("em-overlay-tag", OverlayTag as never);
    const diffSub = univerAPI.registerComponent("em-overlay-diff", OverlayDiff as never);
    createdAt.current = Date.now();
    setReady((n) => n + 1);
    // 表格跟随应用主题（深色主题另行验证，16 §2.1）
    const syncTheme = () => {
      univerAPI.toggleDarkMode(document.documentElement.dataset.theme === "dark");
      setThemeKey(document.documentElement.dataset.theme ?? "");
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    const sheetSub = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () =>
      setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null),
    );
    // 用户正在编辑单元格时不被跟随打断（02 §4.8）
    const editSub = univerAPI.addEvent(univerAPI.Event.SheetEditStarted, () => noteManualView());
    setActiveSheet(wb.getActiveSheet()?.getSheetName() ?? null);
    let applyingRemote = false;
    const bridge = {
      docId,
      applyRemote: async (mutations: Array<{ id: string; params: unknown }>) => {
        applyingRemote = true;
        try {
          for (const mutation of mutations) {
            const ok = await univerAPI.executeCommand(
              mutation.id,
              (mutation.params ?? {}) as object,
              { fromCollab: true },
            );
            if (!ok) throw new Error(S.remoteMutationFailed(mutation.id));
          }
        } finally {
          applyingRemote = false;
        }
      },
    };
    registerDocumentEditor(bridge);
    const commandSub = wb.onCommandExecuted((command, options) => {
      if (applyingRemote || options?.fromCollab || options?.fromChangeset) return;
      if (command.type !== CommandType.MUTATION) return;
      if (isDerivedWorkbookMutation(command)) return;
      void submitDocumentMutation(docId, {
        id: command.id,
        params: command.params ?? {},
      });
    });
    // 选区跟随：onSelectionChange 只在鼠标拖选结束时触发；鼠标、键盘与 activate() 都经 set-selections 操作
    const sub = wb.onCommandExecuted((command) => {
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
      themeObserver.disconnect();
      chartSub.dispose();
      tagSub.dispose();
      diffSub.dispose();
      commandSub.dispose();
      sheetSub.dispose();
      editSub.dispose();
      sub.dispose();
      registerDocumentEditor(null);
      apiRef.current = null;
      univer.dispose();
    };
  }, [docId, snapshot]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: imperative engine snapshots change on revision, active-sheet switch and instance readiness
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
      useApp.setState({ referenceError: "invalid-range" });
    }
  }, [focus]);

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

  // 「计划修改」来自待审批记录，批准或拒绝后消失。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    const visiblePending = visibility.pending ? pending : "";
    if (!wb || visiblePending === "") return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const OVERLAY = overlayStyles();
    const rangeOf = (key: string) => clampedRange(sheet, key);
    const paint = (
      keys: string,
      style: ReturnType<typeof overlayStyles>[keyof ReturnType<typeof overlayStyles>],
    ) => {
      if (keys === "") return;
      for (const range of keys.split("\n")) {
        try {
          const r = rangeOf(range);
          if (r) disposers.push(r.highlight(style));
        } catch {
          // 引用无法解析时跳过该区域
        }
      }
    };
    paint(visiblePending, OVERLAY.pending);
    // 文字角标：不只靠颜色区分（16 §2.1）。数量多时只标前几处，完整列表在变更导航与审批条
    const tag = (keys: string, kind: "pending", text: string, limit: number) => {
      if (keys === "") return;
      for (const key of keys.split("\n").slice(0, limit)) {
        try {
          const r = rangeOf(key);
          const d = r?.attachRangePopup({
            componentKey: "em-overlay-tag",
            direction: "top",
            extraProps: { kind, text },
          });
          if (d) popups.push(d);
        } catch {
          // 区域不可见或无法解析时不加角标
        }
      }
    };
    // 浮层要等 Univer 首轮布局出单元格坐标后再挂，否则会落在视口外（新实例 800ms 内延后）
    let cancelled = false;
    // Univer 的 canvas 浮层只在滚动/选区/尺寸变化时重算位置：首挂可能停在视口外，
    // 布局稳定后再重挂一次拿到最终坐标
    const popups: { dispose(): void }[] = [];
    const attachAll = () => {
      for (const d of popups.splice(0)) d.dispose();
      if (cancelled) return;
      tag(visiblePending, "pending", S.overlayPending, 3);
      attachDiff();
    };
    const firstDelay = Math.max(60, createdAt.current + 800 - Date.now());
    const attachTimer = setTimeout(attachAll, firstDelay);
    const reattachTimer = setTimeout(attachAll, firstDelay + 700);
    // 修改前后对比（02 §4.4）：首个待审批区域的首格，原值取自当前表格，新值取自审批参数
    const values = JSON.parse(pendingValues || "{}") as Record<string, unknown>;
    const firstKey = visiblePending === "" ? null : (visiblePending.split("\n")[0] ?? null);
    const attachDiff = () => {
      if (firstKey && firstKey in values) {
        try {
          const p = parseRange(firstKey);
          const cell = rangeOf(
            formatRange({
              ...(p.sheet ? { sheet: p.sheet } : {}),
              startCol: p.startCol,
              startRow: p.startRow,
              endCol: p.startCol,
              endRow: p.startRow,
            }),
          );
          if (cell) {
            const before = cell.getValue();
            const d = cell.attachPopup({
              componentKey: "em-overlay-diff",
              direction: "right",
              extraProps: {
                cell: formatRange({
                  startCol: p.startCol,
                  startRow: p.startRow,
                  endCol: p.startCol,
                  endRow: p.startRow,
                }),
                before:
                  before === null || before === undefined || before === ""
                    ? S.overlayEmpty
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
    return () => {
      cancelled = true;
      clearTimeout(attachTimer);
      clearTimeout(reattachTimer);
      for (const d of popups) d.dispose();
      for (const d of disposers) d.dispose();
    };
  }, [pending, pendingValues, activeSheet, ready, themeKey, visibility.pending]);

  // 每个区域的计时绑定提交时间；主题/选区/工作表切换不会重新播放旧改动。
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
          // 无法定位时保留导航，不扩展网格。
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

  // 「正在读取 / 正在写入」（02 §4.2）：来自 workbook_activity 瞬时增量，结束后淡出（保留 1.2 秒）
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !visibility.activity || activity.length === 0) return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const disposers: { dispose(): void }[] = [];
    const OVERLAY = overlayStyles();
    let tagged = false;
    for (const a of activity) {
      for (const key of a.ranges) {
        try {
          const r = clampedRange(sheet, key);
          if (!r) continue;
          disposers.push(r.highlight(a.kind === "read" ? OVERLAY.reading : OVERLAY.writing));
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
    <>
      <div className="univer-host absolute inset-0" ref={hostRef} />
      {snapshotLoad !== null && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-card">
          {snapshotLoad === "error" ? (
            <div
              className="flex flex-col items-center gap-3 text-sm text-muted-foreground"
              role="alert"
            >
              {S.docLoadFailed}
              <Button
                variant="outline"
                onClick={() => {
                  if (!docId) return;
                  setSnapshotLoad("loading");
                  void reloadDocument(docId).catch(() => setSnapshotLoad("error"));
                }}
              >
                {S.docConflictReload}
              </Button>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner size="sm" />
              {S.workbenchLoading}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** 当前文档上待审批写入的目标区域（拟修改，02 §4.4），按行拼成稳定键。 */
function usePendingRanges(): string {
  return useApp((s) => {
    const doc = s.doc;
    if (!doc) return "";
    const out: string[] = [];
    for (const card of s.session.approvals) {
      if (card.status !== "pending") continue;
      const plan = pendingWriteTargets(card);
      if (!plan) continue;
      if (plan.docId ? plan.docId !== doc.docId : plan.path !== doc.path) continue;
      out.push(...plan.ranges);
    }
    return [...new Set(out)].join("\n");
  });
}

type Sheet = NonNullable<ReturnType<FWorkbook["getActiveSheet"]>>;

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

/** 当前文档上各代理正在进行的活动（含代理名标签）。 */
function useDocActivity(): {
  kind: "read" | "write";
  ranges: string[];
  label: string;
  whole: boolean;
}[] {
  const raw = useApp((s) => {
    const doc = s.doc;
    if (!doc) return "";
    const out: { kind: string; ranges: string[]; agent: string }[] = [];
    for (const [agentId, live] of Object.entries(s.session.live)) {
      for (const a of live.activity) {
        if (a.docId ? a.docId !== doc.docId : a.path !== doc.path) continue;
        out.push({ kind: a.kind, ranges: a.ranges, agent: agentId });
      }
    }
    return out.length === 0 ? "" : JSON.stringify(out);
  });
  const roster = useApp((s) => s.session.roster);
  return useMemo(() => {
    if (raw === "") return [];
    return (JSON.parse(raw) as { kind: "read" | "write"; ranges: string[]; agent: string }[]).map(
      (a) => {
        const who = a.agent === "main" ? null : (roster[a.agent]?.name ?? a.agent);
        const verb = a.kind === "read" ? S.overlayReading : S.overlayWriting;
        return {
          kind: a.kind,
          ranges: a.ranges,
          label: who ? `${who} · ${verb}` : verb,
          whole: a.ranges.length === 0,
        };
      },
    );
  }, [raw, roster]);
}

/** 文档头上的活动提示：整文档读取（没有具体区域）也能看到代理在做什么。 */
function ActivityChip({ visible }: { visible: boolean }) {
  const live = useActivityOverlay();
  const first = live[0];
  if (!visible || !first) return null;
  return (
    <Badge tone="read" role="status">
      <Dots />
      {first.label}
    </Badge>
  );
}

/** 控制表格上的瞬时活动、待审批与已修改叠加层；偏好保存在本机浏览器。 */
function OverlayVisibilityControl({
  visibility,
  onChange,
}: {
  visibility: OverlayVisibility;
  onChange: (next: OverlayVisibility) => void;
}) {
  const set = (key: keyof OverlayVisibility) => (checked: boolean) =>
    onChange({ ...visibility, [key]: checked });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          icon="sliders"
          size="icon-sm"
          label={S.overlayVisibility}
          pressed={!visibility.activity || !visibility.pending || !visibility.changed}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="mb-2">
          <div className="text-xs font-semibold text-foreground">{S.overlayVisibility}</div>
          <p className="mt-0.5 text-2xs text-muted-foreground">{S.overlayVisibilityHint}</p>
        </div>
        <div className="flex flex-col gap-2">
          <OverlayVisibilityToggle
            id="overlay-activity"
            checked={visibility.activity}
            onCheckedChange={set("activity")}
            label={S.overlayShowActivity}
            hint={S.overlayShowActivityHint}
          />
          <OverlayVisibilityToggle
            id="overlay-pending"
            checked={visibility.pending}
            onCheckedChange={set("pending")}
            label={S.overlayShowPending}
            hint={S.overlayShowPendingHint}
          />
          <OverlayVisibilityToggle
            id="overlay-changed"
            checked={visibility.changed}
            onCheckedChange={set("changed")}
            label={S.overlayShowChanged}
            hint={S.overlayShowChangedHint}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OverlayVisibilityToggle({
  id,
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </Label>
        <p className="mt-0.5 text-2xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** 文档头的状态详情：把修订、写回、选区和本轮改动集中到一个可扫描的弹层。 */
function DocumentStatusPopover({
  doc,
  selection,
  changedCount,
}: {
  doc: OpenDoc;
  selection: string | null;
  changedCount: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton icon="info" size="icon-sm" label={S.documentDetails} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs font-semibold text-foreground">{S.documentDetails}</div>
            <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{doc.path}</p>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-muted px-2.5 py-2">
              <dt className="text-2xs text-muted-foreground">{S.revision}</dt>
              <dd className="mt-0.5 font-mono font-medium">{S.revLabel(doc.rev)}</dd>
            </div>
            <div className="rounded-md bg-muted px-2.5 py-2">
              <dt className="text-2xs text-muted-foreground">{S.changesThisTurn}</dt>
              <dd className="mt-0.5 font-mono font-medium">{changedCount}</dd>
            </div>
          </dl>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs">
            <span className="text-muted-foreground">{S.selectedRange}</span>
            <span className="max-w-40 truncate font-mono">{selection ?? S.noSelection}</span>
          </div>
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <Icon name="info" size="xs" />
            {S.documentDetailsHint}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 同一文档上的其他参与者；名称与区域同时显示，避免只依赖选区颜色。 */
function PresenceSummary() {
  const participants = useApp((s) => s.presence);
  const connectionId = useApp((s) => s.presenceConnectionId);
  if (!connectionId) return null;
  const others = participants.filter((p) => p.participantId !== connectionId);
  if (others.length === 0) return null;
  return (
    <div
      className="flex min-w-0 max-w-[36vw] items-center gap-1 overflow-hidden"
      role="status"
      aria-label={S.presenceLabel}
    >
      <span className="shrink-0 text-2xs text-muted-foreground">{S.presenceLabel}</span>
      {others.slice(0, 3).map((participant) => (
        <PresenceBadge key={participant.participantId} participant={participant} />
      ))}
      {others.length > 3 && <Badge tone="outline">{S.presenceMore(others.length - 3)}</Badge>}
    </div>
  );
}

function PresenceBadge({ participant }: { participant: PresenceParticipant }) {
  const location = participant.selection
    ? `${participant.sheet ? `${participant.sheet}!` : ""}${participant.selection}`
    : S.presenceNoSelection;
  return (
    <Tip content={S.presenceAt(participant.name, location)} side="bottom">
      <Badge
        tone="outline"
        className="max-w-44 overflow-hidden"
        style={{ borderColor: `${participant.color}66` }}
        aria-label={S.presenceAt(participant.name, location)}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: participant.color }}
          aria-hidden="true"
        />
        <span className="truncate">{participant.name}</span>
        <span className="max-w-24 truncate font-mono text-2xs text-muted-foreground">
          {location}
        </span>
      </Badge>
    </Tip>
  );
}

/** 叠加层用的活动：结束后再保留 1.2 秒，让很快的读取也能被看见。 */
function useActivityOverlay() {
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

/** 待审批区域首格的拟写入值：{ 区域: 值 }，序列化为稳定键。 */
function usePendingValues(): string {
  return useApp((s) => {
    const doc = s.doc;
    if (!doc) return "";
    const out: Record<string, unknown> = {};
    for (const card of s.session.approvals) {
      if (card.status !== "pending") continue;
      const plan = pendingWriteTargets(card);
      if (!plan) continue;
      if (plan.docId ? plan.docId !== doc.docId : plan.path !== doc.path) continue;
      for (const [r, v] of Object.entries(plan.values)) out[r] = v[0]?.[0] ?? "";
    }
    return JSON.stringify(out);
  });
}

function ChartPlaceholder({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  return (
    <div
      data-em-chart=""
      className="pointer-events-none flex flex-col items-center justify-center gap-2 rounded border border-dashed border-border bg-muted/90 p-3 text-sm"
      style={{ width: Number(p.width ?? 640), height: Number(p.height ?? 360) }}
    >
      <strong>{String(p.title ?? "")}</strong>
      <span>{p.type === "image" ? S.nativeImagePlaceholder : S.nativeChartPlaceholder}</span>
      <span className="text-xs text-muted-foreground">{String(p.range ?? "")}</span>
    </div>
  );
}

type PopupProps = { popup: { extraProps?: Record<string, unknown> } };

/** 叠加层角标：计划修改 · 待确认 / 已修改。 */
function OverlayTag({ popup }: PopupProps) {
  const p = popup.extraProps ?? {};
  const kind = String(p.kind);
  return (
    <span
      data-em-overlay=""
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-xs border px-1.5 font-sans text-2xs font-medium whitespace-nowrap shadow-xs",
        kind === "pending" && "border-dashed border-warn bg-warn-soft text-warn-ink",
        kind === "reading" && "border-dashed border-read bg-read-soft text-read-ink",
        kind === "writing" && "border-read bg-read-soft text-read-ink",
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
      className="flex w-56 flex-col gap-1.5 rounded-lg border border-border bg-popover p-2.5 font-sans text-xs text-foreground shadow-popover"
      role="note"
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="font-mono text-foreground">{String(p.cell ?? "")}</span>
        <span>{S.overlayDiffTitle}</span>
        {Number(p.total) > 1 && <span>{S.overlayDiffMore(Number(p.total))}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-2xs text-muted-foreground">{S.overlayBefore}</span>
        <span className="min-w-0 truncate font-mono text-foreground-secondary line-through">
          {String(p.before ?? "")}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-2xs text-muted-foreground">{S.overlayAfter}</span>
        <span className="min-w-0 truncate font-mono font-semibold text-ok-ink">
          {String(p.after ?? "")}
        </span>
      </div>
    </div>
  );
}

/** 已过期的历史回放不重新闪烁；清除只影响视觉反馈，不删改变更记录。 */
function useRecentChanges(): ChangeEntry[] {
  const key = useApp((s) => {
    const since = Math.max(lastUserSeq(s.session), s.changesSeenSeq);
    return JSON.stringify(
      s.doc
        ? s.session.changes.filter(
            (c) => c.docId === s.doc?.docId && c.seq > since && c.ranges.length > 0,
          )
        : [],
    );
  });
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

function ChangeFeedback({ changes }: { changes: ChangeEntry[] }) {
  const latest = changes.at(-1);
  if (!latest) return null;
  const count = new Set(changes.flatMap((c) => c.ranges)).size;
  const remaining = Math.max(0, changeDeadline(latest) - Date.now());
  return (
    <div
      data-change-feedback=""
      className="change-feedback pointer-events-none absolute bottom-4 left-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-3 overflow-hidden rounded-lg border border-ok/25 bg-card/95 px-3 py-2.5 shadow-md backdrop-blur-sm"
    >
      <span className="change-feedback-check flex size-8 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok-ink">
        <Icon name="check" size="md" />
      </span>
      <div className="min-w-0" role="status" aria-live="polite" aria-atomic="true">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span>{S.changeFeedback(count)}</span>
          {latest.rev !== null && (
            <span className="font-mono text-2xs font-normal text-muted-foreground">
              {S.revLabel(latest.rev)}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-2xs text-muted-foreground">{S.changeFeedbackHint}</p>
      </div>
      <Tip content={S.markSeenHint}>
        <Button
          size="xs"
          variant="ghost"
          onClick={markChangesSeen}
          className="pointer-events-auto ml-1"
        >
          <Icon name="x" size="xs" />
          {S.markSeen}
        </Button>
      </Tip>
      <span
        key={latest.seq}
        aria-hidden="true"
        className="change-feedback-progress pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ok/60"
        style={{ animationDuration: `${remaining}ms` }}
      />
    </div>
  );
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 保存状态（16 §3.3）：文档日志已提交 ≠ xlsx 已写回，按真实阶段表达。 */
function SaveState() {
  const doc = useApp((s) => s.doc);
  const pending = useApp(
    (s) => Object.values(s.docSync.pending).filter((p) => p.status === "pending").length,
  );
  if (!doc) return null;
  if (doc.checkpointError) {
    return (
      <Tip content={doc.checkpointError}>
        <Badge tone="err" tabIndex={0}>
          <Icon name="alert" size="xs" />
          {S.checkpointFailed}
        </Badge>
      </Tip>
    );
  }
  if (pending > 0) {
    return (
      <Badge tone="warn">
        <Spinner size="xs" />
        {S.pendingSubmits(pending)}
      </Badge>
    );
  }
  const saved = doc.checkpointRev !== undefined && doc.checkpointRev >= doc.rev;
  return (
    <Badge tone={saved ? "ok" : "neutral"}>
      <Icon name={saved ? "check" : "clock"} size="xs" />
      {saved ? S.savedToFile : S.savingToFile}
    </Badge>
  );
}

/** doc.submit 被服务端拒绝后的可恢复提示（只读 docSync 中真实冲突，不猜测代理状态）。 */
function DocumentConflictBar({ docId }: { docId: string }) {
  const conflict = useApp((s) => latestDocConflict(s.docSync));
  const [reloading, setReloading] = useState(false);
  if (!conflict) return null;

  const regions = [
    ...new Set(
      conflict.conflicts.flatMap((detail) => detail.cells).filter((cell) => cell.length > 0),
    ),
  ];
  const revisions = [
    ...new Set(
      conflict.conflicts
        .map((detail) => detail.rev)
        .filter((rev): rev is number => typeof rev === "number"),
    ),
  ];
  const reload = async () => {
    setReloading(true);
    try {
      await reloadDocument(docId);
      dismissDocConflict(conflict.clientOpId);
    } catch {
      useApp.setState({ referenceError: "invalid-range" });
    } finally {
      setReloading(false);
    }
  };

  return (
    <Alert layout="bar" tone="warn" role="alert" className="shrink-0">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="font-semibold">{S.docConflictTitle}</strong>
        <span className="font-mono text-2xs">{S.docConflictCode(conflict.code)}</span>
        {revisions.map((rev) => (
          <span key={rev} className="font-mono text-2xs">
            {S.docConflictRevision(rev)}
          </span>
        ))}
        {regions.length > 0 ? (
          <span className="min-w-0 truncate text-2xs">
            {S.docConflictRegions(regions.join("、"))}
          </span>
        ) : (
          <span className="text-2xs">{S.docConflictNoRegion}</span>
        )}
        {conflict.message && <span className="text-2xs">{conflict.message}</span>}
        <span className="text-2xs text-warn-ink/80">{S.docConflictHint}</span>
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" disabled={reloading} onClick={() => void reload()}>
            {reloading ? S.docConflictReloading : S.docConflictReload}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => dismissDocConflict(conflict.clientOpId)}>
            {S.docConflictDismiss}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

/** 变更导航（02 §4.5）：只依据已提交结果（workbook_edit 的 tool.result），逐处定位。 */
function ChangeNav() {
  const doc = useApp((s) => s.doc);
  const session = useApp((s) => s.session);
  const [scope, setScope] = useState<"turn" | "all">("turn");
  const [index, setIndex] = useState(0);
  const since = scope === "turn" ? lastUserSeq(session) : 0;
  const items = useMemo(
    () => (doc ? changeRanges(session, doc.docId, since) : []),
    [session, doc, since],
  );
  // 新改动到达时跳到最新一处
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在条目数变化时重置
  useEffect(() => {
    setIndex(Math.max(0, items.length - 1));
  }, [items.length]);
  if (!doc) return null;
  const cur = items[Math.min(index, items.length - 1)];
  const go = (i: number) => {
    const next = items[i];
    if (!next) return;
    setIndex(i);
    void focusRange(next.range, doc.docId);
  };
  return (
    <nav
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-t border-border bg-muted/45 px-4 py-2 text-xs"
      aria-label={S.changesThisTurn}
    >
      <SegmentedControl
        size="xs"
        value={scope}
        onChange={setScope}
        options={[
          { value: "turn", label: S.changesThisTurn },
          { value: "all", label: S.changesAll },
        ]}
      />
      {items.length === 0 || !cur ? (
        <span className="text-muted-foreground">{S.noChanges}</span>
      ) : (
        <>
          <span className="shrink-0 font-mono whitespace-nowrap text-muted-foreground tabular-nums">
            {S.changePos(index + 1, items.length)}
          </span>
          <span className="flex items-center">
            <IconButton
              icon="chevronLeft"
              size="icon-xs"
              label={S.prevChange}
              disabled={index <= 0}
              onClick={() => go(index - 1)}
            />
            <IconButton
              icon="chevronRight"
              size="icon-xs"
              label={S.nextChange}
              disabled={index >= items.length - 1}
              onClick={() => go(index + 1)}
            />
          </span>
          <Tip content={S.locate}>
            <RangeChip range={cur.range} tone="changed" onClick={() => go(index)} />
          </Tip>
          <span className="min-w-0 truncate whitespace-nowrap text-muted-foreground">
            {cur.entry.rev !== null ? `${S.revLabel(cur.entry.rev)} · ` : ""}
            {S.changeCells(cur.entry.cells)}
            {cur.entry.structural.length > 0 ? ` · ${cur.entry.structural.join("，")}` : ""}
          </span>
          {cur.entry.rev !== null && (
            <BeforeAfter docId={doc.docId} rev={cur.entry.rev} range={cur.range} />
          )}
          {cur.entry.backupPath && <RestoreBackup docPath={doc.path} />}
        </>
      )}
      <span className="flex-1" />
      <FollowToggle />
    </nav>
  );
}

const beforeCache = new Map<
  string,
  Promise<Awaited<ReturnType<ReturnType<typeof apiClientOf>["getDocRevBefore"]>>>
>();

/**
 * 变更导航的"原值 → 新值"（02 §4.5、07 §7.4）：原值来自该修订的逆操作（服务端），
 * 新值取自当前表格快照；显示该区域的首格，区域多于一格时注明。
 */
function BeforeAfter({ docId, rev, range }: { docId: string; rev: number; range: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const currentRev = useApp((s) => (s.doc?.docId === docId ? s.doc.rev : null));
  const [cell, setCell] = useState<{ before: string; after: string; ref: string } | "same" | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    setCell(null);
    let p: ReturnType<typeof parseRange>;
    try {
      p = parseRange(range);
    } catch {
      return;
    }
    const key = `${docId}:${rev}`;
    let req = beforeCache.get(key);
    if (!req) {
      req = apiClientOf().getDocRevBefore(workspaceId, docId, rev);
      beforeCache.set(key, req);
      req.catch(() => beforeCache.delete(key));
    }
    void Promise.all([req, apiClientOf().getDocSnapshot(workspaceId, docId)])
      .then(([res, current]) => {
        if (!alive || current.document.rev < (currentRev ?? 0)) return;
        // 逆操作为空：这次写入的值与原值相同
        if (res.cells.length === 0) {
          setCell("same");
          return;
        }
        const hit = res.cells.find(
          (c) =>
            c.row === p.startRow - 1 &&
            c.col === p.startCol - 1 &&
            (!p.sheet || c.sheet === p.sheet),
        );
        if (!hit) return;
        const sheets =
          (
            current.snapshot as {
              sheets?: Record<
                string,
                { name?: string; cellData?: Record<string, Record<string, { v?: unknown }>> }
              >;
            } | null
          )?.sheets ?? {};
        const sh = Object.values(sheets).find((x) => x.name === hit.sheet);
        const now = sh?.cellData?.[String(hit.row)]?.[String(hit.col)]?.v;
        const show = (v: unknown) =>
          v === null || v === undefined || v === "" ? S.overlayEmpty : String(v);
        setCell({
          before: hit.formula ?? show(hit.value),
          after: show(now),
          ref: formatRange({
            startCol: hit.col + 1,
            startRow: hit.row + 1,
            endCol: hit.col + 1,
            endRow: hit.row + 1,
          }),
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [docId, rev, range, workspaceId, currentRev]);
  if (!cell) return null;
  if (cell === "same")
    return (
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">{S.valuesUnchanged}</span>
    );
  return (
    <Tip content={S.beforeAfterHint}>
      <span
        className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-border bg-muted px-2 font-mono text-2xs"
        tabIndex={-1}
      >
        <span className="text-muted-foreground">{cell.ref}</span>
        <span className="max-w-24 truncate text-foreground-secondary line-through">
          {cell.before}
        </span>
        <Icon name="chevronRight" size="xs" className="text-muted-foreground" />
        <span className="max-w-24 truncate font-semibold text-ok-ink">{cell.after}</span>
      </span>
    </Tip>
  );
}

/**
 * 用备份替换当前文件（02 §4.5、07 §7）：整文件级，二次确认；替换前服务端会先备份当前文件。
 * 只在本会话对该文件确有修改前备份时出现。
 */
function RestoreBackup({ docPath }: { docPath: string }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const confirm = useConfirm();
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const run = async () => {
    const api = apiClientOf();
    const list = await api.listBackups(workspaceId, "backups");
    const latest = list.items
      .filter((b) => b.originalPath === docPath)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    if (!latest) throw new Error(S.noBackupFound);
    const ok = await confirm({
      title: S.restoreDoc,
      description: S.restoreDocConfirm(
        baseName(docPath),
        new Date(latest.createdAt).toLocaleString(),
      ),
      confirmLabel: S.confirmLabels.replace,
      tone: "destructive",
    });
    if (!ok) return false;
    await api.restoreBackup(workspaceId, "backups", latest.id);
    return true;
  };
  return (
    <Tip content={state === "error" ? S.restoreDocFailed : S.restoreDocHint}>
      <Button
        size="xs"
        variant="destructive-ghost"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          void run()
            .then((done) => {
              setState(done ? "done" : "idle");
              if (done) void openWorkspaceFile(docPath);
            })
            .catch(() => setState("error"));
        }}
      >
        <Icon name="restore" size="xs" />
        {state === "done"
          ? S.restoreDocDone
          : state === "error"
            ? S.restoreDocFailed
            : S.restoreDoc}
      </Button>
    </Tip>
  );
}

/** 跟随代理开关（02 §4.8）：代理读写文件时自动打开并滚动到活动区域。 */
function FollowToggle() {
  const on = useApp((s) => s.followAgent);
  return (
    <Tip content={S.followAgentHint}>
      <span className="flex shrink-0 items-center gap-1.5">
        <Switch id="follow-agent" size="sm" checked={on} onCheckedChange={setFollowAgent} />
        <Label htmlFor="follow-agent" className="text-xs">
          {S.followAgent}
        </Label>
      </span>
    </Tip>
  );
}

/** 窄屏表格页底部的迷你输入条（02 §2.2）：沿用「引导」派发策略。 */
function MiniComposer() {
  const [text, setText] = useState("");
  const pendingApprovals = useApp(
    (s) => s.session.approvals.filter((item) => item.status === "pending").length,
  );
  const pendingQuestions = useApp(
    (s) => s.session.questions.filter((item) => item.status === "pending").length,
  );
  const submit = () => {
    const t = text.trim();
    if (t === "") return;
    setText("");
    void send(t).catch(() => setText(t));
    setNarrowTab("chat");
  };
  const hasPending = pendingApprovals > 0 || pendingQuestions > 0;
  return (
    <div className="shrink-0 bg-background">
      {hasPending && (
        <div className="border-t border-border px-3 pt-1">
          <Button
            size="xs"
            variant="ghost"
            className="w-full justify-start text-warn-ink"
            aria-label={S.pendingSummaryHint}
            onClick={() => setNarrowTab("chat")}
          >
            <Icon name="clock" size="xs" />
            {S.pendingSummary(pendingApprovals, pendingQuestions)}
            <Icon name="chevronRight" size="xs" className="ml-auto" />
          </Button>
        </div>
      )}
      <form
        className="flex h-12 items-center gap-2 border-t border-border px-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          value={text}
          placeholder={S.miniComposer}
          aria-label={S.miniComposer}
          onChange={(e) => setText(e.target.value)}
        />
        <IconButton icon="send" variant="default" size="icon" label={S.send} type="submit" />
      </form>
    </div>
  );
}

export function Workbench({
  narrow = false,
  sidebarToggle = false,
}: {
  narrow?: boolean;
  /** 侧栏收起时由最左侧的面板提供展开按钮。 */
  sidebarToggle?: boolean;
}) {
  const doc = useApp((s) => s.doc);
  const [overlayVisibility, setOverlayVisibility] = useOverlayVisibility();
  const recentChanges = useRecentChanges();
  const selection = useApp((s) => s.selection);
  const chatCollapsed = useApp((s) => s.layout.chatCollapsed);
  const changedCount = useApp((s) =>
    s.doc
      ? changeRanges(s.session, s.doc.docId, Math.max(lastUserSeq(s.session), s.changesSeenSeq))
          .length
      : 0,
  );
  if (!doc) return null;
  const sel = selection?.docId === doc.docId ? selection : null;
  return (
    <div className="workbench-panel flex min-h-0 flex-1 flex-col">
      <header className="workbench-header flex h-16 shrink-0 items-center gap-2 border-b border-border/75 bg-card px-4">
        {sidebarToggle && (
          <IconButton
            icon="sidebar"
            label={S.expandSidebar}
            shortcut="B"
            onClick={() => useApp.setState({ sidebarCollapsed: false })}
          />
        )}
        <span className="document-icon flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/70 text-foreground-secondary">
          <Icon name="fileSheet" size="md" />
        </span>
        <div className="document-heading flex min-w-0 flex-1 flex-col gap-1">
          <Tip content={doc.path} side="bottom">
            <h2 className="document-title min-w-0 truncate text-sm font-semibold">
              {baseName(doc.path)}
            </h2>
          </Tip>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="document-revision font-mono text-2xs text-muted-foreground">
              {S.revLabel(doc.rev)}
            </span>
            <span className="document-save">
              <SaveState />
            </span>
          </div>
        </div>
        <DocumentStatusPopover
          doc={doc}
          selection={sel?.range ?? null}
          changedCount={changedCount}
        />
        <ActivityChip visible={overlayVisibility.activity} />
        <PresenceSummary />
        <OverlayVisibilityControl visibility={overlayVisibility} onChange={setOverlayVisibility} />
        {sel && (
          <Tip content={`${sel.range} · ${S.attachSelection}`} side="bottom">
            <Button
              size="sm"
              variant="accent"
              onClick={() => {
                if (narrow) setNarrowTab("chat");
                else if (chatCollapsed) setLayout({ chatCollapsed: false });
                requestAnimationFrame(() => focusComposer());
              }}
            >
              <Icon name="sparkle" size="xs" />
              {S.askAgent}
            </Button>
          </Tip>
        )}
        <Separator orientation="vertical" className="h-5 self-center" />
        {!narrow && (
          <IconButton
            icon={chatCollapsed ? "panelRight" : "expand"}
            label={chatCollapsed ? S.expandChat : S.collapseChat}
            pressed={chatCollapsed}
            onClick={() => setLayout({ chatCollapsed: !chatCollapsed })}
          />
        )}
        <IconButton icon="x" label={S.closeDocument} onClick={closeDocument} />
      </header>
      <DocumentConflictBar docId={doc.docId} />
      <ContextAction
        label={S.askAgent}
        enabled={sel !== null}
        onSelect={() => {
          if (narrow) setNarrowTab("chat");
          else if (chatCollapsed) setLayout({ chatCollapsed: false });
          requestAnimationFrame(() => focusComposer());
        }}
      >
        <div className="relative isolate min-h-0 flex-1 overflow-hidden bg-card">
          <UniverViewer visibility={overlayVisibility} changes={recentChanges} />
          {overlayVisibility.changed && <ChangeFeedback changes={recentChanges} />}
        </div>
      </ContextAction>
      <ChangeNav />
      {narrow && <MiniComposer />}
    </div>
  );
}
