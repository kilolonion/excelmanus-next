import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  index: 0,
  effects: [] as Array<() => undefined | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [
    h.index++ === 0 ? true : typeof initial === "function" ? initial() : initial,
    vi.fn(),
  ],
  useEffect: (effect: () => undefined | (() => void)) => h.effects.push(effect),
}));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));

import { ArrayFormulas } from "../src/components/excel/ArrayFormulas";
import { ConditionalFormats } from "../src/components/excel/ConditionalFormats";
import { DefinedNames } from "../src/components/excel/DefinedNames";
import type { SheetApi } from "../src/components/excel/FormatToolbar";
import { TableManagerPanel } from "../src/components/excel/TableManagerPanel";

let frames: Map<number, FrameRequestCallback>, serial: number;
beforeEach(() => {
  h.index = 0;
  h.effects = [];
  frames = new Map();
  serial = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((fn: FrameRequestCallback) => {
      frames.set(++serial, fn);
      return serial;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
});
afterEach(() => vi.unstubAllGlobals());
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const run of pending) run(0);
}
const cases = [
  ["names", DefinedNames, "sheet.mutation.set-defined-name"],
  ["arrays", ArrayFormulas, "sheet.mutation.set-range-values"],
  ["tables", TableManagerPanel, "sheet.mutation.set-table"],
  ["formats", ConditionalFormats, "cf-change"],
] as const;
function mount([kind, Component, id]: (typeof cases)[number]) {
  let command: (event: { id: string }) => void = () => {};
  let rule: (event: { unitId: string; subUnitId: string }) => void = () => {};
  let version = 0;
  const observed: number[] = [];
  const read = vi.fn(() => {
    observed.push(version);
  });
  const dispose = vi.fn();
  const model = {
    getDefinedNameMap: () => {
      read();
      return {};
    },
    getArrayFormulaRange: () => {
      read();
      return {};
    },
    getTablesBySubunitId: () => {
      read();
      return [];
    },
    getSubunitRules: () => {
      read();
      return [];
    },
    $ruleChange: {
      subscribe: (fn: typeof rule) => {
        rule = fn;
        return { unsubscribe: dispose };
      },
    },
  };
  const sheet = {
    getSheetId: () => "s",
    getSheetName: () => "Data",
    getSheet: () => ({ getSnapshot: () => ({ cellData: {} }) }),
  };
  const api = {
    univer: { __getInjector: () => ({ get: () => model }) },
    wb: {
      getId: () => "unit",
      getActiveSheet: () => sheet,
      getSheetBySheetId: () => sheet,
      getSheets: () => [sheet],
      onCommandExecuted: (fn: typeof command) => {
        command = fn;
        return { dispose };
      },
    },
  } as unknown as SheetApi;
  renderToString(createElement(Component, { api, disabled: false }));
  const cleanups = h.effects.map((effect) => effect());
  expect(read).toHaveBeenCalledTimes(1);
  read.mockClear();
  observed.length = 0;
  return {
    read,
    observed,
    dispose,
    change: () => {
      version++;
      if (kind === "formats") rule({ unitId: "unit", subUnitId: "s" });
      else command({ id });
    },
    unrelated: () => {
      if (kind === "formats") rule({ unitId: "other", subUnitId: "s" });
      else command({ id: "sheet.operation.set-scroll" });
    },
    close: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

test.each(cases.map((c) => [c[0], c] as const))(
  "%s coalesces a notification burst and reads the latest state",
  (_name, c) => {
    const f = mount(c);
    for (let i = 0; i < 100; i++) f.change();
    expect(f.read).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    flush();
    expect(f.observed).toEqual([100]);
    f.unrelated();
    expect(frames.size).toBe(0);
    f.change();
    flush();
    expect(f.observed).toEqual([100, 101]);
    f.close();
  },
);

test.each(cases.map((c) => [c[0], c] as const))(
  "%s cancels pending list preparation when closed",
  (_name, c) => {
    const f = mount(c);
    f.change();
    f.close();
    flush();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  },
);
