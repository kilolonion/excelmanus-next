// 代理的提问，内联在 ask_user 工具卡上直接回答：选择、文本、区域确认、区域选择、改动确认。
// 已回答的提问保留为一问一答的记录。

import {
  Check,
  CheckCircle2,
  Loader2,
  LocateFixed,
  MessageCircleQuestion,
  MousePointerSquareDashed,
  User,
  X,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { errorMessage } from "@/lib/backend/api";
import type { QuestionState, ToolState } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { answerQuestion } from "@/stores/chat-store";
import { focusRange, startRangeQuestion, useWorkbookStore } from "@/stores/workbook-store";

interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function optionOf(raw: unknown): ChoiceOption | null {
  if (typeof raw === "string") return { value: raw, label: raw };
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { value?: unknown; label?: unknown; description?: unknown };
  const label = text(o.label) ?? text(o.value);
  if (!label) return null;
  return {
    value: text(o.value) ?? label,
    label,
    ...(text(o.description) ? { description: text(o.description) } : {}),
  };
}

export function questionPrompt(spec: Record<string, unknown>): string {
  return (
    text(spec.question) ??
    text(spec.prompt) ??
    text(spec.title) ??
    text(spec.note) ??
    "代理需要你的回答"
  );
}

/** 已回答内容的可读形式。 */
function describeAnswer(question: QuestionState, options: ChoiceOption[]): string {
  const answer = question.answer;
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  if (Array.isArray(answer)) return answer.map((v) => labelOf(String(v))).join("、");
  if (typeof answer === "string") return labelOf(answer);
  if (answer && typeof answer === "object") {
    const a = answer as {
      range?: unknown;
      cancelled?: unknown;
      decision?: unknown;
      timeout?: unknown;
    };
    if (a.cancelled === true) return "未选择区域";
    if (a.timeout === true) return "未在时限内回答";
    if (typeof a.range === "string")
      return `确认区域 ${a.range}${question.rev !== undefined ? `（修订 ${question.rev}）` : ""}`;
    if (a.decision === "apply") return "确认应用这些改动";
    if (a.decision === "cancel") return "取消这些改动";
  }
  return "已回答";
}

function ChoiceAnswer({
  question,
  options,
  onSubmit,
  busy,
}: {
  question: QuestionState;
  options: ChoiceOption[];
  onSubmit: (answer: unknown) => void;
  busy: boolean;
}) {
  const multiple = question.spec.multiple === true;
  const allowOther = question.spec.allowOther === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const toggle = (value: string) =>
    setSelected((cur) =>
      multiple
        ? cur.includes(value)
          ? cur.filter((v) => v !== value)
          : [...cur, value]
        : cur[0] === value
          ? []
          : [value],
    );
  const answer = multiple
    ? [...selected, ...(other.trim() ? [other.trim()] : [])]
    : other.trim() || selected[0] || "";
  const ready = multiple ? (answer as string[]).length > 0 : answer !== "";
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const on = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              disabled={busy}
              onClick={() => {
                if (!multiple && !allowOther) {
                  onSubmit(opt.value);
                  return;
                }
                toggle(opt.value);
              }}
              title={opt.description ? `${opt.label}：${opt.description}` : opt.label}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-150 disabled:opacity-60",
                on
                  ? "border-[var(--em-primary)] bg-[color-mix(in_srgb,var(--em-primary)_8%,transparent)] text-[var(--em-primary)] shadow-sm"
                  : "border-transparent bg-background text-foreground/80 hover:border-border hover:text-foreground",
              )}
            >
              {on && <Check className="h-3 w-3 shrink-0" />}
              <span className="min-w-0 truncate">{opt.label}</span>
              {opt.description && (
                <span
                  className={cn(
                    "hidden min-w-0 max-w-40 truncate text-[11px] sm:inline",
                    on ? "text-[var(--em-primary)]/60" : "text-muted-foreground/70",
                  )}
                >
                  {opt.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {(multiple || allowOther) && (
        <div className="flex items-center gap-1.5">
          {allowOther && (
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) onSubmit(answer);
              }}
              placeholder="其他（自行填写）"
              aria-label="其他答案"
              className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-background px-2.5 text-xs outline-none focus:border-[var(--em-primary)] focus:ring-2 focus:ring-[var(--em-primary-alpha-15)]"
            />
          )}
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => onSubmit(answer)}
            className="ml-auto inline-flex h-8 items-center gap-1 rounded-md bg-[var(--em-primary)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            提交
          </button>
        </div>
      )}
    </div>
  );
}

function TextAnswer({ onSubmit, busy }: { onSubmit: (answer: unknown) => void; busy: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div className="mt-2 space-y-1.5">
      <textarea
        autoFocus
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) onSubmit(value.trim());
        }}
        placeholder="输入你的回答（⌘/Ctrl+Enter 提交）"
        aria-label="回答"
        className="w-full resize-none rounded-md border border-transparent bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--em-primary)] focus:ring-2 focus:ring-[var(--em-primary-alpha-15)]"
      />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => onSubmit(value.trim())}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--em-primary)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          提交
        </button>
      </div>
    </div>
  );
}

/** 区域题型：在表格里确认建议区域或拖选新区域；也可以直接在这里确认建议区域。 */
function RangeAnswer({
  question,
  onSubmit,
  busy,
}: {
  question: QuestionState;
  onSubmit: (answer: unknown, rev?: number) => void;
  busy: boolean;
}) {
  const doc = useWorkbookStore((s) => s.doc);
  const active = useWorkbookStore((s) => s.rangeQuestion?.questionId === question.id);
  const suggested = text(question.spec.suggestedRange) ?? text(question.spec.range);
  const docId = text(question.spec.docId);
  const path = text(question.spec.path);
  const open = () =>
    void startRangeQuestion({
      questionId: question.id,
      mode: question.type === "range_pick" ? "pick" : "confirm",
      prompt: questionPrompt(question.spec),
      ...(docId ? { docId } : {}),
      ...(path ? { path } : {}),
      ...(suggested ? { suggested } : {}),
    });
  const sameDoc = doc && (docId ? doc.docId === docId : path ? doc.path === path : true);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {suggested && (
        <button
          type="button"
          onClick={() =>
            void focusRange(suggested, docId ? { docId } : path ? { path } : undefined)
          }
          className="inline-flex h-7 items-center gap-1 rounded-md bg-background px-2 font-mono text-[11px] text-foreground hover:text-[var(--em-primary)]"
          title="在表格中定位建议区域"
        >
          <LocateFixed className="h-3 w-3" />
          {suggested}
        </button>
      )}
      <button
        type="button"
        onClick={open}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors",
          active
            ? "bg-[var(--em-primary-alpha-12)] text-[var(--em-primary)]"
            : "bg-background text-foreground hover:text-[var(--em-primary)]",
        )}
      >
        <MousePointerSquareDashed className="h-3.5 w-3.5" />
        {active
          ? "正在表格中选择…"
          : question.type === "range_pick"
            ? "在表格中选择区域"
            : "在表格中调整"}
      </button>
      <span className="flex-1" />
      <button
        type="button"
        disabled={busy}
        onClick={() => onSubmit({ cancelled: true }, doc?.rev)}
        className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        不选了
      </button>
      {question.type === "range_confirm" && suggested && (
        <button
          type="button"
          disabled={busy || !sameDoc}
          title={sameDoc ? undefined : "先打开对应的表格"}
          onClick={() => doc && onSubmit({ docId: doc.docId, range: suggested }, doc.rev)}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--em-primary)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          确认 {suggested}
        </button>
      )}
    </div>
  );
}

function ChangeConfirmAnswer({
  onSubmit,
  busy,
}: {
  onSubmit: (answer: unknown, rev?: number) => void;
  busy: boolean;
}) {
  const rev = useWorkbookStore((s) => s.doc?.rev);
  return (
    <div className="mt-2 flex items-center justify-end gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => onSubmit({ decision: "cancel" }, rev)}
        className="h-8 rounded-md bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
      >
        取消
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onSubmit({ decision: "apply" }, rev)}
        className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--em-primary)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        应用这些改动
      </button>
    </div>
  );
}

/** 提问的回答区：待回答时可直接作答，回答后显示回答内容。 */
export function QuestionInline({ question }: { question: QuestionState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(
    () =>
      Array.isArray(question.spec.options)
        ? question.spec.options.map(optionOf).filter((o): o is ChoiceOption => o !== null)
        : [],
    [question.spec.options],
  );
  const submit = async (answer: unknown, rev?: number) => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(question.id, answer, rev);
    } catch (err) {
      setError(errorMessage(err, "提交失败，请重试"));
    } finally {
      setBusy(false);
    }
  };
  if (question.status === "answered") {
    return (
      <div className="flex items-start gap-2 px-3 pb-2.5 pt-0.5">
        <User className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-xs break-words whitespace-pre-wrap">
          {describeAnswer(question, options)}
        </p>
      </div>
    );
  }
  return (
    <div className="px-3 pb-2.5">
      {question.type === "choice" && (
        <ChoiceAnswer
          question={question}
          options={options}
          onSubmit={(a) => void submit(a)}
          busy={busy}
        />
      )}
      {question.type === "text" && <TextAnswer onSubmit={(a) => void submit(a)} busy={busy} />}
      {(question.type === "range_confirm" || question.type === "range_pick") && (
        <RangeAnswer question={question} onSubmit={(a, rev) => void submit(a, rev)} busy={busy} />
      )}
      {question.type === "change_confirm" && (
        <ChangeConfirmAnswer onSubmit={(a, rev?: number) => void submit(a, rev)} busy={busy} />
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** ask_user 工具卡：问题 + 内联作答 / 已回答记录。 */
export const AskUserCard = React.memo(function AskUserCard({
  tool,
  question,
}: {
  tool: ToolState;
  question?: QuestionState;
}) {
  const args = (tool.args ?? {}) as { type?: unknown; spec?: Record<string, unknown> };
  const spec = question?.spec ?? args.spec ?? {};
  const prompt = questionPrompt(spec);
  const options = Array.isArray(spec.options)
    ? spec.options.map(optionOf).filter((o): o is ChoiceOption => o !== null)
    : [];
  const pending = question?.status === "pending";
  const answered = question?.status === "answered";
  const failed = tool.phase === "done" && tool.status !== "ok" && !answered;
  return (
    <div
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border-l-2",
        pending
          ? "border-[var(--em-primary)] bg-[var(--em-primary-alpha-06)]"
          : "border-[var(--em-primary-alpha-25)] bg-[var(--em-fill)]",
      )}
      data-tool-call-id={tool.id}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <MessageCircleQuestion
          className="mt-0.5 h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--em-primary)" }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug font-semibold whitespace-pre-wrap text-foreground">
            {prompt}
          </p>
          {!pending && options.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {options.map((opt) => (
                <span
                  key={opt.value}
                  className="inline-flex items-center rounded-md bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {opt.label}
                </span>
              ))}
            </div>
          )}
          {failed && (
            <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">
              {tool.result?.error?.message ?? "提问未能送达"}
            </p>
          )}
        </div>
        <div className="mt-0.5 shrink-0">
          {pending && (
            <span className="rounded-full bg-[var(--em-primary-alpha-10)] px-1.5 py-px text-[10px] font-medium text-[var(--em-primary)]">
              等待回答
            </span>
          )}
          {!question && tool.phase !== "done" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--em-cyan)" }} />
          )}
          {answered && (
            <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--em-primary)" }} />
          )}
          {failed && <X className="h-3.5 w-3.5 text-red-500" />}
        </div>
      </div>
      {question && <QuestionInline question={question} />}
    </div>
  );
});
