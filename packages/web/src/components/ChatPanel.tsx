import { useEffect, useRef, useState } from "react";
import { renderMarkdown, renderPlainText } from "../md.ts";
import {
  displayItems,
  queueAhead,
  queuedCount,
  type SessionState,
  type ToolCard,
  type UiMessage,
} from "../reduce.ts";
import {
  cancelDispatch,
  focusRange,
  openDocument,
  previewRange,
  resumeAgent,
  send,
  stopAgent,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";
import { Interactions } from "./Interactions.tsx";

const TOOL_STATUS: Record<ToolCard["status"], string> = {
  pending: S.toolRunning,
  ok: S.toolOk,
  error: S.toolError,
  not_executed: S.toolNotExecuted,
  cancelled: S.toolCancelled,
  uncertain: S.toolUncertain,
};

type DispatchMode = "steer" | "interrupt" | "queue";
const DISPATCH_MODES: { value: DispatchMode; label: string }[] = [
  { value: "steer", label: S.modeSteer },
  { value: "interrupt", label: S.modeInterrupt },
  { value: "queue", label: S.modeQueue },
];

/** 用户消息下方的派发状态文案（02 §3.2）；accepted 不显示。 */
function dispatchLabel(s: SessionState, m: UiMessage): string | null {
  if (m.role !== "user" || m.dispatchStatus === undefined || m.dispatchStatus === "accepted") {
    return null;
  }
  switch (m.dispatchStatus) {
    case "queued":
      if (m.mode === "interrupt") return S.dispatchQueuedInterrupt;
      if (m.mode === "queue") return S.dispatchQueuedQueue(queueAhead(s, m));
      return S.dispatchQueuedSteer;
    case "applied":
      return S.dispatchApplied;
    case "cancelled":
      return S.dispatchCancelled;
    case "failed":
      return S.dispatchFailed;
  }
}

function ToolCardView({ card }: { card: ToolCard }) {
  return (
    <div className={`tool-card ${card.status}`}>
      <div className="tool-head">
        <span className="tool-name">{card.name}</span>
        <span className={`badge ${card.status}`}>{TOOL_STATUS[card.status]}</span>
      </div>
      {card.docId && (
        <button
          type="button"
          className="btn ghost small"
          onClick={() =>
            void openDocument(card.docId as string).catch(() =>
              useApp.setState({ referenceError: "invalid-range" }),
            )
          }
        >
          {S.openWorkbook}
        </button>
      )}
      {card.args !== undefined && card.args !== "" && (
        <div className="tool-args">
          <MessageBody text={card.args} docId={card.docId} plain />
        </div>
      )}
      {card.targets !== undefined && card.targets.length > 0 && (
        <div className="muted small">{card.targets.join("，")}</div>
      )}
      {card.resultSummary !== undefined && (
        <div className="tool-result">
          <MessageBody text={card.resultSummary} docId={card.docId} plain />
        </div>
      )}
    </div>
  );
}

function MessageBody({
  text,
  plain = false,
  docId,
}: {
  text: string;
  plain?: boolean;
  docId?: string;
}) {
  // renderMarkdown 已经 DOMPurify 消毒（见 md.ts），此处输出是受信 HTML
  const html = plain ? renderPlainText(text) : renderMarkdown(text);
  const reference = (target: EventTarget): string | null => {
    const a = target instanceof Element ? target.closest("a") : null;
    const href = a?.getAttribute("href");
    if (!href?.startsWith("#range=")) return null;
    try {
      return decodeURIComponent(href.slice(7));
    } catch {
      return null;
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithMouseEvents: 区域引用链接的事件委托（点击/悬停预览），链接本身非交互元素
    <div
      // HTML 已按白名单消毒（md.ts），经 ref 注入而非 dangerouslySetInnerHTML
      ref={(el) => {
        if (el && el.dataset.html !== html) {
          el.dataset.html = html;
          el.innerHTML = html;
        }
      }}
      className="md"
      role="presentation"
      onClick={(e) => {
        const range = reference(e.target);
        if (range) {
          e.preventDefault();
          void focusRange(range, docId);
        }
      }}
      onKeyDown={(e) => {
        const range = reference(e.target);
        if (e.key === "Enter" && range) {
          e.preventDefault();
          void focusRange(range, docId);
        }
      }}
      onMouseOver={(e) =>
        previewRange(!docId || docId === useApp.getState().doc?.docId ? reference(e.target) : null)
      }
      onMouseLeave={() => previewRange(null)}
    />
  );
}

export function ChatPanel() {
  const session = useApp((s) => s.session);
  const sessionId = useApp((s) => s.sessionId);
  const agentId = useApp((s) => s.agentId);
  const referenceError = useApp((s) => s.referenceError);
  const commandNotice = useApp((s) => s.commandNotice);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<DispatchMode>("steer");
  const [sendFailed, setSendFailed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = displayItems(session);
  const agentRunning =
    (session.agentStatus[agentId] ?? (session.running ? "running" : "idle")) === "running";
  const queued = queuedCount(session, agentId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  });

  const doSend = () => {
    const t = text.trim();
    if (t === "" || sessionId === null) return;
    setText("");
    setSendFailed(false);
    void send(t, mode).catch(() => {
      setSendFailed(true);
      setText((current) => (current === "" ? t : current));
    });
  };

  const recall = (m: UiMessage) => {
    void cancelDispatch(m.id)
      .then(() => setText((current) => (current === "" ? m.text : current)))
      .catch(() => {});
  };

  return (
    <div className="chat">
      <Interactions />
      {sendFailed && <div className="notice error">{S.sendFailed}</div>}
      {commandNotice && <div className="notice">{commandNotice}</div>}
      {referenceError && (
        <div className="notice warn">
          {referenceError === "no-document" ? S.openReferenceFile : S.invalidReference}
        </div>
      )}
      <div className="chat-scroll">
        {items.map((item) =>
          "kind" in item ? (
            <ToolCardView key={`tool-${item.toolCallId}`} card={item} />
          ) : item.role === "compaction" ? (
            <div key={item.id} className="msg compaction">
              <details>
                <summary>
                  {item.compaction
                    ? S.compactBlockLabel(
                        item.compaction.beforeTokens,
                        item.compaction.afterTokens,
                        item.compaction.estimated,
                      )
                    : S.compactDone}
                </summary>
                <MessageBody text={item.text} />
              </details>
            </div>
          ) : (
            <div key={item.id} className={`msg ${item.role}`}>
              <MessageBody text={item.text} />
              {(() => {
                const label = dispatchLabel(session, item);
                const recallable =
                  item.dispatchStatus === "queued" || item.dispatchStatus === "accepted";
                if (label === null && !recallable) return null;
                return (
                  <div className="msg-dispatch">
                    {label !== null && <span className="muted small">{label}</span>}
                    {recallable && (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => recall(item)}
                      >
                        {S.recall}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          ),
        )}
        {session.reasoningText !== "" && (
          <details className="reasoning">
            <summary>{S.thinking}</summary>
            <pre>{session.reasoningText}</pre>
          </details>
        )}
        {session.retry && (
          <div className="notice warn">
            {S.retrying(session.retry.attempt, session.retry.waitMs)}
          </div>
        )}
        {session.error && (
          <div className="notice error">
            <strong>{S.errorGuidance}</strong>
            <div>
              {session.error.kind}: {session.error.message}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {!agentRunning && queued > 0 && (
        <div className="queue-bar">
          <span className="muted small">{S.queuedBanner(queued)}</span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void resumeAgent().catch(() => {})}
          >
            {S.resumeSend}
          </button>
        </div>
      )}
      {!agentRunning && queued === 0 && session.agentStatus[agentId] === "interrupted" && (
        <div className="queue-bar">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void resumeAgent().catch(() => {})}
          >
            {S.resume}
          </button>
        </div>
      )}
      <div className="composer">
        {session.contextUsage !== null && session.contextUsage.window !== null && (
          <span className="muted small context-usage">
            {S.contextUsagePct(
              Math.min(
                100,
                Math.round((session.contextUsage.tokens / session.contextUsage.window) * 100),
              ),
              session.contextUsage.estimated,
            )}
          </span>
        )}
        <textarea
          value={text}
          placeholder={S.composerPlaceholder}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <fieldset className="mode-switch" aria-label={S.dispatchModeLabel}>
          {DISPATCH_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`mode-option${mode === m.value ? " active" : ""}`}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </fieldset>
        <button type="button" className="btn primary" onClick={doSend}>
          {S.send}
        </button>
        {agentRunning && (
          <button type="button" className="btn danger" onClick={() => void stopAgent()}>
            {S.stop}
          </button>
        )}
      </div>
    </div>
  );
}
