import { sessionTitle } from "@/components/sidebar/SessionList";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";

/** 顶栏左侧：当前对话标题与所在工作区。空白新对话不显示标题。 */
export function ChatSessionHeader() {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === session?.workspaceId));
  const hasContent = useChatStore(
    (s) => (s.session.timelines.main?.length ?? 0) > 0 || s.optimistic.length > 0,
  );
  if (!session || (!session.title && !hasContent)) return null;
  return (
    <div className="mr-2 flex min-w-0 flex-1 items-center gap-2">
      <h1 className="em-session-title" title={sessionTitle(session)}>
        {sessionTitle(session)}
      </h1>
      {workspace && (
        <span
          className="hidden shrink-0 truncate text-[11px] text-muted-foreground lg:inline"
          title={workspace.path}
        >
          · {workspace.name}
        </span>
      )}
    </div>
  );
}
