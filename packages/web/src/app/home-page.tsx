// 主区域：对话流 + 输入框；未开始对话时显示欢迎页（打开表格时显示表格对话引导）。

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentViewBanner } from "@/components/chat/AgentViewBanner";
import { ChatHistoryStatus } from "@/components/chat/ChatHistoryStatus";
import { ChatInput } from "@/components/chat/ChatInput";
import { MessageStream } from "@/components/chat/MessageStream";
import {
  useWorkbookConversation,
  WorkbookConversationWelcome,
} from "@/components/excel/WorkbookConversation";
import { WelcomePage } from "@/components/welcome/WelcomePage";
import { WorkspaceViewHost } from "@/components/workspace/WorkspaceViewHost";
import { firstScreenMetrics } from "@/lib/first-screen-metrics";
import { visibleTimeline } from "@/lib/session/reducer";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbookStore } from "@/stores/workbook-store";

export function HomePage() {
  const contentRoot = useRef<HTMLDivElement>(null);
  const fullView = useWorkbookStore((s) => (firstScreenMetrics ? s.fullView : false));
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionId = useChatStore((s) => s.sessionId);
  const loading = useChatStore((s) => s.loading);
  const loadError = useChatStore((s) => s.loadError);
  const sessionSnapshot = useChatStore((s) => (firstScreenMetrics ? s.session : null));
  const hasOlder = useChatStore((s) => s.hasOlder);
  const hasItems = useChatStore(
    (s) => s.optimistic.length > 0 || visibleTimeline(s.session, s.viewAgentId).length > 0,
  );
  const { target: workbookTarget } = useWorkbookConversation();
  const [draft, setDraft] = useState<{
    seq: number;
    text: string;
    sessionId: string | null;
  } | null>(null);

  const suggest = useCallback(
    (text: string) => setDraft({ seq: Date.now(), text, sessionId }),
    [sessionId],
  );
  const clearDraft = useCallback(() => setDraft(null), []);

  const loaded = !activeSessionId || (sessionId === activeSessionId && !loading);
  const hasMessages = sessionId === activeSessionId && (hasItems || hasOlder);
  const restoring = Boolean(activeSessionId) && !hasMessages && !loaded;

  useEffect(() => {
    if (
      !firstScreenMetrics ||
      !activeSessionId ||
      sessionId !== activeSessionId ||
      loading ||
      loadError ||
      fullView ||
      !hasMessages
    )
      return;
    // A store snapshot identity is the epoch guard: a later restore cannot certify this commit.
    return firstScreenMetrics.correct(activeSessionId, () => {
      const current = useChatStore.getState();
      const root = contentRoot.current;
      const visibleMessage =
        root &&
        Array.from(root.querySelectorAll<HTMLElement>("[data-message-key]")).some((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          );
        });
      const correct =
        document.visibilityState === "visible" &&
        Boolean(visibleMessage) &&
        !useWorkbookStore.getState().fullView &&
        useSessionStore.getState().activeSessionId === activeSessionId &&
        current.sessionId === activeSessionId &&
        current.session === sessionSnapshot &&
        !current.loading &&
        !current.loadError;
      if (correct && !document.querySelector(".em-splash"))
        firstScreenMetrics?.mark("splash-hidden-raf");
      return correct;
    });
  }, [activeSessionId, sessionId, loading, loadError, hasMessages, sessionSnapshot, fullView]);

  return (
    <div ref={contentRoot} className="flex h-full flex-col">
      <WorkspaceViewHost
        composer={
          <div className="em-composer-dock pointer-events-none relative z-30 -mt-6 flex-shrink-0 pt-6">
            <div className="pointer-events-auto mx-auto w-full max-w-4xl">
              <ChatInput
                draft={draft?.sessionId === sessionId ? draft : null}
                onDraftApplied={clearDraft}
                disabled={!loaded}
              />
            </div>
          </div>
        }
      >
        <ChatHistoryStatus
          sessionId={activeSessionId}
          empty={!hasMessages && (restoring || Boolean(loadError))}
        />
        <AgentViewBanner />
        {hasMessages ? (
          <MessageStream />
        ) : workbookTarget ? (
          <WorkbookConversationWelcome onSuggestion={suggest} />
        ) : restoring || loadError ? null : (
          <WelcomePage onSuggestionClick={suggest} />
        )}
      </WorkspaceViewHost>
    </div>
  );
}
