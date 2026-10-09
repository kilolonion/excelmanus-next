import { useId, useState } from "react";
import type { UiMessage } from "../reduce.ts";
import { apiClientOf } from "../store.ts";
import { S } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/input.tsx";
import { toast } from "./ui/overlay.tsx";

export function PendingMessage({
  message,
  sessionId,
  agentId,
  label,
}: {
  message: UiMessage;
  sessionId: string;
  agentId: string;
  label: string | null;
}) {
  const statusId = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const act = async (action: "save" | "interrupt" | "delete") => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "delete") {
        await apiClientOf().cancelDispatch(sessionId, message.id);
      } else {
        await apiClientOf().sendMessage(sessionId, agentId, {
          clientMessageId: `web-replace-${crypto.randomUUID()}`,
          replacesDispatchId: message.id,
          text: editing ? text.trim() : message.text,
          mode: action === "interrupt" ? "interrupt" : (message.mode ?? "steer"),
          ...(message.attachments ? { attachments: message.attachments } : {}),
          ...(message.context ? { context: message.context } : {}),
        });
      }
      setEditing(false);
    } catch (error) {
      toast({ tone: "err", title: error instanceof Error ? error.message : S.pendingActionFailed });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="pending-message flex w-fit max-w-[88%] flex-col gap-2"
      data-dispatch-id={message.id}
    >
      {editing ? (
        <div className="rounded-2xl border border-read/40 bg-read-soft/40 p-3">
          <Textarea
            autoFocus
            aria-label={S.pendingEdit}
            aria-describedby={statusId}
            value={text}
            disabled={busy}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setText(message.text);
                setEditing(false);
              }}
            >
              {S.cancel}
            </Button>
            <Button size="xs" disabled={busy || !text.trim()} onClick={() => void act("save")}>
              {S.pendingSave}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={S.pendingEdit}
          aria-describedby={statusId}
          className="h-auto max-w-full self-end justify-start whitespace-pre-wrap break-words rounded-2xl rounded-tr-md border border-dashed border-read/40 bg-read-soft/40 px-4 py-3 text-left text-base font-normal"
          onClick={() => setEditing(true)}
        >
          <Icon name="clock" size="sm" className="text-muted-foreground" />
          <span className="min-w-0">{message.text || S.fileOnlyText}</span>
        </Button>
      )}
      <span id={statusId} className="sr-only" role="status">
        {label} · {S.pendingDelivery}
      </span>
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          variant="ghost"
          size="xs"
          disabled={busy || (editing && !text.trim())}
          onClick={() => void act("interrupt")}
        >
          <Icon name="send" size="xs" />
          {S.pendingInterrupt}
        </Button>
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void act("delete")}>
          <Icon name="trash" size="xs" />
          {S.pendingDelete}
        </Button>
      </div>
    </div>
  );
}
