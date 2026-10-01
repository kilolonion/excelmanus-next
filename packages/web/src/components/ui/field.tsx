import * as L from "@radix-ui/react-label";
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { cn } from "./cn.ts";

type FieldCtx = { id: string; describedBy?: string; invalid?: boolean };
const Ctx = createContext<FieldCtx | null>(null);

/** 字段内控件取 id / aria-describedby / aria-invalid；不在 Field 内时返回传入值 */
export function useFieldIds(own?: { id?: string }) {
  const ctx = useContext(Ctx);
  return {
    id: own?.id ?? ctx?.id,
    "aria-describedby": ctx?.describedBy,
    "aria-invalid": ctx?.invalid || undefined,
  };
}

export const Label = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<typeof L.Root>>(
  function Label({ className, ...props }, ref) {
    return (
      <L.Root
        ref={ref}
        data-slot="label"
        className={cn("text-xs font-medium text-foreground-secondary select-none", className)}
        {...props}
      />
    );
  },
);

export function HelpText({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p id={id} className={cn("text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

export function Field({
  label,
  description,
  error,
  orientation = "vertical",
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  orientation?: "vertical" | "horizontal";
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const descId = description ? `${id}-d` : undefined;
  const errId = error ? `${id}-e` : undefined;
  const describedBy = [descId, errId].filter(Boolean).join(" ") || undefined;
  const ctx = { id, describedBy, invalid: !!error };
  if (orientation === "horizontal") {
    return (
      <Ctx.Provider value={ctx}>
        <div data-slot="field" className={cn("flex items-start gap-2.5", className)}>
          <div className="pt-0.5">{children}</div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor={id} className="text-sm font-normal text-foreground">
              {label}
            </Label>
            {description && <HelpText id={descId}>{description}</HelpText>}
            {error && <FieldError id={errId}>{error}</FieldError>}
          </div>
        </div>
      </Ctx.Provider>
    );
  }
  return (
    <Ctx.Provider value={ctx}>
      <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        <Label htmlFor={id}>{label}</Label>
        {children}
        {description && <HelpText id={descId}>{description}</HelpText>}
        {error && <FieldError id={errId}>{error}</FieldError>}
      </div>
    </Ctx.Provider>
  );
}
