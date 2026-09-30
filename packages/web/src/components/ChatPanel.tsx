import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../md.ts";
import { displayItems, type ToolCard } from "../reduce.ts";
import { send, stopAgent, useApp } from "../store.ts";
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
      {card.args !== undefined && card.args !== "" && <pre className="tool-args">{card.args}</pre>}
      {card.targets !== undefined && card.targets.length > 0 && (
        <div className="muted small">{card.targets.join("，")}</div>
      )}
      {card.resultSummary !== undefined && <pre className="tool-result">{card.resultSummary}</pre>}
    </div>
  );
}

function MessageBody({ text }: { text: string }) {
  // renderMarkdown 已按标签白名单消毒（见 md.ts），此处输出是受信 HTML
  const html = renderMarkdown(text);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容经白名单消毒
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ChatPanel() {
  const session = useApp((s) => s.session);
  const sessionId = useApp((s) => s.sessionId);
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const items = displayItems(session);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  });

  const doSend = () => {
    const t = text.trim();
    if (t === "" || sessionId === null) return;
    setText("");
    void send(t);
  };

  return (
    <div className="chat">
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
