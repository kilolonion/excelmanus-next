import { parseRange } from "@excelmanus/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApprovalCard,
  type PendingWriteOperation,
  pendingWriteTargets,
  type QuestionCard,
  type TodoItem,
} from "../reduce.ts";
import { answerQuestion, decideApproval, focusRange, openWorkspaceFile, useApp } from "../store.ts";
import { S, toolTitle, UI } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { Checkbox, RadioGroup, RadioGroupItem } from "./ui/controls.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Alert, Badge, Card, RangeChip, statusTone } from "./ui/display.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input, Textarea } from "./ui/input.tsx";
import { Disclosure, ScrollArea } from "./ui/overlay.tsx";
import { Tip } from "./ui/tooltip.tsx";

function cellCount(ranges: string[]): number {
  let n = 0;
  for (const r of ranges) {
    try {
      const p = parseRange(r);
      n += (p.endRow - p.startRow + 1) * (p.endCol - p.startCol + 1);
    } catch {
      // 无法解析的区域不计数
    }
  }
  return n;
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionValue(value: unknown): { value: string; label: string } {
  if (typeof value === "string") return { value, label: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const label = textValue(item.label ?? item.title ?? item.value, S.optionFallback);
    return { value: textValue(item.value, label), label };
  }
  return { value: String(value ?? ""), label: String(value ?? "") };
}

const preCls =
  "max-h-60 overflow-auto rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground-secondary";
const interactionBody = "flex min-w-0 flex-col gap-4 px-4 py-4";
const interactionFooter =
  "interaction-footer sticky bottom-0 z-10 flex min-w-0 shrink-0 items-center justify-end gap-2 rounded-b-lg border-t border-border/70 bg-card/95 px-4 py-3 backdrop-blur-sm";

interface PublishPlanItem {
  path?: unknown;
  kind?: unknown;
  create?: unknown;
  created?: unknown;
  opsCount?: unknown;
  changes?: { ranges?: unknown; cellsBySheet?: unknown; structural?: unknown };
  preview?: unknown;
  bytes?: unknown;
  diffHead?: unknown;
}

type CellPreview = {
  range: string;
  after: unknown[][];
  before?: unknown[][];
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return S.emptyCell;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function sheetFromSnapshot(snapshot: Record<string, unknown>, sheetName?: string) {
  const sheets = snapshot.sheets;
  if (!sheets || typeof sheets !== "object" || Array.isArray(sheets)) return null;
  const entries = Object.entries(sheets as Record<string, unknown>);
  if (sheetName) {
    const hit = entries.find(([id, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      return id === sheetName || (raw as { name?: unknown }).name === sheetName;
    });
    if (hit?.[1] && typeof hit[1] === "object" && !Array.isArray(hit[1]))
      return hit[1] as Record<string, unknown>;
  }
  const first = entries[0]?.[1];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

function snapshotCell(snapshot: Record<string, unknown>, range: string, row: number, col: number) {
  try {
    const parsed = parseRange(range);
    const sheet = sheetFromSnapshot(snapshot, parsed.sheet);
    const cellData = sheet?.cellData;
    if (!cellData || typeof cellData !== "object" || Array.isArray(cellData)) return undefined;
    const rowData = (cellData as Record<string, unknown>)[String(parsed.startRow - 1 + row)];
    if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return undefined;
    const cell = (rowData as Record<string, unknown>)[String(parsed.startCol - 1 + col)];
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) return undefined;
    const data = cell as { f?: unknown; v?: unknown };
    return typeof data.f === "string" ? data.f : data.v;
  } catch {
    return undefined;
  }
}

function cellPreviews(
  plan: ReturnType<typeof pendingWriteTargets>,
  snapshot: Record<string, unknown> | null,
  sameDocument: boolean,
): CellPreview[] {
  if (!plan) return [];
  const out: CellPreview[] = [];
  for (const [range, values] of Object.entries(plan.values).slice(0, 8)) {
    const after = values.slice(0, 6).map((row) => row.slice(0, 8));
    const before =
      snapshot && sameDocument
        ? after.map((row, r) => row.map((_, c) => snapshotCell(snapshot, range, r, c)))
        : undefined;
    out.push({ range, after, ...(before ? { before } : {}) });
  }
  return out;
}

function structuralLabel(op: PendingWriteOperation): string | null {
  const sheet = op.sheet ?? S.currentSheet;
  const at = op.at ?? 1;
  const count = op.count ?? 1;
  switch (op.op) {
    case "rows.insert":
      return S.planInsertRows(sheet, at, count);
    case "rows.delete":
      return S.planDeleteRows(sheet, at, count);
    case "cols.insert":
      return S.planInsertCols(sheet, at, count);
    case "cols.delete":
      return S.planDeleteCols(sheet, at, count);
    case "sheet.add":
      return S.planAddSheet(op.name ?? S.unnamedSheet);
    case "sheet.delete":
      return S.planDeleteSheet(op.sheet ?? S.unknownSheet);
    case "sheet.rename":
      return S.planRenameSheet(op.sheet ?? S.unknownSheet, op.name ?? S.unnamedSheet);
    case "merge":
      return S.planStructuralOp(S.mergeRange, op.range ?? S.unknownRange);
    case "unmerge":
      return S.planStructuralOp(S.unmergeRange, op.range ?? S.unknownRange);
    case "cells.clear":
      return S.planStructuralOp(S.clearContents, op.range ?? S.unknownRange);
    case "style.set":
      return S.planStructuralOp(S.formatChange, op.range ?? S.unknownRange);
    case "freeze":
      return S.planStructuralOp(S.freezePane, sheet);
    case "recalculate":
      return S.recalculateFormula;
    default:
      return null;
  }
}

function WorkbookEditPlan({
  plan,
  snapshot,
  sameDocument,
}: {
  plan: NonNullable<ReturnType<typeof pendingWriteTargets>>;
  snapshot: Record<string, unknown> | null;
  sameDocument: boolean;
}) {
  const structures = plan.operations.map(structuralLabel).filter((x): x is string => x !== null);
  const previews = cellPreviews(plan, snapshot, sameDocument);
  const hasPreview = previews.length > 0;
  return (
    <div className="approval-plan flex min-w-0 flex-col gap-3 border-t border-border/70 pt-3">
      {structures.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-xs font-medium text-foreground-secondary">{S.planStructure}</span>
          <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-foreground-secondary">
            {structures.map((item) => (
              <li key={item} className="flex min-w-0 items-start gap-2">
                <Icon name="pencil" size="xs" className="mt-1 text-muted-foreground" />
                <span className="min-w-0 break-words">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasPreview ? (
        <Disclosure
          summary={S.planValues}
          triggerClassName="text-xs font-medium text-foreground-secondary"
        >
          <div className="flex min-w-0 flex-col gap-4 pt-1">
            {previews.map((item) => (
              <div key={item.range} className="min-w-0">
                <div className="mb-2 font-mono text-xs text-muted-foreground">{item.range}</div>
                <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 text-xs">
                  <span />
                  <span className="border-b border-border pb-2 font-medium text-muted-foreground">
                    {S.planBefore}
                  </span>
                  <span className="border-b border-border pb-2 font-medium text-warn-ink">
                    {S.planAfter}
                  </span>
                  {item.after.slice(0, 6).flatMap((row, r) =>
                    row.slice(0, 8).map((after, c) => {
                      const cell = (() => {
                        try {
                          const parsed = parseRange(item.range);
                          return formatCellRef(parsed.startRow + r, parsed.startCol + c);
                        } catch {
                          return `${r + 1},${c + 1}`;
                        }
                      })();
                      const before = item.before?.[r]?.[c];
                      return (
                        <FragmentValue
                          key={`${item.range}-${cell}`}
                          cell={cell}
                          before={before}
                          after={after}
                          hasBefore={Boolean(item.before)}
                        />
                      );
                    }),
                  )}
                </div>
                {!item.before && (
                  <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {S.planBeforeUnavailable}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Disclosure>
      ) : (
        <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Icon name="info" size="xs" className="mt-0.5" />
          <span>{S.planSummaryOnlyHint}</span>
        </div>
      )}
    </div>
  );
}

function FragmentValue({
  cell,
  before,
  after,
  hasBefore,
}: {
  cell: string;
  before: unknown;
  after: unknown;
  hasBefore: boolean;
}) {
  return (
    <>
      <span className="border-b border-border/60 py-2 font-mono text-2xs text-muted-foreground">
        {cell}
      </span>
      <span className="break-words border-b border-border/60 py-2 font-mono text-foreground-secondary">
        {hasBefore ? displayValue(before) : S.planBeforeUnavailable}
      </span>
      <span className="break-words border-b border-border/60 py-2 font-mono text-foreground">
        {displayValue(after)}
      </span>
    </>
  );
}

function formatCellRef(row: number, col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return `${out}${row}`;
}

/** 发布时审批（08 §6）：run_script 批准卡片渲染待发布文件清单。 */
function PublishPlanList({ items }: { items: PublishPlanItem[] }) {
  return (
    <div className="approval-publish-list flex min-w-0 flex-col divide-y divide-border/70 border-t border-border/70">
      {items.map((it) => {
        const path = String(it.path ?? "");
        const isNew = it.create === true || it.created === true;
        const ranges = Array.isArray(it.changes?.ranges)
          ? (it.changes.ranges as unknown[]).map(String)
          : [];
        const structural = Array.isArray(it.changes?.structural)
          ? (it.changes.structural as unknown[]).map(String)
          : [];
        const preview = Array.isArray(it.preview)
          ? (it.preview as { range?: unknown; values?: unknown }[])
          : [];
        const detail =
          preview.length > 0
            ? preview
                .map(
                  (r) =>
                    `${String(r.range ?? "")}\n${
                      Array.isArray(r.values)
                        ? (r.values as unknown[][])
                            .map((row) => row.map((v) => String(v ?? "")).join("\t"))
                            .join("\n")
                        : ""
                    }`,
                )
                .join("\n")
            : textValue(it.diffHead);
        return (
          <div key={path} className="flex min-w-0 flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-all font-mono text-xs leading-relaxed">{path}</span>
              <Badge tone={isNew ? "ok" : "warn"}>{isNew ? S.planNew : S.planModified}</Badge>
            </div>
            <div className="text-xs leading-relaxed text-muted-foreground">
              {it.kind === "workbook"
                ? [
                    typeof it.opsCount === "number" ? S.planOps(it.opsCount) : "",
                    ranges.slice(0, 5).join("，"),
                    ranges.length > 5 ? `+${ranges.length - 5}` : "",
                    structural.join("，"),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : typeof it.bytes === "number"
                  ? S.planBytes(it.bytes)
                  : ""}
            </div>
            {structural.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {structural.map((item) => (
                  <Badge key={item} tone="neutral">
                    {item}
                  </Badge>
                ))}
              </div>
            )}
            {detail !== "" && (
              <Disclosure summary={S.planPreview}>
                <div className="flex flex-col gap-1">
                  {preview.length > 0 && (
                    <div className="text-xs font-medium text-warn-ink">{S.planAfter}</div>
                  )}
                  <pre className={preCls}>{detail}</pre>
                  {preview.length > 0 && (
                    <div className="text-xs leading-relaxed text-muted-foreground">
                      {S.planBeforeUnavailable}
                    </div>
                  )}
                </div>
              </Disclosure>
            )}
            {detail === "" && (
              <span className="text-xs leading-relaxed text-muted-foreground">
                {S.planSummaryOnlyHint}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 审批/提问卡片标注来源代理名（02 §5）。 */
function AgentTag({ agentId }: { agentId?: string | null }) {
  const roster = useApp((state) => state.session.roster);
  if (agentId === undefined || agentId === null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
      <Icon name="bot" size="xs" />
      {roster[agentId]?.name ?? agentId}
    </span>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-0.5 pt-1">
      <span className="text-xs font-medium text-foreground-secondary">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
    </div>
  );
}

function CardHead({
  icon,
  iconCls,
  title,
  children,
}: {
  icon: "shield" | "info";
  iconCls: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="interaction-heading flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <Icon name={icon} size="md" className={iconCls} />
      <strong className="min-w-0 flex-1 text-sm font-semibold leading-snug">{title}</strong>
      <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

/** 待审批条（02 §4.4、对齐清单 A6）：一行写明改哪里；理由框只在拒绝时展开；自动批准是一个独立决定。 */
function ApprovalBar({ cards }: { cards: ApprovalCard[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const submitting = useRef(false);
  const doc = useApp((state) => state.doc);
  const [busy, setBusy] = useState<string | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const decide = async (card: ApprovalCard, decision: "approve" | "deny", remember = false) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(card.approvalId);
    setError(null);
    try {
      await decideApproval(
        card.approvalId,
        decision,
        decision === "deny" ? reason[card.approvalId] : undefined,
        remember,
      );
      setDenying(null);
      setExpanded(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.interactionFailed);
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <GroupHeading label={S.pendingApprovals} count={cards.length} />
      {cards.map((card) => {
        const plan = pendingWriteTargets(card);
        const publish = (card.args as { publishPlan?: unknown } | undefined)?.publishPlan;
        const preview = () =>
          plan && plan.ranges.length > 0
            ? void (plan.path ? openWorkspaceFile(plan.path) : Promise.resolve())
                .then(() => focusRange(plan.ranges[0] as string))
                .catch(() => undefined)
            : undefined;
        const isDenying = denying === card.approvalId;
        const content = (
          <Card
            className="approval-card flex min-w-0 flex-col border-warn/25"
            key={card.approvalId}
          >
            <div className={interactionBody}>
              <CardHead
                icon="shield"
                iconCls="text-warn"
                title={S.approvalRequest(toolTitle(card.toolName))}
              >
                <AgentTag agentId={card.agentId} />
                <Badge tone="warn">{S.effectLabel(card.effect)}</Badge>
              </CardHead>
              {plan && plan.ranges.length > 0 ? (
                <div className="approval-target flex min-w-0 flex-col gap-2.5">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{S.approvalTarget}</span>
                      <span className="break-all text-sm font-medium leading-relaxed text-foreground">
                        {plan.path ?? card.targets[0] ?? ""}
                      </span>
                    </div>
                    <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                      {S.changeCells(cellCount(plan.ranges))}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {plan.ranges.map((r) => (
                      <Tip key={r} content={S.locate}>
                        <RangeChip
                          range={r}
                          tone="pending"
                          onClick={() =>
                            void (plan.path ? openWorkspaceFile(plan.path) : Promise.resolve())
                              .then(() => focusRange(r))
                              .catch(() => undefined)
                          }
                        />
                      </Tip>
                    ))}
                  </div>
                </div>
              ) : (
                card.targets.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {card.targets.map((t) => (
                      <RangeChip key={t} range={t} tone="pending" />
                    ))}
                  </div>
                )
              )}
              {plan && (
                <WorkbookEditPlan
                  plan={plan}
                  snapshot={doc && (!plan.docId || plan.docId === doc.docId) ? doc.snapshot : null}
                  sameDocument={Boolean(doc && (!plan.docId || plan.docId === doc.docId))}
                />
              )}
              {Array.isArray(publish) ? (
                <PublishPlanList items={publish as PublishPlanItem[]} />
              ) : (
                card.args !== undefined && (
                  <Disclosure summary={S.viewDetails}>
                    <pre className={preCls}>{safeJson(card.args)}</pre>
                  </Disclosure>
                )
              )}
              {isDenying && (
                <Textarea
                  rows={2}
                  aria-label={S.approvalReason}
                  autoFocus
                  value={reason[card.approvalId] ?? ""}
                  placeholder={S.approvalReason}
                  onChange={(event) =>
                    setReason({ ...reason, [card.approvalId]: event.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setDenying(null);
                  }}
                />
              )}
              {error && (
                <Alert layout="inline" tone="err">
                  {error}
                </Alert>
              )}
            </div>
            <div className={interactionFooter}>
              {isDenying ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setDenying(null)}
                  >
                    {S.cancel}
                  </Button>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() => void decide(card, "deny")}
                  >
                    {busy === card.approvalId ? S.submitting : S.confirmDeny}
                  </Button>
                </>
              ) : (
                <>
                  <DropdownMenu>
                    <Tip content={S.approvalActions}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={S.approvalActions}
                          disabled={busy !== null}
                        >
                          <Icon name="more" size="sm" />
                        </Button>
                      </DropdownMenuTrigger>
                    </Tip>
                    <DropdownMenuContent align="start" side="top" className="w-72">
                      {plan && plan.ranges.length > 0 && (
                        <>
                          <DropdownMenuItem onSelect={preview}>
                            <Icon name="target" size="sm" className="text-muted-foreground" />
                            {S.previewInSheet}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuItem
                        disabled={busy !== null}
                        className="items-start"
                        onSelect={() => void decide(card, "approve", true)}
                      >
                        <Icon
                          name="shieldCheck"
                          size="sm"
                          className="mt-0.5 text-foreground-secondary"
                        />
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="font-medium">{S.rememberApproval}</span>
                          <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                            {S.rememberApprovalHint}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setDenying(card.approvalId)}
                  >
                    {S.deny}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void decide(card, "approve")}
                  >
                    <Icon name="check" size="xs" />
                    {busy === card.approvalId ? S.submitting : S.approve}
                  </Button>
                </>
              )}
            </div>
          </Card>
        );
        return (
          <div key={card.approvalId} className="approval-summary">
            <Icon name="shield" size="sm" className="text-warn" />
            <div className="min-w-0 flex-1">
              <strong>{S.approvalRequest(toolTitle(card.toolName))}</strong>
              <p className="truncate text-xs text-muted-foreground">
                {plan?.path ?? card.targets.join(" · ")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setExpanded(card.approvalId);
                preview();
              }}
            >
              {UI.reviewChanges}
            </Button>
            <Dialog
              open={expanded === card.approvalId}
              onOpenChange={(open) => {
                if (!open && busy === null) setExpanded(null);
              }}
            >
              <DialogContent className="change-review-dialog">
                <div className="change-review-heading">
                  <div className="flex items-center justify-between gap-3">
                    <DialogTitle>{UI.confirmChanges}</DialogTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setExpanded(null)}
                    >
                      {S.close}
                    </Button>
                  </div>
                  <DialogDescription>{UI.reviewChangesHint}</DialogDescription>
                </div>
                {content}
              </DialogContent>
            </Dialog>
          </div>
        );
      })}
    </div>
  );
}

const optionRow =
  "flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-transparent bg-muted/60 px-3 py-2.5 text-sm leading-relaxed transition-colors hover:bg-accent/60 has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-accent/60 [&>button]:mt-0.5";

function QuestionCardView({ card }: { card: QuestionCard }) {
  const selection = useApp((state) => state.selection);
  const doc = useApp((state) => state.doc);
  const [value, setValue] = useState("");
  const [values, setValues] = useState<string[]>([]);
  // 区域选取题型没有建议区域，一开始就在框选
  const [picking, setPicking] = useState(
    () =>
      card.questionType === "range_pick" || !textValue(card.spec.suggestedRange ?? card.spec.range),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompt = textValue(
    card.spec.prompt ?? card.spec.question ?? card.spec.note,
    S.questionDefault,
  );
  const suggestedRange = textValue(card.spec.suggestedRange ?? card.spec.range);
  const isRange = card.questionType === "range_confirm" || card.questionType === "range_pick";
  const options = useMemo(
    () => (Array.isArray(card.spec.options) ? card.spec.options.map(optionValue) : []),
    [card.spec.options],
  );

  useEffect(() => {
    if (card.questionType !== "range_confirm" || !suggestedRange || picking) return;
    const path = textValue(card.spec.path);
    if (path) {
      void openWorkspaceFile(path)
        .then(() => focusRange(suggestedRange, textValue(card.spec.docId) || undefined))
        .catch(() => undefined);
    } else {
      void focusRange(suggestedRange, textValue(card.spec.docId) || undefined);
    }
  }, [card.questionType, card.spec.docId, card.spec.path, picking, suggestedRange]);

  const submit = async (answer: unknown, answerRev?: number) => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(card.questionId, answer, answerRev);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.interactionFailed);
    } finally {
      setBusy(false);
    }
  };

  // 02 §4.3：「确认此区域」提交建议区域；「我来重新选择」后提交用户在表格上的选区。答案绑定确认时的修订号。
  const submitRange = () => {
    const selected =
      picking && selection && (!doc || selection.docId === doc.docId) ? selection : null;
    const range = picking ? (selected?.range ?? "") : suggestedRange;
    if (!range) {
      setError(S.selectRangeFirst);
      return;
    }
    const answer = {
      docId: selected?.docId ?? (textValue(card.spec.docId) || doc?.docId),
      range,
    };
    void submit(answer, selected?.rev ?? doc?.rev);
  };

  const multiple = card.spec.multiple === true;

  return (
    <Card className="question-card flex min-w-0 flex-col border-read/20">
      <div className={interactionBody}>
        <CardHead icon="info" iconCls="text-read" title={S.questionTitle}>
          <AgentTag agentId={card.agentId} />
        </CardHead>
        <div className="text-sm leading-relaxed text-foreground">{prompt}</div>
        {card.questionType === "choice" && (
          <div className="flex flex-col gap-1.5">
            {multiple ? (
              options.map((option) => {
                const checked = values.includes(option.value);
                return (
                  // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox 是 label 的子元素
                  <label className={optionRow} key={option.value}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() =>
                        setValues(
                          checked
                            ? values.filter((item) => item !== option.value)
                            : [...values, option.value],
                        )
                      }
                    />
                    <span className="min-w-0 break-words">{option.label}</span>
                  </label>
                );
              })
            ) : (
              <RadioGroup
                value={options.some((o) => o.value === value) ? value : ""}
                onValueChange={setValue}
                aria-label={prompt}
                className="gap-1.5"
              >
                {options.map((option) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: RadioGroupItem 是 label 的子元素
                  <label className={optionRow} key={option.value}>
                    <RadioGroupItem value={option.value} />
                    <span className="min-w-0 break-words">{option.label}</span>
                  </label>
                ))}
              </RadioGroup>
            )}
            {card.spec.allowOther === true && (
              <Input
                value={value}
                aria-label={S.otherOption}
                placeholder={S.otherOption}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </div>
        )}
        {card.questionType === "text" && (
          <Textarea
            rows={3}
            aria-label={prompt}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        {isRange && (
          <>
            {suggestedRange && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{S.suggestedRange}</span>
                <Tip content={S.locate}>
                  <RangeChip
                    range={suggestedRange}
                    tone="pending"
                    onClick={() =>
                      void focusRange(suggestedRange, textValue(card.spec.docId) || undefined)
                    }
                  />
                </Tip>
                {!picking && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPicking(true)}
                    className="ml-auto"
                  >
                    <Icon name="target" size="xs" />
                    {S.pickRange}
                  </Button>
                )}
              </div>
            )}
            {picking && (
              <Alert layout="inline" tone="info" icon="target">
                {S.selectRangeHint}
              </Alert>
            )}
            {picking && selection && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {S.currentSelection}
                <RangeChip range={selection.range} tone="selected" />
                <span className="text-xs text-muted-foreground">{S.revLabel(selection.rev)}</span>
              </div>
            )}
            {doc && (
              <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <Icon name="info" size="xs" className="mt-0.5" />
                {S.rangeBoundRev(picking && selection ? selection.rev : doc.rev)}
              </div>
            )}
          </>
        )}
        {error && (
          <Alert layout="inline" tone="err">
            {error}
          </Alert>
        )}
      </div>
      {(card.questionType === "choice" || card.questionType === "text") && (
        <div className={interactionFooter}>
          <Button
            size="sm"
            disabled={
              busy ||
              (card.questionType === "choice"
                ? multiple
                  ? values.length === 0
                  : value === ""
                : value.trim() === "")
            }
            onClick={() => void submit(card.questionType === "choice" && multiple ? values : value)}
          >
            {busy ? S.submitting : S.submitAnswer}
          </Button>
        </div>
      )}
      {isRange && (
        <div className={interactionFooter}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void submit({ cancelled: true }, doc?.rev)}
          >
            {S.cancel}
          </Button>
          <span className="flex-1" />
          {(picking || card.questionType === "range_confirm") && (
            <Button size="sm" disabled={busy} onClick={submitRange} className="min-w-0">
              <Icon name="check" size="xs" />
              <span className="truncate">
                {busy
                  ? S.submitting
                  : (() => {
                      const r = picking ? selection?.range : suggestedRange;
                      return r ? S.confirmThisRange(r) : S.confirmRange;
                    })()}
              </span>
            </Button>
          )}
        </div>
      )}
      {card.questionType === "change_confirm" && (
        <div className={interactionFooter}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void submit({ decision: "cancel" }, doc?.rev)}
          >
            {S.cancel}
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void submit({ decision: "apply" }, doc?.rev)}
          >
            {S.applyChanges}
          </Button>
        </div>
      )}
    </Card>
  );
}

function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="interaction-todos flex flex-col gap-3 px-0.5 py-3">
      <div className="flex items-center gap-2">
        <Icon name="rules" size="sm" className="text-muted-foreground" />
        <span className="text-sm font-semibold">{S.todos}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => {
          const title = textValue(item.title ?? item.text ?? item.description, item.id);
          const status = textValue(item.status, "pending");
          const done = statusTone(status) === "ok";
          return (
            <li key={item.id} className="flex min-w-0 items-center gap-2 text-sm">
              <Icon
                name={done ? "circleCheck" : "clock"}
                size="xs"
                className={done ? "text-ok" : "text-muted-foreground"}
              />
              <span className={cn("min-w-0 flex-1 truncate", done && "text-muted-foreground")}>
                {title}
              </span>
              <Badge tone={statusTone(status)}>{S.todoStatus(status)}</Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function Interactions() {
  const session = useApp((state) => state.session);
  const agentId = useApp((state) => state.agentId);
  const approvals = session.approvals.filter((item) => item.status === "pending");
  const questions = session.questions.filter((item) => item.status === "pending");
  const todos = session.todos[agentId] ?? [];
  if (approvals.length === 0 && questions.length === 0 && todos.length === 0) return null;
  return (
    <ScrollArea
      className="max-h-[min(38dvh,360px)] shrink-0"
      viewportClassName="max-h-[min(38dvh,360px)] overscroll-contain"
      viewportProps={{ tabIndex: 0, role: "region", "aria-label": S.pendingSummaryHint }}
    >
      <div className="pending-interactions flex flex-col gap-3 p-0.5">
        {approvals.length > 0 && <ApprovalBar cards={approvals} />}
        {questions.length > 0 && (
          <div className="flex flex-col gap-2">
            <GroupHeading label={S.pendingQuestions} count={questions.length} />
            {questions.map((card) => (
              <QuestionCardView card={card} key={card.questionId} />
            ))}
          </div>
        )}
        <TodoPanel items={todos} />
      </div>
    </ScrollArea>
  );
}
