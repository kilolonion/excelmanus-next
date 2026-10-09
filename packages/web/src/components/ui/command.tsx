// 候选列表（@ / 候选、模型 ID 组合框）：listbox + option，键盘导航由调用方 onKeyDown 提供
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { Icon } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { Input } from "./input.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "./overlay.tsx";

export function CommandList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="listbox"
      data-slot="command-list"
      className={cn("flex flex-col gap-px overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

export function CommandItem({
  id,
  active,
  onPick,
  onHover,
  className,
  children,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
  onHover?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseEnter={onHover}
      className={cn(
        "flex h-8 min-w-0 cursor-default items-center gap-2 rounded-sm px-2 text-sm",
        active ? "bg-accent text-foreground" : "text-foreground-secondary",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CommandFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
      {children}
    </div>
  );
}

/** 可自由输入的组合框：候选按子串过滤 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  required,
  mono,
  id,
  ariaLabel,
  startAdornment,
  renderOption,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  id?: string;
  ariaLabel?: string;
  startAdornment?: ReactNode;
  renderOption?: (value: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = value.trim().toLowerCase();
  const list = options.filter((o) => o.toLowerCase().includes(q)).slice(0, 50);
  const show = open && list.length > 0;
  const listId = `${id ?? "combo"}-list`;
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <Popover open={show} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          {startAdornment && (
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2">
              {startAdornment}
            </span>
          )}
          <Input
            className={startAdornment ? "pl-9" : undefined}
            id={id}
            value={value}
            mono={mono}
            placeholder={placeholder}
            required={required}
            aria-label={ariaLabel}
            role="combobox"
            aria-expanded={show}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={show ? `${listId}-${active}` : undefined}
            autoComplete="off"
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              onChange(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (!show || e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % list.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a - 1 + list.length) % list.length);
              } else if (e.key === "Enter") {
                const v = list[active];
                if (v !== undefined) {
                  e.preventDefault();
                  pick(v);
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <CommandList id={listId} className="max-h-60">
          {list.map((o, i) => (
            <CommandItem
              key={o}
              id={`${listId}-${i}`}
              active={i === active}
              onPick={() => pick(o)}
              onHover={() => setActive(i)}
              className={mono ? "font-mono text-xs" : undefined}
            >
              <span className="min-w-0 flex-1 truncate">{renderOption ? renderOption(o) : o}</span>
              {o === value && <Icon name="check" size="xs" />}
            </CommandItem>
          ))}
        </CommandList>
      </PopoverContent>
    </Popover>
  );
}
