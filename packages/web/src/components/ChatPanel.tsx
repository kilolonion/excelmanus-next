import { useEffect, useRef, useState } from "react";
import { renderMarkdown, renderPlainText } from "../md.ts";
import { displayItems, type ToolCard } from "../reduce.ts";
import { focusRange, openDocument, previewRange, send, stopAgent, useApp } from "../store.ts";
import { S } from "../strings.ts";

const TOOL_STATUS: Record<ToolCard["status"], string> = {
  pending: S.toolRunning,
  ok: S.toolOk,
  error: S.toolError,
  not_executed: S.toolNotExecuted,
  cancelled: S.toolCancelled,
};

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
  // renderMarkdown 已按标签白名单消毒（见 md.ts），此处输出是受信 HTML
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
  const referenceError = useApp((s) => s.referenceError);
  const [text, setText] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = displayItems(session);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  });

  const doSend = () => {
    const t = text.trim();
    if (t === "" || sessionId === null) return;
    setText("");
    setSendFailed(false);
    void send(t).catch(() => {
      setSendFailed(true);
      setText((current) => (current === "" ? t : current));
    });
  };

  return (
    <div className="chat">
      {sendFailed && <div className="notice error">{S.sendFailed}</div>}
      {referenceError && (
        <div className="notice warn">
          {referenceError === "no-document" ? S.openReferenceFile : S.invalidReference}
        </div>
      )}
      <div className="chat-scroll">
        {items.map((item) =>
          "kind" in item ? (
            <ToolCardView key={`tool-${item.toolCallId}`} card={item} />
          ) : (
            <div key={item.id} className={`msg ${item.role}`}>
              <MessageBody text={item.text} />
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
      <div className="composer">
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
        {session.running ? (
          <button type="button" className="btn danger" onClick={() => void stopAgent()}>
            {S.stop}
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={doSend}>
            {S.send}
          </button>
        )}
      </div>
    </div>
  );
}
