// 命令式确认对话框：`await confirmAction({...})`，全局只挂一个 <ConfirmHost />。
import { AlertTriangle, HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { create } from "zustand";
import {
  OverlayCard,
  OverlayCardAction,
  OverlayCardFooter,
  OverlayCardHeader,
} from "@/components/ui/overlay-card";

interface ConfirmRequest {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ request: ConfirmRequest | null }>()(() => ({ request: null }));

export function confirmAction(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().request?.resolve(false);
    useConfirmStore.setState({ request: { ...opts, resolve } });
  });
}

function settle(ok: boolean) {
  const request = useConfirmStore.getState().request;
  useConfirmStore.setState({ request: null });
  request?.resolve(ok);
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const danger = request?.tone === "danger";
  return (
    <OverlayCard
      open={request !== null}
      onOpenChange={(open) => !open && settle(false)}
      size="sm"
      tone={danger ? "danger" : "primary"}
    >
      {request && (
        <>
          <OverlayCardHeader
            icon={
              danger ? <AlertTriangle className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />
            }
            title={request.title}
            description={request.description}
          />
          <OverlayCardFooter className="pt-5">
            <OverlayCardAction action="ghost" onClick={() => settle(false)}>
              {request.cancelLabel ?? "取消"}
            </OverlayCardAction>
            <OverlayCardAction
              action={danger ? "destructive" : "primary"}
              onClick={() => settle(true)}
              autoFocus
            >
              {request.confirmLabel ?? "确定"}
            </OverlayCardAction>
          </OverlayCardFooter>
        </>
      )}
    </OverlayCard>
  );
}
