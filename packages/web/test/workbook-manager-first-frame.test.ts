import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  index: 0,
  effects: [] as Array<() => unknown>,
  values: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = state.index++;
    if (!(i in state.values)) state.values[i] = i === 0 ? true : initial;
    return [
      state.values[i],
      (value: unknown) => {
        state.values[i] = value;
      },
    ];
  },
  useEffect: (effect: () => unknown) => {
    state.effects.push(effect);
  },
}));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));

import { ArrayFormulas } from "../src/components/excel/ArrayFormulas";
import { DefinedNames } from "../src/components/excel/DefinedNames";
import { TableManagerPanel } from "../src/components/excel/TableManagerPanel";

beforeEach(() => {
  state.index = 0;
  state.effects = [];
  state.values = [];
});
test.each([
  [DefinedNames, "正在读取名称", "0 个名称"],
  [ArrayFormulas, "正在读取数组", "0 个数组"],
  [TableManagerPanel, "正在读取表对象", "0 个表"],
] as const)(
  "manager first frame distinguishes unread data from empty data: %s",
  (Component, loading, empty) => {
    const sheet = {
      getSheetId: () => "s",
      getSheetName: () => "Data",
      getSheet: () => ({ getSnapshot: () => ({ cellData: {} }) }),
    };
    const api = {
      univer: {
        __getInjector: () => ({
          get: () => ({
            getDefinedNameMap: () => ({}),
            getTablesBySubunitId: () => [],
            getArrayFormulaRange: () => ({}),
          }),
        }),
      },
      wb: {
        getId: () => "unit",
        getActiveSheet: () => sheet,
        getSheetBySheetId: () => sheet,
        getSheets: () => [sheet],
        save: () => ({ sheets: { s: { cellData: {} } } }),
        onCommandExecuted: () => ({ dispose() {} }),
      },
    };
    const render = () => {
      state.index = 0;
      state.effects = [];
      return renderToString(
        createElement(Component, { api } as unknown as Parameters<typeof Component>[0]),
      );
    };
    expect(render()).toContain(loading);
    for (const run of state.effects) run();
    expect(render().replaceAll("<!-- -->", "")).toContain(empty);
  },
);
