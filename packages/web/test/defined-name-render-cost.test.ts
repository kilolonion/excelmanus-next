import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  index: 0,
  name: "Revenue",
  effects: [] as Array<() => unknown>,
  setState: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const values = [
      true,
      [],
      { id: "n", name: state.name, formulaOrRefString: "Data!A1", localSheetId: "s" },
      false,
      "",
    ];
    return [values[state.index++], state.setState];
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

import { DefinedNames } from "../src/components/excel/DefinedNames";

test("editing a defined name reads sheet labels without serializing the workbook", () => {
  let sheetName = "Data";
  const save = vi.fn(() => ({ sheetOrder: ["s"], sheets: { s: { name: sheetName } } }));
  const api = {
    wb: { save, getSheets: () => [{ getSheetId: () => "s", getSheetName: () => sheetName }] },
  };
  const render = () => {
    state.index = 0;
    return renderToString(
      createElement(DefinedNames, { api } as unknown as Parameters<typeof DefinedNames>[0]),
    );
  };
  expect(render()).toContain("Data");
  state.name = "RevenueTotal";
  sheetName = "Renamed";
  const html = render();
  expect(html).toContain("RevenueTotal");
  expect(html).toContain("Renamed");
  expect(save).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllGlobals());

test("name list initialization and refresh read only the defined-name service", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frame = fn;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  state.index = 0;
  state.effects = [];
  state.setState.mockClear();
  let names = {
    n: {
      id: "n",
      name: "Legacy name",
      formulaOrRefString: "Data!A1",
      hidden: true,
      localSheetId: "s",
    },
  };
  const read = vi.fn(() => names);
  let onCommand: (c: { id: string }) => void = () => {};
  const dispose = vi.fn();
  const save = vi.fn(() => ({
    resources: [{ name: "SHEET_DEFINED_NAME_PLUGIN", data: JSON.stringify(names) }],
  }));
  const api = {
    univer: { __getInjector: () => ({ get: () => ({ getDefinedNameMap: read }) }) },
    wb: {
      save,
      getId: () => "unit",
      getSheets: () => [],
      onCommandExecuted: (callback: typeof onCommand) => {
        onCommand = callback;
        return { dispose };
      },
    },
  };
  renderToString(
    createElement(DefinedNames, { api } as unknown as Parameters<typeof DefinedNames>[0]),
  );
  const cleanup = state.effects[0]!() as () => void;
  expect(state.setState).toHaveBeenLastCalledWith(Object.values(names));
  names = { n: { ...names.n, formulaOrRefString: "Data!B2" } };
  onCommand({ id: "sheet.command.set-defined-name" });
  frame?.(0);
  expect(state.setState).toHaveBeenLastCalledWith(Object.values(names));
  expect(read).toHaveBeenCalledWith("unit");
  expect(save).not.toHaveBeenCalled();
  cleanup();
  expect(dispose).toHaveBeenCalledOnce();
});
