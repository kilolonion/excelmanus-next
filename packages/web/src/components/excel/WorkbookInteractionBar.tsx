// 表格底部的区域确认条：代理请你确认建议区域（range_confirm）或在表格里选一个区域（range_pick）。
// 答案绑定确认时的修订号；之后表格若有变化，代理需要重新读取。

import { Check, LocateFixed, MousePointerSquareDashed } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/backend/api";
import { answerQuestion } from "@/stores/chat-store";
import { endRangeQuestion, focusRange, useWorkbookStore } from "@/stores/workbook-store";

export function WorkbookInteractionBar() {
  const question = useWorkbookStore((s) => s.rangeQuestion);
  const doc = useWorkbookStore((s) => s.doc);
  const selection = useWorkbookStore((s) =>
    s.selection && s.selection.docId === s.doc?.docId ? s.selection : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!question) return null;
  const sameDoc = !question.docId || question.docId === doc?.docId;
  // 确认题型：用户动过选区就以选区为准，否则确认建议区域
  const chosen = selection?.range ?? (question.mode === "confirm" ? question.suggested : undefined);
  const submit = async (answer: unknown, rev?: number) => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(question.questionId, answer, rev);
      endRangeQuestion(question.questionId);
    } catch (err) {
      setError(errorMessage(err, "提交失败，请重试"));
    } finally {
      setBusy(false);
    }
  };
  const confirm = () => {
    if (!chosen || !doc) {
      setError("请先在表格中选择区域");
      return;
    }
    void submit({ docId: doc.docId, range: chosen }, selection?.rev ?? doc.rev);
  };
  return (
    <div
      className="flex-shrink-0 space-y-1.5 border-t border-[var(--em-line)] bg-background px-3 py-2"
      aria-label="表格区域确认"
    >
      <div className="flex flex-wrap items-center gap-2">
        <LocateFixed className="h-4 w-4 shrink-0 text-[var(--em-cyan)]" />
        <div className="min-w-0 flex-1 text-xs" aria-live="polite">
          <p className="font-medium break-words">{question.prompt}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
            {question.suggested && (
              <button
                type="button"
                onClick={() => question.suggested && void focusRange(question.suggested)}
                className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-[var(--em-gold)] px-1.5 font-mono text-[11px] text-foreground hover:bg-muted"
                title="定位建议区域"
              >
                建议 {question.suggested}
              </button>
            )}
            {selection ? (
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-[var(--em-primary-alpha-10)] px-1.5 font-mono text-[11px] text-[var(--em-primary)]">
                <MousePointerSquareDashed className="h-3 w-3" />
                {selection.range}
              </span>
            ) : (
              <span>
                {question.mode === "pick" ? "拖选单元格后确认" : "可直接确认，或拖选其他区域"}
              </span>
            )}
            {doc && <span className="text-[11px]">· 绑定修订 {selection?.rev ?? doc.rev}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit({ cancelled: true }, doc?.rev)}
            className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            不选了
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => endRangeQuestion(question.questionId)}
            className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="收起确认条，稍后在对话里回答"
          >
            稍后
          </button>
          <button
            type="button"
            disabled={busy || !chosen || !sameDoc}
            onClick={confirm}
            className="inline-flex h-7 items-center gap-1 rounded-md px-3 text-xs font-medium text-white disabled:opacity-40"
            style={{ background: "var(--em-primary)" }}
          >
            <Check className="h-3.5 w-3.5" />
            {busy ? "正在确认…" : chosen ? `确认 ${chosen}` : "确认此区域"}
          </button>
        </div>
      </div>
      {!sameDoc && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          这个提问针对另一份表格，请切回对应的表格再确认。
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
