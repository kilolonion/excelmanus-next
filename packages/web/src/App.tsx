import { useEffect } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { Workbench } from "./components/Workbench.tsx";
import { init, useApp } from "./store.ts";
import { S } from "./strings.ts";

export function App() {
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const connected = useApp((s) => s.connected);
  const hasModelProfile = useApp((s) => s.hasModelProfile);
  const settingsOpen = useApp((s) => s.settingsOpen);

  useEffect(() => {
    void init();
  }, []);

  if (fatal === "no-token") {
    return <div className="fatal">{S.noToken}</div>;
  }
  if (!ready) {
    return <div className="fatal">{S.connecting}</div>;
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">{S.appName}</div>
        <SessionList />
      </aside>
      <main className="main">
        {!hasModelProfile && (
          <div className="notice">
            {S.needProfile} {S.needProfileHint}
          </div>
        )}
        {!connected && <div className="notice muted">{S.reconnecting}</div>}
        <ChatPanel />
      </main>
      <aside className="workbench">
        <Workbench />
      </aside>
      {settingsOpen && <SettingsModal />}
    </div>
  );
}
