// 弹层/滚动/折叠/标签/提示框：Popover、ScrollArea、Collapsible/Disclosure、Tabs、Toast
import * as C from "@radix-ui/react-collapsible";
import * as P from "@radix-ui/react-popover";
import * as SA from "@radix-ui/react-scroll-area";
import * as TB from "@radix-ui/react-tabs";
import * as TS from "@radix-ui/react-toast";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useState } from "react";
import { create } from "zustand";
import { S } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { cn } from "./cn.ts";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof P.Content>
>(function PopoverContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <P.Portal>
      <P.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[10100] rounded-lg border border-border bg-popover p-3 text-foreground shadow-popover outline-none",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
});

export const ScrollArea = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SA.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportClassName?: string;
    viewportProps?: React.HTMLAttributes<HTMLDivElement>;
  }
>(function ScrollArea(
  { className, children, viewportRef, viewportClassName, viewportProps, ...props },
  ref,
) {
  return (
    <SA.Root
      ref={ref}
      type="auto"
      className={cn("relative min-h-0 overflow-hidden", className)}
      {...props}
    >
      <SA.Viewport
        ref={viewportRef}
        className={cn("size-full rounded-[inherit] [&>div]:!block", viewportClassName)}
        {...viewportProps}
      >
        {children}
      </SA.Viewport>
      <SA.Scrollbar orientation="vertical" className="flex w-2.5 touch-none p-0.5 select-none">
        <SA.Thumb className="relative flex-1 rounded-full bg-border-strong" />
      </SA.Scrollbar>
      <SA.Corner />
    </SA.Root>
  );
});

export const Collapsible = C.Root;
export const CollapsibleTrigger = C.Trigger;

export const CollapsibleContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof C.Content>
>(function CollapsibleContent({ className, ...props }, ref) {
  return (
    <C.Content
      ref={ref}
      className={cn(
        "overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        className,
      )}
      {...props}
    />
  );
});

/** 可展开区块：plain（小字链接）/ chip（胶囊，用于思考块）/ section（分组标题） */
export function Disclosure({
  summary,
  variant = "plain",
  defaultOpen,
  open,
  onOpenChange,
  className,
  triggerClassName,
  contentClassName,
  icon,
  children,
}: {
  summary: ReactNode;
  variant?: "plain" | "chip" | "section";
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultOpen ?? false);
  const isOpen = open ?? inner;
  const set = (o: boolean) => {
    setInner(o);
    onOpenChange?.(o);
  };
  return (
    <C.Root open={isOpen} onOpenChange={set} className={cn("min-w-0", className)}>
      <C.Trigger
        className={cn(
          "group/disc inline-flex max-w-full min-w-0 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          variant === "plain" && "rounded-sm text-xs text-muted-foreground hover:text-foreground",
          variant === "chip" &&
            "h-7 rounded-full bg-muted px-3 text-xs text-muted-foreground hover:text-foreground",
          variant === "section" && "rounded-sm text-sm font-medium text-foreground",
          triggerClassName,
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{summary}</span>
        <Icon
          name="chevronRight"
          size="xs"
          className="transition-transform group-data-[state=open]/disc:rotate-90"
        />
      </C.Trigger>
      <CollapsibleContent>
        <div className={cn("pt-2", contentClassName)}>{children}</div>
      </CollapsibleContent>
    </C.Root>
  );
}

export const Tabs = TB.Root;
export const TabsContent = TB.Content;

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TB.List>>(
  function TabsList({ className, ...props }, ref) {
    return (
      <TB.List
        ref={ref}
        className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
        {...props}
      />
    );
  },
);

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof TB.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TB.Trigger
      ref={ref}
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
});

type ToastItem = {
  id: number;
  tone: "ok" | "err" | "info";
  title: string;
  description?: string;
  duration: number;
};
const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let seq = 0;

export function toast(t: {
  tone?: ToastItem["tone"];
  title: string;
  description?: string;
  duration?: number;
}) {
  const tone = t.tone ?? "info";
  const item: ToastItem = {
    id: ++seq,
    tone,
    title: t.title,
    description: t.description,
    duration: t.duration ?? (tone === "err" ? 8000 : 4000),
  };
  useToasts.setState((s) => ({ items: [...s.items, item] }));
}

const TOAST_ICON = { ok: "circleCheck", err: "circleAlert", info: "info" } as const;
const TOAST_TONE = { ok: "text-ok", err: "text-destructive", info: "text-read" } as const;

export function Toaster() {
  const items = useToasts((s) => s.items);
  const remove = (id: number) =>
    useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
  return (
    <TS.Provider swipeDirection="right">
      {items.map((t) => (
        <TS.Root
          key={t.id}
          duration={t.duration}
          type={t.tone === "err" ? "foreground" : "background"}
          onOpenChange={(o) => !o && remove(t.id)}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-popover p-3 text-sm text-foreground shadow-popover data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Icon name={TOAST_ICON[t.tone]} size="md" className={cn("mt-0.5", TOAST_TONE[t.tone])} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <TS.Title className="font-medium">{t.title}</TS.Title>
            {t.description && (
              <TS.Description className="text-xs text-muted-foreground">
                {t.description}
              </TS.Description>
            )}
          </div>
          <TS.Close
            aria-label={S.close}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Icon name="x" size="sm" />
          </TS.Close>
        </TS.Root>
      ))}
      <TS.Viewport className="fixed right-4 bottom-4 z-[10200] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none" />
    </TS.Provider>
  );
}
