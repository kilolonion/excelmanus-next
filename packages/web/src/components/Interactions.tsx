import { useEffect, useMemo, useState } from "react";
import type { ApprovalCard, QuestionCard, TodoItem } from "../reduce.ts";
import { answerQuestion, decideApproval, focusRange, openWorkspaceFile, useApp } from "../store.ts";
import { S } from "../strings.ts";

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionValue(value: unknown): { value: string; label: string } {
  if (typeof value === "string") return { value, label: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const label = textValue(item.label ?? item.title ?? item.value, "选项");
    return { value: textValue(item.value, label), label };
  }
  return { value: String(value ?? ""), label: String(value ?? "") };
}

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
    <div className="publish-plan">
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
          <div className="publish-plan-item" key={path}>
            <div className="row-between">
              <span className="small">{path}</span>
              <span className={`badge ${isNew ? "ok" : "pending"}`}>
                {isNew ? S.planNew : S.planModified}
              </span>
            </div>
            <div className="muted small">
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
              <details>
                <summary className="muted small">{S.planPreview}</summary>
                <pre className="interaction-detail">{detail}</pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ApprovalBar({ cards }: { cards: ApprovalCard[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const decide = async (card: ApprovalCard, decision: "approve" | "deny") => {
    setBusy(card.approvalId);
    setError(null);
    try {
      await decideApproval(
        card.approvalId,
        decision,
        reason[card.approvalId],
        remember[card.approvalId] ?? false,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : S.interactionFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="interaction-stack">
      <div className="interaction-heading">
        <strong>{S.pendingApprovals}</strong>
        <span className="badge pending">{cards.length}</span>
      </div>
      {cards.map((card) => (
        <div className="interaction-card approval-card" key={card.approvalId}>
          <div className="row-between">
            <strong>{S.approvalRequest(card.toolName)}</strong>
            <span className="badge pending">{card.effect}</span>
          </div>
          {card.targets.length > 0 && <div className="muted small">{card.targets.join("，")}</div>}
          {(() => {
            const plan = (card.args as { publishPlan?: unknown } | undefined)?.publishPlan;
            if (Array.isArray(plan)) {
              return <PublishPlanList items={plan as PublishPlanItem[]} />;
            }
            return (
              card.args !== undefined && (
                <pre className="interaction-detail">{safeJson(card.args)}</pre>
              )
            );
          })()}
          <textarea
            className="interaction-reason"
            rows={2}
            value={reason[card.approvalId] ?? ""}
            placeholder={S.approvalReason}
            onChange={(event) => setReason({ ...reason, [card.approvalId]: event.target.value })}
          />
          <label className="interaction-check">
            <input
              type="checkbox"
              checked={remember[card.approvalId] ?? false}
              onChange={(event) =>
                setRemember({ ...remember, [card.approvalId]: event.target.checked })
              }
            />
            {S.rememberApproval}
          </label>
          {error && <div className="notice error small">{error}</div>}
          <div className="interaction-actions">
            <button
              type="button"
              className="btn danger"
              disabled={busy !== null}
              onClick={() => void decide(card, "deny")}
            >
              {S.deny}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void decide(card, "approve")}
            >
              {busy === card.approvalId ? S.submitting : S.approve}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function QuestionCardView({ card }: { card: QuestionCard }) {
  const selection = useApp((state) => state.selection);
  const doc = useApp((state) => state.doc);
  const [value, setValue] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
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

  const submitRange = () => {
    const selected = selection && (!doc || selection.docId === doc.docId) ? selection : null;
    const range = selected?.range ?? (picking ? "" : suggestedRange);
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

  return (
    <div className="interaction-card question-card">
      <div className="row-between">
        <strong>{S.questionTitle}</strong>
        {card.agentId && <span className="muted small">{card.agentId}</span>}
      </div>
      <div>{prompt}</div>
      {card.questionType === "choice" && (
        <div className="choice-list">
          {options.map((option) => {
            const multiple = card.spec.multiple === true;
            const checked = values.includes(option.value);
            return (
              <label className="choice-option" key={option.value}>
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={card.questionId}
                  checked={multiple ? checked : value === option.value}
                  onChange={() => {
                    if (multiple) {
                      setValues(
                        checked
                          ? values.filter((item) => item !== option.value)
                          : [...values, option.value],
                      );
                    } else setValue(option.value);
                  }}
                />
                {option.label}
              </label>
            );
          })}
          {card.spec.allowOther === true && (
            <input
              className="interaction-input"
              value={value}
              placeholder={S.otherOption}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy || (card.spec.multiple === true ? values.length === 0 : value === "")}
            onClick={() => void submit(card.spec.multiple === true ? values : value)}
          >
            {busy ? S.submitting : S.submitAnswer}
          </button>
        </div>
      )}
      {card.questionType === "text" && (
        <>
          <textarea
            className="interaction-input"
            rows={3}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busy || value.trim() === ""}
            onClick={() => void submit(value)}
          >
            {busy ? S.submitting : S.submitAnswer}
          </button>
        </>
      )}
      {isRange && (
        <>
          {suggestedRange && (
            <div className="range-suggestion">
              {S.suggestedRange}：{suggestedRange}
            </div>
          )}
          {picking && <div className="notice warn small">{S.selectRangeHint}</div>}
          {selection && (
            <div className="range-suggestion">
              {S.currentSelection}：{selection.range}（rev {selection.rev}）
            </div>
          )}
          <div className="interaction-actions">
            {card.questionType === "range_confirm" && !picking && (
              <button type="button" className="btn" disabled={busy} onClick={submitRange}>
                {S.confirmRange}
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => setPicking(true)}>
              {S.pickRange}
            </button>
            {picking && (
              <button type="button" className="btn primary" disabled={busy} onClick={submitRange}>
                {busy ? S.submitting : S.confirmRange}
              </button>
            )}
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void submit({ cancelled: true }, doc?.rev)}
            >
              {S.cancel}
            </button>
          </div>
        </>
      )}
      {card.questionType === "change_confirm" && (
        <div className="interaction-actions">
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void submit({ decision: "cancel" }, doc?.rev)}
          >
            {S.cancel}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void submit({ decision: "apply" }, doc?.rev)}
          >
            {S.applyChanges}
          </button>
        </div>
      )}
      {error && <div className="notice error small">{error}</div>}
    </div>
  );
}

function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="interaction-card todo-card">
      <div className="interaction-heading">
        <strong>{S.todos}</strong>
        <span className="badge">{items.length}</span>
      </div>
      <ul className="todo-list">
        {items.map((item) => {
          const title = textValue(item.title ?? item.text ?? item.description, item.id);
          const status = textValue(item.status, "pending");
          return (
            <li key={item.id} className={`todo-item ${status}`}>
              <span>{title}</span>
              <span className="badge">{status}</span>
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
  const approvals = session.approvals.filter((item) => item.status === "pending");
  const questions = session.questions.filter((item) => item.status === "pending");
  const todos = session.todos;
  if (approvals.length === 0 && questions.length === 0 && todos.length === 0) return null;
  return (
    <div className="interactions">
      {approvals.length > 0 && <ApprovalBar cards={approvals} />}
      {questions.length > 0 && (
        <div className="interaction-stack">
          <div className="interaction-heading">
            <strong>{S.pendingQuestions}</strong>
            <span className="badge pending">{questions.length}</span>
          </div>
          {questions.map((card) => (
            <QuestionCardView card={card} key={card.questionId} />
          ))}
        </div>
      )}
      <TodoPanel items={todos} />
    </div>
  );
}
