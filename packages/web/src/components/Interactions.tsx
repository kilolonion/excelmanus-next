import { parseRange } from "@excelmanus/core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type ApprovalCard,
  pendingWriteTargets,
  type QuestionCard,
  type TodoItem,
} from "../reduce.ts";
import { answerQuestion, decideApproval, focusRange, openWorkspaceFile, useApp } from "../store.ts";
import { S, toolTitle } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { Checkbox, RadioGroup, RadioGroupItem } from "./ui/controls.tsx";
import { Alert, Badge, Card, RangeChip, statusTone } from "./ui/display.tsx";
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
  "max-h-60 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap text-foreground-secondary";

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

/** 发布时审批（08 §6）：run_script 批准卡片渲染待发布文件清单。 */
function PublishPlanList({ items }: { items: PublishPlanItem[] }) {
  return (
    <div className="flex flex-col gap-1.5">
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
          <Card key={path} className="flex flex-col gap-1 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-xs">{path}</span>
              <Badge tone={isNew ? "ok" : "warn"}>{isNew ? S.planNew : S.planModified}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
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
            {detail !== "" && (
              <Disclosure summary={S.planPreview}>
                <pre className={preCls}>{detail}</pre>
              </Disclosure>
            )}
          </Card>
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
    <Badge tone="neutral">
      <Icon name="bot" size="xs" />
      {roster[agentId]?.name ?? agentId}
    </Badge>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-sm font-semibold">{label}</span>
      <Badge tone="warn">{count}</Badge>
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
    <div className="flex min-w-0 items-center gap-2">
      <Icon name={icon} size="sm" className={iconCls} />
      <strong className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</strong>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

/** 待审批条（02 §4.4、对齐清单 A6）：一行写明改哪里；理由框只在拒绝时展开；自动批准是一个独立决定。 */
function ApprovalBar({ cards }: { cards: ApprovalCard[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const decide = async (card: ApprovalCard, decision: "approve" | "deny", remember = false) => {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : S.interactionFailed);
    } finally {
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
        return (
          <Card
            elevation="raised"
            accent="warn"
            className="flex flex-col gap-2.5 px-4 py-3"
            key={card.approvalId}
          >
            <CardHead
              icon="shield"
              iconCls="text-warn"
              title={S.approvalRequest(toolTitle(card.toolName))}
            >
              <AgentTag agentId={card.agentId} />
              <Badge tone="warn">{S.effectLabel(card.effect)}</Badge>
            </CardHead>
            {plan && plan.ranges.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                <span className="min-w-0 truncate text-foreground-secondary">
                  {S.approvalWrites(plan.path ?? card.targets[0] ?? "")}
                </span>
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
                <span className="text-xs text-muted-foreground">
                  {S.changeCells(cellCount(plan.ranges))}
                </span>
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
                // biome-ignore lint/a11y/noAutofocus: 点「拒绝」后直接填写理由
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
            <div className="flex flex-wrap items-center gap-2">
              {isDenying ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setDenying(null)}>
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
                  {plan && plan.ranges.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={preview}>
                      <Icon name="target" size="xs" />
                      {S.previewInSheet}
                    </Button>
                  )}
                  <span className="flex-1" />
                  <Tip content={S.rememberApprovalHint}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void decide(card, "approve", true)}
                    >
                      {S.rememberApproval}
                    </Button>
                  </Tip>
                  <Button
                    size="sm"
                    variant="destructive-outline"
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
      })}
    </div>
  );
}

const optionRow =
  "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent";

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
    <Card elevation="raised" accent="read" className="flex flex-col gap-2.5 px-4 py-3">
      <CardHead icon="info" iconCls="text-read" title={S.questionTitle}>
        <AgentTag agentId={card.agentId} />
      </CardHead>
      <div className="text-sm">{prompt}</div>
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
                  {option.label}
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
                  {option.label}
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
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || (multiple ? values.length === 0 : value === "")}
              onClick={() => void submit(multiple ? values : value)}
            >
              {busy ? S.submitting : S.submitAnswer}
            </Button>
          </div>
        </div>
      )}
      {card.questionType === "text" && (
        <>
          <Textarea
            rows={3}
            aria-label={prompt}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || value.trim() === ""}
              onClick={() => void submit(value)}
            >
              {busy ? S.submitting : S.submitAnswer}
            </Button>
          </div>
        </>
      )}
      {isRange && (
        <>
          {suggestedRange && (
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-foreground-secondary">
              {S.suggestedRange}
              <Tip content={S.locate}>
                <RangeChip
                  range={suggestedRange}
                  tone="pending"
                  onClick={() =>
                    void focusRange(suggestedRange, textValue(card.spec.docId) || undefined)
                  }
                />
              </Tip>
            </div>
          )}
          {picking && (
            <Alert layout="inline" tone="info" icon="target">
              {S.selectRangeHint}
            </Alert>
          )}
          {picking && selection && (
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-foreground-secondary">
              {S.currentSelection}
              <RangeChip range={selection.range} tone="selected" />
              <span className="text-xs text-muted-foreground">{S.revLabel(selection.rev)}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive-ghost"
              disabled={busy}
              onClick={() => void submit({ cancelled: true }, doc?.rev)}
            >
              {S.cancel}
            </Button>
            <span className="flex-1" />
            {!picking && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPicking(true)}>
                {S.pickRange}
              </Button>
            )}
            {(picking || card.questionType === "range_confirm") && (
              <Button size="sm" disabled={busy} onClick={submitRange}>
                <Icon name="check" size="xs" />
                {busy
                  ? S.submitting
                  : (() => {
                      const r = picking ? selection?.range : suggestedRange;
                      return r ? S.confirmThisRange(r) : S.confirmRange;
                    })()}
              </Button>
            )}
          </div>
          {doc && (
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Icon name="info" size="xs" />
              {S.rangeBoundRev(picking && selection ? selection.rev : doc.rev)}
            </div>
          )}
        </>
      )}
      {card.questionType === "change_confirm" && (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="destructive-ghost"
            disabled={busy}
            onClick={() => void submit({ decision: "cancel" }, doc?.rev)}
          >
            {S.cancel}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void submit({ decision: "apply" }, doc?.rev)}
          >
            {S.applyChanges}
          </Button>
        </div>
      )}
      {error && (
        <Alert layout="inline" tone="err">
          {error}
        </Alert>
      )}
    </Card>
  );
}

function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <Icon name="rules" size="sm" className="text-muted-foreground" />
        <span className="text-sm font-semibold">{S.todos}</span>
        <Badge tone="neutral">{items.length}</Badge>
      </div>
      <ul className="flex flex-col gap-1">
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
    </Card>
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
    <ScrollArea className="max-h-[45vh] shrink-0" viewportClassName="max-h-[45vh]">
      <div className="flex flex-col gap-3 p-0.5">
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
