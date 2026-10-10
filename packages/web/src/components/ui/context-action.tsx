import { type ReactNode, useRef, useState } from "react";
import { Button } from "./button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

/** 为画布提供一项可键盘访问的上下文操作，不接管其单元格编辑命令。 */
export function ContextAction({
  children,
  label,
  enabled,
  onSelect,
}: {
  children: ReactNode;
  label: string;
  enabled: boolean;
  onSelect(): void;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const focusBefore = useRef<HTMLElement | null>(null);
  const actionChosen = useRef(false);
  const rememberFocus = () => {
    focusBefore.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actionChosen.current = false;
  };
  return (
    <DropdownMenu
      open={point !== null && enabled}
      onOpenChange={(open) => {
        if (!open) setPoint(null);
      }}
      modal={false}
    >
      <fieldset
        className="relative m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0"
        aria-label={label}
        onContextMenuCapture={(event) => {
          if (!enabled) return;
          event.preventDefault();
          event.stopPropagation();
          rememberFocus();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (enabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            rememberFocus();
            const rect = event.currentTarget.getBoundingClientRect();
            setPoint({ x: rect.left + 32, y: rect.top + 32 });
          }
        }}
      >
        {children}
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={label}
            tabIndex={-1}
            style={{
              position: "fixed",
              left: point?.x ?? 0,
              top: point?.y ?? 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!actionChosen.current) focusBefore.current?.focus({ preventScroll: true });
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              actionChosen.current = true;
              setPoint(null);
              onSelect();
            }}
          >
            {label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </fieldset>
    </DropdownMenu>
  );
}
