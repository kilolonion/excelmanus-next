import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  view: null as unknown,
  effect: null as null | (() => (() => void) | undefined),
  refs: [] as unknown[],
  cursor: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [h.view, (value: unknown) => (h.view = value)],
  useRef: () => ({ current: h.refs[h.cursor++] }),
  useEffect: (effect: () => (() => void) | undefined) => (h.effect = effect),
}));
vi.mock("../src/components/excel/WorkbookObject", () => ({
  WorkbookObject: ({ popup }: { popup: { extraProps: Record<string, unknown> } }) =>
    createElement("i", null, popup.extraProps.shape ? "shape" : "other"),
}));

import { WorkbookObjectsLayer } from "../src/components/excel/WorkbookObjectsLayer";

afterEach(() => vi.unstubAllGlobals());
test("live overlay passes shape objects and adds offsets before zooming anchor positions", () => {
  let frame!: () => void;
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => {
    frame = f;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const layer = { style: { cssText: "" } };
  const imageNode = { style: { cssText: "" } };
  const shapeNode = { style: { cssText: "" } };
  h.view = null;
  h.refs = [
    layer,
    new Map([
      ["image", imageNode],
      ["shape", shapeNode],
    ]),
  ];
  const object = { anchor: "A1", width: 80, height: 40, title: "", offsetX: 11, offsetY: 7 };
  const data = {
    custom: {
      excelmanusObjects: {
        charts: [],
        images: [{ ...object, id: "image", mediaType: "image/png" }],
        shapes: [{ ...object, id: "shape", type: "rect", text: "" }],
      },
    },
  };
  const sheet = {
    getSheetId: () => "s",
    getSheet: () => ({ getSnapshot: () => data }),
    getRange: () => ({
      getCellRect: () => ({ left: 46, top: 20, right: 126 }),
    }),
    getZoom: () => 2,
    getScrollState: () => ({
      sheetViewStartRow: 0,
      sheetViewStartColumn: 0,
      offsetX: 0,
      offsetY: 0,
    }),
  };
  const canvas = {
    clientWidth: 900,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600 }),
  };
  const props = {
    api: { wb: { getActiveSheet: () => sheet } },
    host: { querySelectorAll: () => [canvas] },
    docId: "doc",
    revision: 1,
    sheetKey: "s",
    ready: 1,
  } as unknown as Parameters<typeof WorkbookObjectsLayer>[0];
  const render = () => {
    h.cursor = 0;
    return renderToString(createElement(WorkbookObjectsLayer, props));
  };
  render();
  const cleanup = h.effect?.();
  expect(render()).toContain(">shape<");
  frame();
  expect(imageNode.style.cssText).toContain("left:22px;top:14px;");
  expect(shapeNode.style.cssText).toContain("left:22px;top:14px;");
  cleanup?.();
});
