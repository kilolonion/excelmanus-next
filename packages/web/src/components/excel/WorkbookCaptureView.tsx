import { formatRange } from "@excelmanus/core";
import {
  WorkbookCapturePacket,
  type WorkbookCaptureReceipt,
  WorkbookObjects,
} from "@excelmanus/protocol";
import { CommandType } from "@univerjs/core";
import type { SheetApi } from "./FormatToolbar";

type Bounds = WorkbookCapturePacket["bounds"];
type Rect = { left: number; top: number; right: number; bottom: number };
type Freeze = { xSplit?: number; ySplit?: number };
const hasFrozenPanes = (freeze?: Freeze) => (freeze?.xSplit ?? 0) > 0 || (freeze?.ySplit ?? 0) > 0;

const intersects = (rect: Rect, clip: Rect) =>
  rect.right > clip.left &&
  rect.left < clip.right &&
  rect.bottom > clip.top &&
  rect.top < clip.bottom;

export function captureObjectsReady(
  objects: { rect: Rect; ready: boolean; error?: string }[],
  clip: Rect,
): boolean {
  return objects
    .filter((object) => intersects(object.rect, clip))
    .every((object) => {
      if (object.error) throw new Error(object.error);
      return object.ready;
    });
}

/** Only local view operations and engine-derived calculation may run in a capture. */
export function assertCaptureCommand(
  command: { id: string; type?: number },
  options?: Record<string, unknown>,
): void {
  if (command.type !== CommandType.MUTATION) return;
  if (
    (command.id.startsWith("formula.mutation.") &&
      !["formula.mutation.set-defined-name", "formula.mutation.remove-defined-name"].includes(
        command.id,
      )) ||
    command.id === "sheet.mutation.re-calc-filter" ||
    (command.id === "sheet.mutation.set-range-values" &&
      options?.applyFormulaCalculationResult === true)
  )
    return;
  throw new Error(`只读截图禁止修改工作簿：${command.id}`);
}

export function prepareCapturePacket(input: unknown): WorkbookCapturePacket {
  const packet = structuredClone(WorkbookCapturePacket.parse(input));
  const custom = packet.snapshot.sheets[packet.sheetId].custom as
    | Record<string, unknown>
    | undefined;
  if (custom?.excelmanusObjects !== undefined) WorkbookObjects.parse(custom.excelmanusObjects);
  return packet;
}

export function captureCoverage(
  requested: Bounds,
  visible: Bounds,
  content: Rect,
  clip: Rect,
  freeze?: Freeze,
): boolean {
  return (
    !hasFrozenPanes(freeze) &&
    requested.startRow >= visible.startRow &&
    requested.endRow <= visible.endRow &&
    requested.startColumn >= visible.startColumn &&
    requested.endColumn <= visible.endColumn &&
    content.left >= clip.left &&
    content.top >= clip.top &&
    content.right <= clip.right &&
    content.bottom <= clip.bottom
  );
}

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
const rangeLabel = (range: Bounds) =>
  formatRange({
    startRow: range.startRow + 1,
    endRow: range.endRow + 1,
    startCol: range.startColumn + 1,
    endCol: range.endColumn + 1,
  });

async function waitForCapture(
  packet: WorkbookCapturePacket,
  host: HTMLElement,
  currentApi: () => SheetApi | null,
  cancelled: () => boolean,
): Promise<WorkbookCaptureReceipt> {
  let positioned = false;
  const custom = packet.snapshot.sheets[packet.sheetId].custom as
    | Record<string, unknown>
    | undefined;
  const objects = WorkbookObjects.parse(custom?.excelmanusObjects ?? { charts: [], images: [] });
  const expected = [...objects.charts, ...objects.images, ...(objects.shapes ?? [])];
  while (!cancelled()) {
    const api = currentApi();
    if (!api?.rendered || api.disposed) {
      await pause();
      continue;
    }
    const sheet = api.wb.getSheetBySheetId(packet.sheetId);
    if (!sheet) throw new Error("截图工作表不存在");
    if (!positioned) {
      api.wb.setActiveSheet(sheet);
      sheet.zoom(1);
      sheet.scrollToCell(packet.bounds.startRow, packet.bounds.startColumn, 0);
      positioned = true;
      await frames();
      await document.fonts.ready;
      continue;
    }
    if (
      api.wb.getId() !== packet.snapshot.id ||
      api.wb.getActiveSheet()?.getSheetId() !== packet.sheetId ||
      sheet.getZoom() !== 1
    )
      throw new Error("截图视图标识或缩放发生变化");
    const nodes = [...host.querySelectorAll<HTMLElement>("[data-em-workbook-object]")];
    const byId = new Map(nodes.map((node) => [node.dataset.emWorkbookObject, node]));
    const layer = host.querySelector<HTMLElement>("[data-em-workbook-objects]");
    const placed = expected.every((object) => {
      const node = byId.get(object.id);
      return node?.parentElement?.style.left && getComputedStyle(node).visibility !== "hidden";
    });
    if (expected.length && (!placed || !layer)) {
      await pause();
      continue;
    }
    const objectClip = layer?.getBoundingClientRect() ?? host.getBoundingClientRect();
    const visibleNodes = nodes.filter((node) =>
      intersects(node.getBoundingClientRect(), objectClip),
    );
    const rendered = captureObjectsReady(
      expected.map((object) => {
        const node = byId.get(object.id);
        if (!node) throw new Error("截图对象尚未挂载");
        const image = node.querySelector("img");
        return {
          rect: node.getBoundingClientRect(),
          error: node.dataset.emCaptureError,
          ready:
            "range" in object
              ? !!node.querySelector("svg path, svg rect, svg text")
              : !!(image?.complete && image.naturalWidth > 0),
        };
      }),
      objectClip,
    );
    const images = visibleNodes.flatMap((node) => [
      ...node.querySelectorAll<HTMLImageElement>("img"),
    ]);
    if (images.some((image) => image.complete && image.getAttribute("src") && !image.naturalWidth))
      throw new Error("截图图片解码失败");
    const canvas = [...host.querySelectorAll<HTMLCanvasElement>(".univer-host canvas")].sort(
      (a, b) => b.clientHeight - a.clientHeight,
    )[0];
    const visible = sheet.getVisibleRange();
    if (!rendered || !canvas?.clientWidth || !visible || document.fonts.status !== "loaded") {
      await pause();
      continue;
    }
    await Promise.all(images.map((image) => image.decode()));
    await frames();
    if (cancelled() || api.disposed) throw new Error("截图已取消");
    const scroll = sheet.getScrollState();
    const origin = sheet.getRange(0, 0, 1, 1).getCellRect();
    const start = sheet
      .getRange(scroll.sheetViewStartRow, scroll.sheetViewStartColumn, 1, 1)
      .getCellRect();
    const scrollX = start.left - origin.left + scroll.offsetX;
    const scrollY = start.top - origin.top + scroll.offsetY;
    const first = sheet
      .getRange(packet.bounds.startRow, packet.bounds.startColumn, 1, 1)
      .getCellRect();
    const last = sheet.getRange(packet.bounds.endRow, packet.bounds.endColumn, 1, 1).getCellRect();
    const bounds = canvas.getBoundingClientRect();
    const content = {
      left: bounds.left + first.left - scrollX,
      top: bounds.top + first.top - scrollY,
      right: bounds.left + last.right - scrollX,
      bottom: bounds.top + last.bottom - scrollY,
    };
    const data = sheet.getSheet().getSnapshot();
    const clip = {
      left: bounds.left + (data.rowHeader?.hidden ? 0 : (data.rowHeader?.width ?? 46)),
      top: bounds.top + (data.columnHeader?.hidden ? 0 : (data.columnHeader?.height ?? 20)),
      right: Math.min(bounds.right, window.innerWidth),
      bottom: Math.min(bounds.bottom, window.innerHeight),
    };
    return {
      docId: packet.docId,
      sheetId: packet.sheetId,
      rev: packet.rev,
      requestedRange: packet.range,
      visibleRange: rangeLabel(visible),
      fullyVisible: captureCoverage(packet.bounds, visible, content, clip, data.freeze),
      ...(hasFrozenPanes(data.freeze)
        ? {
            warnings: [
              "含冻结窗格：visibleRange 仅描述主滚动窗格；冻结窗格虽实际入图，但未计入覆盖声明，本次仅作部分截图。",
            ],
          }
        : {}),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio,
      zoom: 1,
      scroll: { row: scroll.sheetViewStartRow, column: scroll.sheetViewStartColumn },
    };
  }
  throw new Error("截图已取消");
}

declare global {
  interface Window {
    excelmanusCapture?: { mount(packet: WorkbookCapturePacket): Promise<WorkbookCaptureReceipt> };
  }
}

/** This entry never initializes authentication, backend APIs, Root, or a sync channel. */
export function startWorkbookCapturePage(): void {
  let mounted = false;
  window.excelmanusCapture = {
    async mount(input) {
      if (mounted) throw new Error("截图页面只能挂载一个冻结快照");
      mounted = true;
      const packet = prepareCapturePacket(input);
      if (
        window.innerWidth !== packet.viewport.width ||
        window.innerHeight !== packet.viewport.height ||
        window.devicePixelRatio !== packet.dpr
      )
        throw new Error("截图浏览器尺寸与请求不一致");
      const [{ createRoot }, { createElement }, { UniverSheet }] = await Promise.all([
        import("react-dom/client"),
        import("react"),
        import("./UniverSheet"),
      ]);
      const host = document.getElementById("root");
      if (!host) throw new Error("缺少截图容器");
      document.documentElement.classList.remove("dark");
      document.documentElement.style.colorScheme = "light";
      host.style.cssText =
        "position:relative;width:100vw;height:100vh;overflow:hidden;background:white;pointer-events:none";
      host.setAttribute("data-em-capture-view", "");
      const root = createRoot(host);
      let api: SheetApi | null = null;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      root.render(
        createElement(UniverSheet, {
          capturePacket: packet,
          visibility: { activity: false, pending: false, changed: false },
          changes: [],
          onApi: (value) => {
            api = value;
          },
          onAsk() {},
          onReference() {},
        }),
      );
      try {
        return await Promise.race([
          waitForCapture(
            packet,
            host,
            () => api,
            () => cancelled,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("真实视图截图超时：表格、字体、图片或图表尚未就绪")),
              15_000,
            );
          }),
        ]);
      } catch (error) {
        cancelled = true;
        root.unmount();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
