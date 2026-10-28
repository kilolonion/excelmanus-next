import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  effect: undefined as undefined | (() => (() => void) | undefined),
  view: null as null | {
    items: Array<{ popup: { extraProps: { onDelete: () => Promise<void> } } }>;
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [
    initial,
    (value: typeof h.view) => {
      h.view = value;
    },
  ],
  useEffect: (fn: typeof h.effect) => {
    h.effect = fn;
  },
}));
vi.mock("../src/components/excel/WorkbookObject", () => ({ WorkbookObject: () => null }));
import { WorkbookObjectsLayer } from "../src/components/excel/WorkbookObjectsLayer";

afterEach(() => vi.unstubAllGlobals());
test("deleting an image reads current objects only and retains later neighboring objects", async () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const image = {
    id: "remove",
    title: "QA",
    anchor: "A1",
    width: 100,
    height: 100,
    mediaType: "image/png",
  };
  const objects = {
    charts: [],
    images: [image],
    notes: [{ ref: "C1", text: "keep", author: "QA" }],
  };
  const data = { custom: { excelmanusObjects: objects } };
  const sheet = {
    getSheetId: () => "s",
    getSheet: () => ({ getSnapshot: () => data }),
    getRange: () => ({}),
  };
  const save = vi.fn(() => ({ sheets: { s: structuredClone(data) } }));
  const executeCommand = vi.fn(async () => true);
  const api = {
    wb: { getId: () => "unit", getActiveSheet: () => sheet, getSheetBySheetId: () => sheet, save },
    univerAPI: { executeCommand },
  };
  renderToString(
    createElement(WorkbookObjectsLayer, {
      api,
      host: {},
      docId: "d",
      revision: 1,
      sheetKey: "s",
      ready: 1,
    } as unknown as Parameters<typeof WorkbookObjectsLayer>[0]),
  );
  const cleanup = h.effect?.();
  objects.images.push({ ...image, id: "late" });
  expect(h.view?.items.length).toBeGreaterThan(0);
  await h.view?.items[0].popup.extraProps.onDelete();
  expect(executeCommand).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  const params = (
    executeCommand.mock.calls[0] as unknown as [string, { objects: typeof objects }]
  )[1];
  expect(params.objects.images.map((x) => x.id)).toEqual(["late"]);
  expect(params.objects.notes).toEqual(objects.notes);
  expect(objects.images.map((x) => x.id)).toEqual(["remove", "late"]);
  params.objects.notes[0].text = "detached payload";
  expect(objects.notes[0].text).toBe("keep");
  cleanup?.();
});
