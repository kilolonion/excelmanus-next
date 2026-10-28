import { MessageSquarePlus, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { OverlayCard, OverlayCardHeader } from "@/components/ui/overlay-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { createSession, useSessionStore } from "@/stores/session-store";
import { ChatModeTabs } from "./ChatModeTabs";
import { ContextUsageButton } from "./ContextUsageButton";
import { ModeBadges } from "./ModeBadges";
import { ThinkingLevelSelector } from "./ThinkingLevelSelector";
import { TopModelSelector } from "./TopModelSelector";

export function MobileNewConversation() {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const start = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const origin = useSessionStore.getState();
    try {
      await createSession(origin.activeWorkspaceId);
    } catch (cause) {
      const current = useSessionStore.getState();
      if (
        alive.current &&
        current.activeSessionId === origin.activeSessionId &&
        current.activeWorkspaceId === origin.activeWorkspaceId
      )
        toast({ tone: "error", title: errorMessage(cause, "新建对话失败，请重试") });
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="relative shrink-0">
      <Button
        variant="ghost"
        disabled={busy}
        aria-label="新建对话"
        onClick={() => void start()}
        className="h-11 gap-1 px-2"
      >
        <MessageSquarePlus className="size-4" />
        {busy ? "正在新建…" : "新建"}
      </Button>
    </div>
  );
}

/** Only conversation options live here. Destinations have their own persistent navigation. */
export function MobileComposerTools() {
  const [open, setOpen] = useState(false);
  return (
    <div className="em-mobile-composer-tools">
      <TopModelSelector />
      <ChatModeTabs compact />
      <Button
        variant="ghost"
        aria-label="对话选项"
        onClick={() => setOpen(true)}
        className="size-11 shrink-0 rounded-full"
      >
        <SlidersHorizontal className="size-5" />
      </Button>
      <OverlayCard
        open={open}
        onOpenChange={setOpen}
        className="em-mobile-actions-sheet"
        aria-describedby={undefined}
      >
        <OverlayCardHeader title="对话选项" onClose={() => setOpen(false)} />
        <div className="em-mobile-composer-options overflow-y-auto p-4">
          <div>
            <span>操作权限</span>
            <ModeBadges />
          </div>
          <div>
            <span>思考强度</span>
            <ThinkingLevelSelector />
          </div>
          <div>
            <span>上下文用量</span>
            <ContextUsageButton />
          </div>
        </div>
      </OverlayCard>
    </div>
  );
}
