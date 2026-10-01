// 选择类控件：Checkbox、Switch、RadioGroup/RadioCard、SegmentedControl、Slider
import * as CB from "@radix-ui/react-checkbox";
import * as RG from "@radix-ui/react-radio-group";
import * as SL from "@radix-ui/react-slider";
import * as SW from "@radix-ui/react-switch";
import * as TG from "@radix-ui/react-toggle-group";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { useFieldIds } from "./field.tsx";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CB.Root>>(
  function Checkbox({ className, id, ...props }, ref) {
    const f = useFieldIds({ id });
    return (
      <CB.Root
        ref={ref}
        data-slot="checkbox"
        {...f}
        className={cn(
          "peer inline-flex size-4 shrink-0 items-center justify-center rounded-xs border border-input bg-card transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
          focus,
          className,
        )}
        {...props}
      >
        <CB.Indicator>
          <Icon name="check" size="xs" />
        </CB.Indicator>
      </CB.Root>
    );
  },
);

export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SW.Root> & { size?: "default" | "sm" }
>(function Switch({ className, size = "default", id, ...props }, ref) {
  const f = useFieldIds({ id });
  return (
    <SW.Root
      ref={ref}
      data-slot="switch"
      {...f}
      className={cn(
        "peer inline-flex shrink-0 items-center rounded-full border border-transparent bg-input transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
        focus,
        className,
      )}
      {...props}
    >
      <SW.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-card shadow-xs transition-transform data-[state=unchecked]:translate-x-0.5",
          size === "sm"
            ? "size-3 data-[state=checked]:translate-x-3.5"
            : "size-4 data-[state=checked]:translate-x-[18px]",
        )}
      />
    </SW.Root>
  );
});

export const RadioGroup = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RG.Root>>(
  function RadioGroup({ className, ...props }, ref) {
    return <RG.Root ref={ref} className={cn("grid gap-2", className)} {...props} />;
  },
);

export const RadioGroupItem = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RG.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RG.Item
      ref={ref}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
        focus,
        className,
      )}
      {...props}
    >
      <RG.Indicator className="size-2 rounded-full bg-primary" />
    </RG.Item>
  );
});

/** 整卡可选的单选项 */
export const RadioCard = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RG.Item> & { icon?: IconName }
>(function RadioCard({ className, children, icon, ...props }, ref) {
  return (
    <RG.Item
      ref={ref}
      data-slot="radio-card"
      className={cn(
        "group relative flex w-full min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/60 disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
        focus,
        className,
      )}
      {...props}
    >
      {icon && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground-secondary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
          <Icon name={icon} size="md" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">{children}</span>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary">
        <RG.Indicator className="size-2 rounded-full bg-primary" />
      </span>
    </RG.Item>
  );
});

export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  size = "default",
  ariaLabel,
  className,
}: {
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: ReactNode; icon?: IconName; ariaLabel?: string }[];
  size?: "default" | "xs";
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as V)}
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs",
            size === "xs" ? "h-5 px-2 text-2xs" : "h-7 px-3 text-xs",
            focus,
          )}
        >
          {o.icon && <Icon name={o.icon} size="xs" />}
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  ariaLabel,
  valueText,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  valueText?: string;
  className?: string;
}) {
  return (
    <SL.Root
      value={[value]}
      onValueChange={(v) => v[0] !== undefined && onChange(v[0])}
      min={min}
      max={max}
      step={step}
      className={cn("relative flex h-5 w-full touch-none items-center select-none", className)}
    >
      <SL.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
        <SL.Range className="absolute h-full bg-primary" />
      </SL.Track>
      <SL.Thumb
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        className={cn("block size-4 rounded-full border-2 border-primary bg-card shadow-xs", focus)}
      />
    </SL.Root>
  );
}
