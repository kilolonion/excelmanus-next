import * as D from "@radix-ui/react-dropdown-menu";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { cn } from "./cn.ts";

export const DropdownMenu = D.Root;
export const DropdownMenuTrigger = D.Trigger;
export const DropdownMenuRadioGroup = D.RadioGroup;

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof D.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <D.Portal>
      <D.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[10100] min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 text-foreground shadow-popover",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </D.Portal>
  );
});

const itemCls =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[disabled]:opacity-50";

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof D.Item>>(
  function DropdownMenuItem({ className, ...props }, ref) {
    return <D.Item ref={ref} className={cn(itemCls, className)} {...props} />;
  },
);

export const DropdownMenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof D.RadioItem> & { description?: ReactNode }
>(function DropdownMenuRadioItem({ className, children, description, ...props }, ref) {
  return (
    <D.RadioItem ref={ref} className={cn(itemCls, "items-start pl-7", className)} {...props}>
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        <D.ItemIndicator>
          <Icon name="check" size="xs" />
        </D.ItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{children}</span>
        {description && (
          <span className="truncate text-2xs text-muted-foreground">{description}</span>
        )}
      </span>
    </D.RadioItem>
  );
});

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <D.Label className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </D.Label>
  );
}

export function DropdownMenuSeparator() {
  return <D.Separator className="-mx-1 my-1 h-px bg-border" />;
}
