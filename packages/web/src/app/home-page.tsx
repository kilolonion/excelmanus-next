// 主区域：对话流 + 输入框；未开始对话时显示欢迎页（打开表格时显示表格对话引导）。

import { useCallback, useState } from "react";
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
import { visibleTimeline } from "@/lib/session/reducer";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";

export function HomePage() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionId = useChatStore((s) => s.sessionId);
  const loading = useChatStore((s) => s.loading);
  const loadError = useChatStore((s) => s.loadError);
  const hasItems = useChatStore(
    (s) => s.optimistic.length > 0 || visibleTimeline(s.session, s.viewAgentId).length > 0,
  );
  const { target: workbookTarget } = useWorkbookConversation();
  const [draft, setDraft] = useState<{ seq: number; text: string } | null>(null);

  const suggest = useCallback((text: string) => setDraft({ seq: Date.now(), text }), []);

  const loaded = !activeSessionId || (sessionId === activeSessionId && !loading);
  const hasMessages = sessionId === activeSessionId && hasItems;
  const restoring = Boolean(activeSessionId) && !hasMessages && !loaded;

  return (
    <div className="flex h-full flex-col">
      <WorkspaceViewHost
        composer={
          <div className="em-composer-dock pointer-events-none relative z-30 -mt-6 flex-shrink-0 pt-6">
            <div className="pointer-events-auto mx-auto w-full max-w-4xl">
              <ChatInput draft={draft} disabled={!loaded} />
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
