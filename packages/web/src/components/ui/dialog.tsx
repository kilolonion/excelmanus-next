import * as AD from "@radix-ui/react-alert-dialog";
import * as D from "@radix-ui/react-dialog";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useRef } from "react";
import { cn } from "./cn.ts";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const overlayCls =
  "fixed inset-0 z-[10050] bg-black/20 backdrop-blur-[3px] dark:bg-black/60 animate-in fade-in-0 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none";
const contentCls =
  "fixed top-1/2 left-1/2 z-[10050] max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card text-foreground shadow-dialog outline-none animate-in fade-in-0 zoom-in-98 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 motion-reduce:animate-none";

export const DialogContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof D.Content>>(
  function DialogContent(
    { className, children, onOpenAutoFocus, onCloseAutoFocus, ...props },
    ref,
  ) {
    const opener = useRef<HTMLElement | null>(null);
    return (
      <D.Portal>
        <D.Overlay data-slot="dialog-overlay" className={overlayCls} />
        <D.Content
          ref={ref}
          data-slot="dialog"
          className={cn(contentCls, "w-[min(480px,calc(100vw-32px))] p-6", className)}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            opener.current =
              active instanceof HTMLElement && active !== document.body ? active : null;
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (!event.defaultPrevented && opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus({ preventScroll: true });
            }
          }}
          {...props}
        >
          {children}
        </D.Content>
      </D.Portal>
    );
  },
);

export const DialogTitle = forwardRef<HTMLHeadingElement, ComponentPropsWithoutRef<typeof D.Title>>(
  function DialogTitle({ className, ...props }, ref) {
    return (
      <D.Title
        ref={ref}
        data-slot="dialog-title"
        className={cn("text-lg font-semibold tracking-tight", className)}
        {...props}
      />
    );
  },
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof D.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <D.Description
      ref={ref}
      data-slot="dialog-description"
      className={cn("text-sm leading-relaxed text-foreground-secondary", className)}
      {...props}
    />
  );
});

export const AlertDialog = AD.Root;

export function AlertDialogContent({
  title,
  description,
  footer,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <AD.Portal>
      <AD.Overlay data-slot="dialog-overlay" className={overlayCls} />
      <AD.Content
        data-slot="alert-dialog"
        className={cn(contentCls, "flex w-[min(440px,calc(100vw-32px))] flex-col gap-3 p-6")}
      >
        <AD.Title className="text-lg font-semibold tracking-tight">{title}</AD.Title>
        {description ? (
          <AD.Description asChild>
            <div className="flex flex-col gap-2 text-sm leading-relaxed text-foreground-secondary">
              {description}
            </div>
          </AD.Description>
        ) : (
          <AD.Description className="sr-only">{title}</AD.Description>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">{footer}</div>
      </AD.Content>
    </AD.Portal>
  );
}

export const AlertDialogCancel = AD.Cancel;
export const AlertDialogAction = AD.Action;
