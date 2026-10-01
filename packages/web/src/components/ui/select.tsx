import * as S from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { useFieldIds } from "./field.tsx";

/** Radix 不允许空字符串值：用此常量表示"无/自动/与主对话相同" */
export const NONE = "__none__";

export const Select = S.Root;
export const SelectGroup = S.Group;
export const SelectValue = S.Value;

const triggerVariants = cva(
  "inline-flex min-w-0 items-center justify-between gap-1.5 rounded-md text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "w-full border border-input bg-card text-foreground",
        ghost: "text-foreground-secondary hover:bg-accent hover:text-foreground",
      },
      size: { default: "h-8 px-2.5 text-sm", sm: "h-7 px-2 text-xs", xs: "h-6 px-1.5 text-xs" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof S.Trigger> &
    VariantProps<typeof triggerVariants> & { icon?: IconName }
>(function SelectTrigger({ className, variant, size, icon, id, children, ...props }, ref) {
  const f = useFieldIds({ id });
  return (
    <S.Trigger
      ref={ref}
      data-slot="select-trigger"
      {...f}
      className={cn(triggerVariants({ variant, size }), className)}
      {...props}
    >
      {icon && <Icon name={icon} size="xs" className="text-muted-foreground" />}
      {children ?? <S.Value />}
      <S.Icon asChild>
        <Icon name="chevronDown" size="xs" className="ml-auto text-muted-foreground" />
      </S.Icon>
    </S.Trigger>
  );
});

export const SelectContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof S.Content>>(
  function SelectContent({ className, children, position = "popper", ...props }, ref) {
    return (
      <S.Portal>
        <S.Content
          ref={ref}
          position={position}
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "relative z-[10100] max-h-72 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-popover",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
            className,
          )}
          {...props}
        >
          <S.Viewport className="p-1">{children}</S.Viewport>
        </S.Content>
      </S.Portal>
    );
  },
);

export const SelectItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof S.Item> & { description?: ReactNode }
>(function SelectItem({ className, children, description, ...props }, ref) {
  return (
    <S.Item
      ref={ref}
      data-slot="select-item"
      className={cn(
        "relative flex cursor-default select-none flex-col rounded-sm py-1.5 pr-2 pl-7 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        <S.ItemIndicator>
          <Icon name="check" size="xs" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
      {description && <span className="text-2xs text-muted-foreground">{description}</span>}
    </S.Item>
  );
});

export function SelectLabel({ children }: { children: ReactNode }) {
  return (
    <S.Label className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </S.Label>
  );
}

export function SelectSeparator() {
  return <S.Separator className="my-1 h-px bg-border" />;
}

/** 常用简化：选项数组 → Select */
export function SimpleSelect<V extends string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  size,
  variant,
  icon,
  disabled,
  required,
  className,
  contentClassName,
}: {
  value: V | "";
  onChange: (v: V) => void;
  options: readonly { value: V; label: ReactNode; description?: ReactNode }[];
  placeholder?: string;
  ariaLabel?: string;
  size?: "default" | "sm" | "xs";
  variant?: "default" | "ghost";
  icon?: IconName;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Select
      value={value === "" ? undefined : value}
      onValueChange={(v) => {
        if (options.some((o) => o.value === v)) onChange(v as V);
      }}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size={size}
        variant={variant}
        icon={icon}
        className={className}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} description={o.description}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
