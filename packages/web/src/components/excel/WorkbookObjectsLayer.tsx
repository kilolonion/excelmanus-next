import { parseRange } from "@excelmanus/core";
import {
  type ChartObject,
  type ImageObject,
  OBJECT_LAYER_MUTATION,
  type ShapeObject,
  WorkbookObjects,
} from "@excelmanus/protocol";
import { useEffect, useRef, useState } from "react";
import { trackCanvasCandidates } from "@/lib/workbook/canvas-candidates";
import type { SheetApi } from "./FormatToolbar";
import { WorkbookObject } from "./WorkbookObject";

type Props = {
  api: SheetApi | null;
  host: HTMLDivElement | null;
  docId: string | undefined;
  revision: number | undefined;
  sheetKey: string | null;
  ready: number;
  captureReadonly?: boolean;
};
type NoteMark = {
  id: string;
  anchor: string;
  title: string;
  width: number;
  height: number;
  note: true;
  threaded?: boolean;
};
type Item = {
  object: ChartObject | ImageObject | ShapeObject | NoteMark;
  popup: { extraProps: Record<string, unknown> };
};
/** Canvas-owned clipped layer: objects never reflow the page or move to fit its edge. */
export function WorkbookObjectsLayer({
  api,
  host,
  docId,
  revision,
  sheetKey,
  ready,
  captureReadonly = false,
}: Props) {
  const clip = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{
    api: Props["api"];
    docId: Props["docId"];
    sheetKey: Props["sheetKey"];
    ready: number;
    items: Item[];
  } | null>(null);
  const items =
    view?.api === api &&
    view?.docId === docId &&
    view?.sheetKey === sheetKey &&
    view?.ready === ready
      ? view.items
      : [];
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const parsedObjects = useRef<{
    api: Props["api"];
    snapshot: unknown;
    source: unknown;
    parsed: ReturnType<typeof WorkbookObjects.safeParse>;
  } | null>(null);
  useEffect(() => {
    const setItems = (items: Item[]) => setView({ api, docId, sheetKey, ready, items });
    void revision;
    void sheetKey;
    void ready;
    const sheet = api && !api.disposed ? api.wb.getActiveSheet() : null;
    if (!api || !sheet || !host || !docId) {
      parsedObjects.current = null;
      setItems([]);
      return;
    }
    // Read the live active sheet; saving serializes and clones the entire workbook.
    const data = sheet.getSheet().getSnapshot();
    const source = data?.custom?.excelmanusObjects;
    // Object mutations replace metadata; ordinary cell revisions retain it.
    // A replaced snapshot must still invalidate image bytes even with identical metadata.
    let cached = parsedObjects.current;
    if (!cached || cached.api !== api || cached.snapshot !== data || cached.source !== source) {
      cached = { api, snapshot: data, source, parsed: WorkbookObjects.safeParse(source) };
      parsedObjects.current = cached;
    }
    const parsed = cached.parsed;
    if (!parsed.success) {
      setItems([]);
      return;
    }
    const all: Item["object"][] = [
      ...parsed.data.charts,
      ...parsed.data.images,
      ...(parsed.data.shapes ?? []),
      ...(parsed.data.threadedComments ?? [])
        .filter((c) => !c.parentId && !c.done)
        .map((c) => ({
          id: `thread-${c.id}`,
          anchor: c.ref,
          title: `批注 · ${c.author}：${c.text}`,
          width: 10,
          height: 10,
          note: true as const,
          threaded: true,
        })),
      ...(parsed.data.notes ?? []).map((note) => ({
        id: `note-${note.ref}`,
        anchor: note.ref,
        title: `${note.author ? note.author + "：" : ""}${note.text}`,
        width: 10,
        height: 10,
        note: true as const,
      })),
    ];
    setItems(
      all.map((object) => ({
        object,
        popup: {
          extraProps: {
            ...("note" in object
              ? { note: object }
              : "range" in object
                ? { chart: object, cells: data?.cellData ?? {}, revision }
                : "type" in object
                  ? { shape: object }
                  : { image: object }),
            docId,
            sheetId: sheet.getSheetId(),
            captureReadonly,
            onDelete: captureReadonly
              ? undefined
              : async () => {
                  const current = WorkbookObjects.parse(
                    api.wb.getSheetBySheetId(sheet.getSheetId())?.getSheet().getSnapshot().custom
                      ?.excelmanusObjects,
                  );
                  current.images = current.images.filter((image) => image.id !== object.id);
                  if (
                    !(await api.univerAPI.executeCommand(OBJECT_LAYER_MUTATION, {
                      unitId: api.wb.getId(),
                      subUnitId: sheet.getSheetId(),
                      objects: current,
                    }))
                  )
                    throw new Error("图片删除未完成");
                },
          },
        },
      })),
    );
    if (!all.length) return;
    const ranges = new Map<string, ReturnType<typeof sheet.getRange>>();
    const fixedRange = (row: number, column: number) => {
      const key = `${row}:${column}`;
      let range = ranges.get(key);
      if (!range) {
        range = sheet.getRange(row, column, 1, 1);
        ranges.set(key, range);
      }
      return range;
    };
    const originRange = fixedRange(0, 0);
    const anchors = all.map((object) => {
      const range = parseRange(object.anchor);
      return { object, range: fixedRange(range.startRow - 1, range.startCol - 1) };
    });
    let scrollKey = "0:0";
    let scrollRange = originRange;
    // Cell rectangles are unscaled sheet coordinates, independent of viewport scrolling.
    // Weak keys avoid retaining ranges for every row visited while scrolling.
    let rects = new WeakMap<ReturnType<typeof sheet.getRange>, DOMRect>();
    const invalidateRects = () => {
      rects = new WeakMap();
    };
    const commands = api.wb.onCommandExecuted?.((command) => {
      if (
        command.id !== "sheet.operation.set-scroll" &&
        command.id !== "sheet.operation.set-selections"
      )
        invalidateRects();
    });
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    fonts?.addEventListener("loadingdone", invalidateRects);
    let geometry = "";
    let previousCanvas: HTMLCanvasElement | undefined;
    const cellRect = (range: ReturnType<typeof sheet.getRange>) => {
      let rect = rects.get(range);
      if (!rect) {
        rect = range.getCellRect();
        rects.set(range, rect);
      }
      return rect;
    };
    const layoutStyles = new WeakMap<HTMLElement, string>();
    const applyStyle = (node: HTMLElement, css: string) => {
      if (layoutStyles.get(node) === css) return;
      node.style.cssText = css;
      layoutStyles.set(node, css);
    };
    let lastPlacement = "";
    let lastRects: typeof rects | undefined;
    const canvases = trackCanvasCandidates(host);
    let frame = 0;
    const update = () => {
      // The editor can dispose before this sibling effect is cleaned up.
      if (api.disposed) return;
      frame = requestAnimationFrame(update);
      if (api.rendered === false) return;
      const layer = clip.current;
      // The sheet canvas is the largest visible canvas, not the formula-bar editor.
      const canvas = canvases.current();
      if (layer && canvas) {
        const bounds = canvas.getBoundingClientRect();
        const zoom = sheet.getZoom();
        const nextGeometry = `${zoom}:${canvas.clientWidth}:${canvas.clientHeight}`;
        if (canvas !== previousCanvas || geometry !== nextGeometry) {
          invalidateRects();
          previousCanvas = canvas;
          geometry = nextGeometry;
        }
        const scroll = sheet.getScrollState();
        let origin: DOMRect;
        let start: DOMRect;
        try {
          const key = `${scroll.sheetViewStartRow}:${scroll.sheetViewStartColumn}`;
          if (key !== scrollKey) {
            scrollRange =
              ranges.get(key) ??
              sheet.getRange(scroll.sheetViewStartRow, scroll.sheetViewStartColumn, 1, 1);
            scrollKey = key;
          }
          origin = cellRect(originRange);
          start = cellRect(scrollRange);
        } catch {
          return; // The sheet skeleton may not be ready during the first paint.
        }
        const scrollX = start.left - origin.left + scroll.offsetX;
        const scrollY = start.top - origin.top + scroll.offsetY;
        const left = Math.max(
          0,
          bounds.left + (data?.rowHeader?.hidden ? 0 : (data?.rowHeader?.width ?? 46) * zoom),
        );
        const top = Math.max(
          0,
          bounds.top + (data?.columnHeader?.hidden ? 0 : (data?.columnHeader?.height ?? 20) * zoom),
        );
        const width = Math.max(0, Math.min(window.innerWidth, bounds.right) - left);
        const height = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - top);
        applyStyle(
          layer,
          `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden;pointer-events:none;z-index:8`,
        );
        const placement = `${scrollX}:${scrollY}:${zoom}:${bounds.left - left}:${bounds.top - top}:${nodes.current.size}`;
        if (placement === lastPlacement && lastRects === rects) return;
        lastPlacement = placement;
        lastRects = rects;
        for (const { object, range } of anchors) {
          const node = nodes.current.get(object.id);
          if (!node) continue;
          let cell: DOMRect;
          try {
            cell = cellRect(range);
          } catch {
            lastRects = undefined; // Retry an anchor whose skeleton is not ready yet.
            continue;
          }
          applyStyle(
            node,
            `position:absolute;left:${(("note" in object ? cell.right - object.width : cell.left) + ("offsetX" in object ? (object.offsetX ?? 0) : 0) - scrollX) * zoom + bounds.left - left}px;top:${(cell.top + ("offsetY" in object ? (object.offsetY ?? 0) : 0) - scrollY) * zoom + bounds.top - top}px;transform:scale(${zoom});transform-origin:top left;width:${object.width}px;height:${object.height}px;pointer-events:auto`,
          );
        }
      }
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      canvases.dispose();
      commands?.dispose();
      fonts?.removeEventListener("loadingdone", invalidateRects);
    };
  }, [api, host, docId, revision, sheetKey, ready, captureReadonly]);
  return (
    <div
      data-em-workbook-objects=""
      ref={clip}
      style={{ position: "fixed", visibility: "hidden", pointerEvents: "none" }}
    >
      {items.map(({ object, popup }) => (
        <div
          key={JSON.stringify([popup.extraProps.docId, popup.extraProps.sheetId, object.id])}
          ref={(node) => {
            if (node) nodes.current.set(object.id, node);
            else nodes.current.delete(object.id);
          }}
        >
          <WorkbookObject popup={popup} />
        </div>
      ))}
    </div>
  );
}
