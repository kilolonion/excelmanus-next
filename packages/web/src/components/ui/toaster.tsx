// 轻量提示：操作结果与失败原因（不打断当前操作，几秒后自动消失）。
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { create } from "zustand";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

const useToastStore = create<{ items: ToastItem[] }>()(() => ({ items: [] }));
let toastSeq = 0;

export function dismissToast(id: number): void {
  useToastStore.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function toast(input: {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}): number {
  const id = ++toastSeq;
  const item: ToastItem = {
    id,
    title: input.title,
    tone: input.tone ?? "info",
    ...(input.description ? { description: input.description } : {}),
  };
  useToastStore.setState((s) => ({ items: [...s.items.slice(-3), item] }));
  setTimeout(() => dismissToast(id), input.durationMs ?? (item.tone === "error" ? 6000 : 3500));
  return id;
}

const ICON = { info: Info, success: CheckCircle2, error: AlertCircle } as const;

export function Toaster() {
  const items = useToastStore((s) => s.items);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      role="region"
      aria-label="通知"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => {
          const Icon = ICON[item.tone];
          return (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              role={item.tone === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-2xl border border-[var(--em-hairline)] bg-popover/95 px-3.5 py-2.5 text-[13px] text-foreground shadow-[0_12px_36px_rgba(32,40,35,0.14)] backdrop-blur-xl dark:shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
            >
              <Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  item.tone === "error"
                    ? "text-destructive"
                    : item.tone === "success"
                      ? "text-[var(--em-primary)]"
                      : "text-muted-foreground",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium leading-5 break-words">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground break-words">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(item.id)}
                className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="关闭通知"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
