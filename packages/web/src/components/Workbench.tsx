// 表格工作台（02 §2、§4）：文档标题与保存状态、选区栏与「问代理」、Univer 1.0.2 编辑、变更导航。

import { formatRange, parseRange } from "@excelmanus/core";
import { CommandType, type IWorkbookData, type Univer } from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { useEffect, useMemo, useRef, useState } from "react";
import { focusComposer } from "../dom-ids.ts";
import { changeRanges, lastUserSeq, pendingWriteTargets } from "../reduce.ts";
import {
  apiClientOf,
  closeDocument,
  focusRange,
  markChangesSeen,
  noteManualView,
  openWorkspaceFile,
  registerDocumentEditor,
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
import { Badge, RangeChip, Separator } from "./ui/display.tsx";
import { Label } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { Dots, Spinner } from "./ui/spinner.tsx";
import { Tip } from "./ui/tooltip.tsx";

/** 叠加层样式（16 §2.1 语义色，取自主题 token）：已修改 = 绿色底 + 实线，计划修改 = 琥珀虚线。 */
const FALLBACK = { read: "#4f46e5", ok: "#059669", warn: "#d97706" } as const;

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
    changed: { fill: rgba("ok", 0.1), stroke: rgba("ok", 1), strokeWidth: 1 },
    pending: { fill: rgba("warn", 0.08), stroke: rgba("warn", 1), strokeWidth: 1.5, strokeDash: 5 },
  };
}

function UniverViewer() {
  const doc = useApp((s) => s.doc);
  const docId = doc?.docId;
  const snapshot = doc?.snapshot;
  const focus = useApp((s) => s.rangeFocus);
  const preview = useApp((s) => s.rangePreview);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ univer: Univer; wb: FWorkbook } | null>(null);
  const [ready, setReady] = useState(0);
  // 实例创建时刻：canvas 浮层要等首轮布局完成后才能拿到单元格坐标
  const createdAt = useRef(0);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // 主题切换后重绘叠加层（颜色取自 token）
  const [themeKey, setThemeKey] = useState(() => document.documentElement.dataset.theme ?? "");
  const changed = useChangedRanges();
  const pending = usePendingRanges();
  const pendingValues = usePendingValues();
  const activity = useActivityOverlay();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docId || !snapshot) return;
    const { univer, univerAPI } = createUniver({
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
    const wb = univerAPI.createWorkbook(structuredClone(snapshot) as unknown as IWorkbookData);
    // 工作台编辑与代理共用 doc.submit；服务端负责串行化与冲突判定。
    wb.setEditable(true);
    apiRef.current = { univer, wb };
    // 叠加层角标与对比浮层（对齐清单 C1、C2）；组件无状态，只读 popup.extraProps
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

  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !focus) return;
    const parsed = parseRange(focus.range);
    const sheet = parsed.sheet ? wb.getSheetByName(parsed.sheet) : wb.getActiveSheet();
    if (!sheet) return;
    wb.setActiveSheet(sheet);
    const range = sheet.getRange(
      parsed.startRow - 1,
      parsed.startCol - 1,
      parsed.endRow - parsed.startRow + 1,
      parsed.endCol - parsed.startCol + 1,
    );
    range.activate();
    sheet.scrollToCell(parsed.startRow - 1, parsed.startCol - 1);
    const highlight = range.highlight({ fill: rgba("read", 0.14), stroke: rgba("read", 1) });
    const timer = setTimeout(() => highlight.dispose(), 2000);
    return () => {
      clearTimeout(timer);
      highlight.dispose();
    };
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

  // 叠加层（02 §4.2）：「已修改」只依据已提交的 workbook_edit 结果，保留到「已查看」或下一轮；
  // 「计划修改」来自待审批记录（琥珀虚线），批准或拒绝后消失。叠加层不拦截编辑。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || (changed === "" && pending === "")) return;
    const sheet = wb.getActiveSheet();
    if (!sheet) return;
    const name = sheet.getSheetName();
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
    paint(changed, OVERLAY.changed);
    paint(pending, OVERLAY.pending);
    // 文字角标：不只靠颜色区分（16 §2.1）。数量多时只标前几处，完整列表在变更导航与审批条
    const tag = (keys: string, kind: "pending" | "changed", text: string, limit: number) => {
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
      tag(pending, "pending", S.overlayPending, 3);
      tag(changed, "changed", S.overlayChanged, 3);
      attachDiff();
    };
    const firstDelay = Math.max(60, createdAt.current + 800 - Date.now());
    const attachTimer = setTimeout(attachAll, firstDelay);
    const reattachTimer = setTimeout(attachAll, firstDelay + 700);
    // 修改前后对比（02 §4.4）：首个待审批区域的首格，原值取自当前表格，新值取自审批参数
    const values = JSON.parse(pendingValues || "{}") as Record<string, unknown>;
    const firstKey = pending === "" ? null : (pending.split("\n")[0] ?? null);
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
                total: pending.split("\n").length,
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
  }, [changed, pending, pendingValues, activeSheet, ready, themeKey]);

  // 「正在读取 / 正在写入」（02 §4.2）：来自 workbook_activity 瞬时增量，结束后淡出（保留 1.2 秒）
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready 表示 Univer 实例已重建
  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || activity.length === 0) return;
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
  }, [activity, activeSheet, ready, themeKey]);

  return <div className="univer-host absolute inset-0" ref={hostRef} />;
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
function ActivityChip() {
  const live = useActivityOverlay();
  const first = live[0];
  if (!first) return null;
  return (
    <Badge tone="read" role="status">
      <Dots />
      {first.label}
    </Badge>
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
        kind === "changed" && "border-ok/50 bg-ok-soft text-ok-ink",
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

/** 当前文档本轮（且晚于「已查看」）的已提交变更区域，去重后按行拼成稳定键。 */
function useChangedRanges(): string {
  return useApp((s) => {
    if (!s.doc) return "";
    const since = Math.max(lastUserSeq(s.session), s.changesSeenSeq);
    return [...new Set(changeRanges(s.session, s.doc.docId, since).map((c) => c.range))].join("\n");
  });
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
      className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-background px-3 text-xs"
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
  const snapshot = useApp((s) => (s.doc?.docId === docId ? s.doc.snapshot : null));
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
    void req
      .then((res) => {
        if (!alive) return;
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
            snapshot as {
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
  }, [docId, rev, range, workspaceId, snapshot]);
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
  const submit = () => {
    const t = text.trim();
    if (t === "") return;
    setText("");
    void send(t).catch(() => setText(t));
    setNarrowTab("chat");
  };
  return (
    <form
      className="flex h-12 shrink-0 items-center gap-2 border-t border-border bg-background px-3"
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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        {sidebarToggle && (
          <IconButton
            icon="sidebar"
            label={S.expandSidebar}
            shortcut="B"
            onClick={() => useApp.setState({ sidebarCollapsed: false })}
          />
        )}
        <Icon name="fileSheet" size="md" className="text-ok" />
        <Tip content={doc.path} side="bottom">
          <h2 className="min-w-0 truncate text-sm font-semibold">{baseName(doc.path)}</h2>
        </Tip>
        <Badge tone="outline" mono>
          {S.revLabel(doc.rev)}
        </Badge>
        <SaveState />
        <ActivityChip />
        <span className="flex-1" />
        {/* 对齐清单 A9：选区、「已查看」、「问代理」并入文档头，表格多出一行高度 */}
        <Tip content={sel ? S.attachSelection : S.selectedRange} side="bottom">
          <span className="min-w-0" tabIndex={-1}>
            <RangeChip range={sel?.range ?? S.noSelection} tone={sel ? "selected" : "empty"} />
          </span>
        </Tip>
        {changedCount > 0 && (
          <Tip content={S.markSeenHint} side="bottom">
            <Button size="xs" variant="ghost" onClick={markChangesSeen}>
              <span className="size-2.5 rounded-xs border border-ok bg-ok/20" aria-hidden="true" />
              {S.markSeen}
            </Button>
          </Tip>
        )}
        {sel && (
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
      <div className="relative isolate min-h-0 flex-1 overflow-hidden bg-card">
        <UniverViewer />
      </div>
      <ChangeNav />
      {narrow && <MiniComposer />}
    </div>
  );
}
