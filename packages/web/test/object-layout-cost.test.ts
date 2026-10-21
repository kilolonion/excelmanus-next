import { Styles, Worksheet } from "@univerjs/core";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refs: [] as unknown[],
  cursor: 0,
  effect: null as null | (() => (() => void) | undefined),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: mocks.refs[mocks.cursor++] }),
  useEffect: (effect: () => (() => void) | undefined) => {
    mocks.effect = effect;
  },
}));
vi.mock("../src/components/excel/WorkbookObject", () => ({ WorkbookObject: () => null }));

import { WorkbookObjectsLayer } from "../src/components/excel/WorkbookObjectsLayer";

afterEach(() => vi.unstubAllGlobals());
test.each([1, 100])(
  "stationary layers with %i objects reuse geometry and skip repeated placement",
  (count) => {
    let frame!: () => void;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    const layerWrite = vi.fn(),
      objectWrite = vi.fn();
    const layer = {
      style: {
        set cssText(value: string) {
          layerWrite(value);
        },
      },
    };
    const node = {
      style: {
        set cssText(value: string) {
          objectWrite(value);
        },
      },
    };
    const nodes = new Map(
      Array.from({ length: count }, (_, i) => [`chart${i}`, { style: node.style }]),
    );
    const nodeLookup = vi.spyOn(nodes, "get");
    mocks.refs = [layer, nodes];
    mocks.cursor = 0;
    let scrollX = 0;
    let startRow = 0;
    let zoom = 1;
    let command!: (c: { id: string }) => void;
    const dispose = vi.fn();
    const getCellRect = vi.fn(() => ({ left: 0, top: 0, right: 80 }));
    const getRange = vi.fn(() => ({ getCellRect }));
    const sheet = {
      getSheetId: () => "sheet",
      getZoom: () => zoom,
      getScrollState: () => ({
        sheetViewStartRow: startRow,
        sheetViewStartColumn: 0,
        offsetX: scrollX,
        offsetY: 0,
      }),
      getRange,
    };
    const data = {
      custom: {
        excelmanusObjects: {
          images: [],
          charts: Array.from({ length: count }, (_, i) => ({
            id: `chart${i}`,
            type: "column",
            title: "test",
            range: "A1:B2",
            anchor: "A1",
            width: 200,
            height: 100,
          })),
        },
      },
    };
    const save = vi.fn(() => ({ sheets: { sheet: data } }));
    const api = {
      wb: {
        onCommandExecuted: (callback: typeof command) => {
          command = callback;
          return { dispose };
        },
        getActiveSheet: () => ({
          ...sheet,
          getSheet: () => ({ getSnapshot: () => data }),
        }),
        save,
      },
    };
    const canvas = {
      clientWidth: 900,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600 }),
    };
    const querySelectorAll = vi.fn(() => [canvas]);
    const host = { querySelectorAll };
    const disconnect = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    renderToString(
      createElement(WorkbookObjectsLayer, {
        api,
        host,
        docId: "doc",
        revision: 1,
        sheetKey: "sheet",
        ready: 1,
      } as unknown as Parameters<typeof WorkbookObjectsLayer>[0]),
    );
    const cleanup = mocks.effect?.();
    expect(save).not.toHaveBeenCalled();
    frame();
    frame();
    expect(layerWrite).toHaveBeenCalledTimes(1);
    expect(objectWrite).toHaveBeenCalledTimes(count);
    expect(getRange).toHaveBeenCalledTimes(1);
    expect(getCellRect).toHaveBeenCalledTimes(1);
    expect(nodeLookup).toHaveBeenCalledTimes(count);
    for (let i = 0; i < 60; i++) frame();
    expect(nodeLookup).toHaveBeenCalledTimes(count);
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    scrollX = 20;
    frame();
    expect(objectWrite).toHaveBeenCalledTimes(count * 2);
    startRow = 3;
    frame();
    frame();
    expect(getRange).toHaveBeenCalledTimes(2);
    expect(getRange).toHaveBeenLastCalledWith(3, 0, 1, 1);
    expect(getCellRect).toHaveBeenCalledTimes(2);
    command({ id: "sheet.operation.set-scroll" });
    command({ id: "sheet.operation.set-selections" });
    frame();
    expect(getCellRect).toHaveBeenCalledTimes(2);
    command({ id: "sheet.mutation.set-row-height" });
    frame();
    expect(getCellRect).toHaveBeenCalledTimes(4);
    zoom = 1.5;
    frame();
    expect(getCellRect).toHaveBeenCalledTimes(6);
    canvas.clientWidth = 800;
    frame();
    expect(getCellRect).toHaveBeenCalledTimes(8);
    cleanup?.();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  },
);

test("worksheet snapshot exposes current cells and object metadata without workbook serialization", () => {
  const sheet = new Worksheet(
    "unit",
    { id: "sheet", cellData: { 0: { 0: { v: 10 } } } },
    new Styles(),
  );
  sheet.getCellMatrix().setValue(0, 0, { v: 20 });
  sheet.setCustomMetadata({ excelmanusObjects: { images: [], charts: [] } });
  expect(sheet.getSnapshot().cellData[0]?.[0]?.v).toBe(20);
  expect(sheet.getSnapshot().custom).toEqual({ excelmanusObjects: { images: [], charts: [] } });
});
