import { Minus, Plus } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseZoomPercent } from "@/lib/workbook/zoom";
import type { SheetApi } from "./FormatToolbar";

export function WorkbookZoom({ api, ready }: { api: SheetApi | null; ready: number }) {
  const [zoom, setZoom] = useState(100);
  const [draft, setDraft] = useState("100%");
  const editing = useRef(false);
  useEffect(() => {
    void ready;
    if (!api) return;
    const update = () => {
      const percent = Math.round((api.wb.getActiveSheet()?.getZoom() ?? 1) * 100);
      setZoom(percent);
      if (!editing.current) setDraft(`${percent}%`);
    };
    update();
    let frame = 0;
    const sub = api.wb.onCommandExecuted((command) => {
      if (
        command.id === "sheet.operation.set-scroll" ||
        command.id === "sheet.operation.set-selections" ||
        frame
      )
        return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      sub.dispose();
    };
  }, [api, ready]);
  const apply = (value: number) => {
    const percent = Math.min(400, Math.max(10, value));
    editing.current = false;
    const sheet = api?.wb.getActiveSheet();
    if (api && sheet)
      api.univerAPI.syncExecuteCommand("sheet.operation.set-zoom-ratio", {
        unitId: api.wb.getId(),
        subUnitId: sheet.getSheetId(),
        zoomRatio: percent / 100,
      });
    const actual = Math.round((api?.wb.getActiveSheet()?.getZoom() ?? 1) * 100);
    setZoom(actual);
    setDraft(`${actual}%`);
  };
  const commit = () => {
    if (!editing.current) return;
    apply(parseZoomPercent(draft) ?? zoom);
  };
  return (
    <div className="em-workbook-zoom" role="toolbar" aria-label="工作表缩放">
      <Button
        size="icon"
        variant="ghost"
        className="em-workbook-zoom-button"
        aria-label="缩小"
        disabled={!api || zoom <= 10}
        onClick={() => apply(zoom - 10)}
      >
        <Minus className="h-3 w-3" />
      </Button>
      <Input
        type="range"
        aria-label="缩放滑块"
        min={10}
        max={400}
        step={1}
        value={zoom}
        className="em-workbook-zoom-slider"
        disabled={!api}
        style={{ "--zoom-progress": `${((zoom - 10) / 390) * 100}%` } as CSSProperties}
        onChange={(e) => apply(Number(e.target.value))}
      />
      <Button
        size="icon"
        variant="ghost"
        className="em-workbook-zoom-button"
        aria-label="放大"
        disabled={!api || zoom >= 400}
        onClick={() => apply(zoom + 10)}
      >
        <Plus className="h-3 w-3" />
      </Button>
      <Input
        aria-label="缩放"
        className="em-workbook-zoom-value"
        disabled={!api}
        value={draft}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            editing.current = false;
            setDraft(`${zoom}%`);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
