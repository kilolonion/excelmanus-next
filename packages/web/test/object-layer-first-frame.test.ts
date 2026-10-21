import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  value: undefined as unknown,
  effect: undefined as undefined | (() => unknown),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [
    state.value ?? initial,
    (value: unknown) => {
      state.value = value;
    },
  ],
  useEffect: (effect: () => unknown) => {
    state.effect = effect;
  },
}));
vi.mock("../src/components/excel/WorkbookObject", () => ({
  WorkbookObject: ({ popup }: { popup: { extraProps: { chart: { title: string } } } }) =>
    createElement("i", null, popup.extraProps.chart.title),
}));

import { WorkbookObjectsLayer } from "../src/components/excel/WorkbookObjectsLayer";

beforeEach(() => {
  state.value = undefined;
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
afterEach(() => vi.unstubAllGlobals());
test.each(["document", "sheet", "instance"])(
  "changing %s hides the prior object's first frame",
  (target) => {
    const api = {
      wb: {
        getActiveSheet: () => ({
          getSheetId: () => "s",
          getSheet: () => ({
            getSnapshot: () => ({
              custom: {
                excelmanusObjects: {
                  images: [],
                  charts: [
                    {
                      id: "same",
                      title: "Old chart",
                      type: "column",
                      anchor: "A1",
                      range: "A1:B2",
                      width: 200,
                      height: 100,
                    },
                  ],
                },
              },
            }),
          }),
          getRange: () => ({}),
        }),
      },
    };
    const props = {
      api,
      host: {},
      docId: "doc",
      revision: 1,
      sheetKey: "S",
      ready: 1,
    } as unknown as Parameters<typeof WorkbookObjectsLayer>[0];
    const render = () => renderToString(createElement(WorkbookObjectsLayer, props));
    render();
    state.effect?.();
    expect(render()).toContain("Old chart");
    if (target === "document") props.docId = "new";
    else if (target === "sheet") props.sheetKey = "Other";
    else props.ready = 2;
    expect(render()).not.toContain("Old chart");
  },
);
