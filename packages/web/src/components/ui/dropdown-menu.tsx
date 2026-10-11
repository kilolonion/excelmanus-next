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
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <D.Portal>
      <D.Content
        ref={ref}
        data-slot="dropdown-menu"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[10100] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-40 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-foreground shadow-popover",
          "origin-[var(--radix-dropdown-menu-content-transform-origin)] animate-in fade-in-0 zoom-in-98 duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </D.Portal>
  );
});

const itemCls =
  "relative flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm leading-snug outline-none transition-colors duration-100 data-[highlighted]:bg-accent/70 data-[disabled]:pointer-events-none data-[disabled]:opacity-45";

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof D.Item>>(
  function DropdownMenuItem({ className, ...props }, ref) {
    return (
      <D.Item ref={ref} data-slot="dropdown-item" className={cn(itemCls, className)} {...props} />
    );
  },
);

export const DropdownMenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof D.RadioItem> & { description?: ReactNode }
>(function DropdownMenuRadioItem({ className, children, description, ...props }, ref) {
  return (
    <D.RadioItem
      ref={ref}
      data-slot="dropdown-radio-item"
      className={cn(itemCls, "items-start pl-8 data-[state=checked]:font-medium", className)}
      {...props}
    >
      <span className="absolute top-2.5 left-2.5 flex size-3.5 items-center justify-center text-foreground-secondary">
        <D.ItemIndicator>
          <Icon name="check" size="xs" />
        </D.ItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words">{children}</span>
        {description && (
          <span className="break-words text-xs font-normal leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </D.RadioItem>
  );
});

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <D.Label
      data-slot="dropdown-label"
      className="px-2.5 pt-2 pb-1.5 text-2xs font-medium text-muted-foreground"
    >
      {children}
    </D.Label>
  );
}

export function DropdownMenuSeparator() {
  return <D.Separator className="mx-1 my-1.5 h-px bg-border" />;
}
