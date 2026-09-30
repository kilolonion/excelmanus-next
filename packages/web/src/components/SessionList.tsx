import { createSession, removeSession, selectSession, setSettingsOpen, useApp } from "../store.ts";
import { S } from "../strings.ts";

export function SessionList() {
  const sessions = useApp((s) => s.sessions);
  const sessionId = useApp((s) => s.sessionId);

  return (
    <div className="session-list">
      <div className="row-between">
        <span className="section-title">{S.sessions}</span>
        <button type="button" className="btn ghost" onClick={() => void createSession()}>
          {S.newSession}
        </button>
      </div>
      <div className="session-items">
        {sessions.length === 0 && <div className="muted small">{S.emptySessions}</div>}
        {sessions.map((s) => (
          <div key={s.id} className={`session-item ${s.id === sessionId ? "active" : ""}`}>
            <button type="button" className="session-name" onClick={() => void selectSession(s.id)}>
              {s.title ?? S.untitled}
            </button>
            <button
              type="button"
              className="btn ghost danger small"
              onClick={() => void removeSession(s.id)}
              title={S.deleteSession}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
          {S.settings}
        </button>
      </div>
    </div>
  );
}
