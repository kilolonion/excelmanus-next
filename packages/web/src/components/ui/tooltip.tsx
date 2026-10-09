import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";
import { Shortcut } from "./kbd.tsx";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </T.Provider>
  );
}

export function Tip({
  content,
  side = "top",
  shortcut,
  children,
  className,
  disabled = false,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <T.Root open={disabled ? false : undefined}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          data-slot="tooltip"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-[10100] flex max-w-80 items-center gap-2.5 rounded-md bg-primary px-2.5 py-1.5 text-xs leading-relaxed text-primary-foreground shadow-popover",
            "origin-[var(--radix-tooltip-content-transform-origin)] animate-in fade-in-0 zoom-in-98 duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
            className,
          )}
        >
          <span className="min-w-0 break-words">{content}</span>
          {shortcut && <Shortcut keys={shortcut} className="opacity-80" inverted />}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
