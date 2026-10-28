import { sheetObjectsMutation, WorkbookObjects } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  index: 0,
  effect: undefined as undefined | (() => (() => void) | undefined),
  view: undefined as any,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const i = h.index++;
    h.refs[i] ??= { current: value };
    return h.refs[i];
  },
  useState: (value: unknown) => [
    value,
    (next: unknown) => {
      h.view = next;
    },
  ],
  useEffect: (fn: typeof h.effect) => {
    h.effect = fn;
  },
}));
vi.mock("../src/components/excel/WorkbookObject", () => ({ WorkbookObject: () => null }));

import { WorkbookObjectsLayer } from "../src/components/excel/WorkbookObjectsLayer";

let cleanup: (() => void) | undefined;
const image = {
  id: "i",
  title: "image",
  anchor: "A1",
  width: 100,
  height: 100,
  mediaType: "image/png",
};
let data: any, api: any;
function render(revision: number) {
  h.index = 0;
  renderToString(
    createElement(WorkbookObjectsLayer, {
      api,
      host: {} as HTMLDivElement,
      docId: "d",
      sheetKey: "s",
      ready: 1,
      revision,
    }),
  );
  cleanup?.();
  cleanup = h.effect?.();
  return h.view.items[0]?.popup.extraProps.image;
}
beforeEach(() => {
  h.refs = [];
  h.index = 0;
  cleanup = undefined;
  data = { custom: { excelmanusObjects: { charts: [], images: [image] } } };
  api = {
    wb: {
      getActiveSheet: () => ({
        getSheetId: () => "s",
        getSheet: () => ({ getSnapshot: () => data }),
        getRange: () => ({}),
      }),
    },
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("cell revisions reuse object parsing and image source identity", () => {
  const parse = vi.spyOn(WorkbookObjects, "safeParse");
  const first = render(1);
  for (let rev = 2; rev <= 20; rev++) expect(render(rev)).toBe(first);
  expect(parse).toHaveBeenCalledTimes(1);
});
test("real object mutation replaces the cached metadata and image identity", () => {
  const first = render(1);
  const mutation = sheetObjectsMutation(2, () => ({
    getCustomMetadata: () => data.custom,
    setCustomMetadata: (custom) => {
      data.custom = custom;
    },
  }));
  expect(
    mutation.handler(null, {
      unitId: "u",
      subUnitId: "s",
      objects: { charts: [], images: [{ ...image, title: "changed" }] },
    }),
  ).toBe(true);
  expect(render(2)).not.toBe(first);
  expect(render(3).title).toBe("changed");
});
test("replacing the sheet snapshot refreshes an otherwise identical image", () => {
  const first = render(1);
  data = structuredClone(data);
  expect(render(2)).not.toBe(first);
});

test("closing the active sheet releases its parsed metadata cache", () => {
  const first = render(1);
  const active = api.wb.getActiveSheet;
  api.wb.getActiveSheet = () => null;
  expect(render(2)).toBeUndefined();
  api.wb.getActiveSheet = active;
  expect(render(3)).not.toBe(first);
});
