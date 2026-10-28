import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as Array<() => (() => void) | undefined>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.index++;
    if (!(i in h.values)) h.values[i] = i === 0 ? true : initial;
    return [
      h.values[i],
      (v: unknown) => {
        h.values[i] = v;
      },
    ];
  },
  useEffect: (fn: () => (() => void) | undefined) => {
    h.effects.push(fn);
  },
}));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));

import { ArrayFormulas } from "../src/components/excel/ArrayFormulas";

function fixture() {
  const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 };
  const data = { cellData: { 0: { 0: { f: "=SEQUENCE(3,2)", v: 1 } } } };
  let callback: (c: { id: string }) => void = () => {};
  const dispose = vi.fn(),
    getRanges = vi.fn(() => ({ unit: { s: { 0: { 0: range } } } }));
  const sheet = {
    getSheetId: () => "s",
    getSheetName: () => "Data",
    getSheet: () => ({ getSnapshot: () => data }),
  };
  const save = vi.fn(() => ({
    sheets: { s: data },
    resources: [
      {
        name: "SHEET_EXCELMANUS_ARRAY_PLUGIN",
        data: JSON.stringify({ ranges: { s: { 0: { 0: range } } }, cells: {} }),
      },
    ],
  }));
  const api = {
    univer: { __getInjector: () => ({ get: () => ({ getArrayFormulaRange: getRanges }) }) },
    wb: {
      getId: () => "unit",
      getActiveSheet: () => sheet,
      getSheetBySheetId: () => sheet,
      save,
      onCommandExecuted: (fn: typeof callback) => {
        callback = fn;
        return { dispose };
      },
    },
  };
  const render = () => {
    h.index = 0;
    h.effects = [];
    return renderToString(
      createElement(ArrayFormulas, { api } as unknown as Parameters<typeof ArrayFormulas>[0]),
    );
  };
  return { render, save, getRanges, range, dispose, command: (id: string) => callback({ id }) };
}
let frame: FrameRequestCallback | undefined;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  frame = undefined;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frame = fn;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  h.values = [];
  h.index = 0;
  h.effects = [];
});
test("array list reads current sheet and live spill ranges without saving the workbook", () => {
  const f = fixture();
  f.render();
  h.effects[0]();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.getRanges).toHaveBeenCalledTimes(1);
  expect(f.render()).toContain("A1:B3");
});
test("array refresh sees changed live spill dimensions and unsubscribes on close", () => {
  const f = fixture();
  f.render();
  const cleanup = h.effects[0]();
  f.range.endRow = 4;
  f.command("sheet.mutation.set-range-values");
  frame?.(0);
  expect(f.render()).toContain("A1:B5");
  expect(f.save).not.toHaveBeenCalled();
  const reads = f.getRanges.mock.calls.length;
  f.command("sheet.command.set-selection");
  expect(f.getRanges).toHaveBeenCalledTimes(reads);
  cleanup?.();
  expect(f.dispose).toHaveBeenCalledOnce();
});
