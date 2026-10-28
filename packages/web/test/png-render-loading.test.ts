import type { RenderLayout } from "@excelmanus/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  init: vi.fn(),
  use: vi.fn(),
  full: vi.fn(),
  dispose: vi.fn(),
  option: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("echarts", () => {
  h.full();
  return { init: h.init };
});
vi.mock("echarts/core", () => ({ init: h.init, use: h.use }));
vi.mock("echarts/charts", () => ({
  BarChart: "bar",
  LineChart: "line",
  PieChart: "pie",
  ScatterChart: "scatter",
}));
vi.mock("echarts/components", () => ({
  TitleComponent: "title",
  TooltipComponent: "tooltip",
  LegendComponent: "legend",
  GridComponent: "grid",
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: "canvas" }));

vi.mock("echarts/features", () => ({
  LabelLayout: "label-layout",
  LegacyGridContainLabel: "contain-label",
}));

import { renderLayoutToPng } from "../src/lib/backend/render";

let context: Record<string, ReturnType<typeof vi.fn>>, toBlob: ReturnType<typeof vi.fn>;
const layout = {
  width: 400,
  height: 300,
  cells: [],
  charts: [
    {
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      chart: { type: "column", title: "QA", range: "A1:B2" },
      cells: { 0: { 0: { v: "name" }, 1: { v: "value" } }, 1: { 0: { v: "a" }, 1: { v: 12 } } },
    },
  ],
} as unknown as RenderLayout;
beforeEach(() => {
  vi.clearAllMocks();
  context = Object.fromEntries(
    ["scale", "fillRect", "save", "beginPath", "rect", "clip", "drawImage", "restore"].map(
      (key) => [key, vi.fn()],
    ),
  );
  toBlob = vi.fn((done: (blob: Blob) => void) => done(new Blob(["png"])));
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context, toBlob }) });
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = h.decode;
    },
  );
  h.init.mockReturnValue({ setOption: h.option, renderToCanvas: () => ({}), dispose: h.dispose });
  h.decode.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
test("PNG charts use only supported modular chart types and the canvas renderer", async () => {
  expect(await renderLayoutToPng(layout, 1)).toBe(btoa("png"));
  expect(h.full).not.toHaveBeenCalled();
  expect(h.use).toHaveBeenCalledWith([
    "bar",
    "line",
    "pie",
    "scatter",
    "title",
    "tooltip",
    "legend",
    "grid",
    "canvas",
    "label-layout",
    "contain-label",
  ]);
  expect(h.option.mock.lastCall?.[0].series[0].data).toEqual([12]);
  expect(h.dispose).toHaveBeenCalledTimes(1);
});
test("closing while chart modules load skips chart creation and PNG encoding", async () => {
  let active = true;
  const pending = renderLayoutToPng(layout, 1, () => active);
  active = false;
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(h.init).not.toHaveBeenCalled();
  expect(toBlob).not.toHaveBeenCalled();
});
test("closing during image decode skips drawing and later images", async () => {
  let active = true,
    finish!: () => void;
  h.decode.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const images: NonNullable<RenderLayout["images"]> = [
    { mediaType: "image/png", data: "AA==", x: 0, y: 0, w: 10, h: 10 },
    { mediaType: "image/png", data: "AA==", x: 10, y: 0, w: 10, h: 10 },
  ];
  const pending = renderLayoutToPng({ ...layout, charts: [], images }, 1, () => active);
  active = false;
  finish();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(h.decode).toHaveBeenCalledTimes(1);
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(toBlob).not.toHaveBeenCalled();
});
test("closing during PNG encoding skips the byte copy and base64 pass", async () => {
  let active = true,
    finish!: (blob: Blob) => void;
  toBlob.mockImplementationOnce((done: typeof finish) => {
    finish = done;
  });
  const pending = renderLayoutToPng({ ...layout, charts: [] }, 1, () => active);
  const blob = new Blob(["png"]);
  const read = vi.spyOn(blob, "arrayBuffer");
  active = false;
  finish(blob);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(read).not.toHaveBeenCalled();
});
