import {
  FormatPainterSessionService,
  IFormatPainterService,
  ILayoutService,
} from "@univerjs/preset-sheets-core";
import { ChevronDown, Paintbrush } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toaster";
import type { SheetApi } from "./FormatToolbar";

const focusGrid = (api: SheetApi) => api.univer.__getInjector().get(ILayoutService).focus();

const installed = new WeakSet<object>();
export function FormatPainter({ api, disabled }: { api: SheetApi | null; disabled: boolean }) {
  const [mode, setMode] = useState<"off" | "once" | "continuous">("off");
  useEffect(() => {
    if (!api) {
      setMode("off");
      return;
    }
    const injector = api.univer.__getInjector();
    const session = injector.get(FormatPainterSessionService),
      painter = injector.get(IFormatPainterService);
    if (!installed.has(painter)) {
      installed.add(painter);
      painter.addHook({
        id: "excelmanus-format-only",
        priority: 100,
        onStatusChange: (status) => {
          if (status) {
            const format = painter.getSelectionFormat();
            painter.setSelectionFormat({ ...format, merges: [] });
          }
        },
        onBeforeApply: ({ range }) => {
          if (
            (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) >
            20000
          ) {
            toast({ tone: "error", title: "一次最多刷 20,000 格，请缩小目标选区" });
            return false;
          }
          return true;
        },
      });
    }
    const sub = session.state$.subscribe(setMode);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.mode !== "off") {
        session.cancel();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onEscape, true);
    return () => {
      sub.unsubscribe();
      window.removeEventListener("keydown", onEscape, true);
      if (!api.disposed) session.cancel();
    };
  }, [api]);
  const activate = async (continuous = false) => {
    if (!api || disabled) return;
    const session = api.univer.__getInjector().get(FormatPainterSessionService);
    if (session.mode !== "off") {
      session.cancel();
      focusGrid(api);
      return;
    }
    await api.wb.endEditingAsync(true);
    const range = api.wb.getActiveSheet()?.getSelection()?.getActiveRange()?.getRange();
    if (!range) return;
    if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 20000) {
      toast({ tone: "error", title: "一次最多复制 20,000 格的格式" });
      return;
    }
    if (!session.activate(continuous)) {
      toast({ tone: "error", title: "请先选择格式来源区域" });
      return;
    }
    toast({
      title: continuous
        ? "连续格式刷已开启，选择目标区域，Esc 结束"
        : "格式已复制，选择目标区域应用，Esc 取消",
    });
    focusGrid(api);
  };
  return (
    <span className="inline-flex shrink-0 items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-7 w-7"
        aria-label={mode === "off" ? "格式刷" : "取消格式刷"}
        title={mode === "continuous" ? "连续格式刷，Esc 结束" : "格式刷"}
        aria-pressed={mode !== "off"}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void activate()}
      >
        <Paintbrush className="size-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="w-4"
            aria-label="格式刷选项"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={() => void activate(true)}>
            {mode === "off" ? "连续格式刷" : "结束格式刷"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
