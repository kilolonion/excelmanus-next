import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as Array<() => unknown>,
  buttons: new Map<string, () => void>(),
  inputs: new Map<string, (e: { target: { value: string } }) => void>(),
  edit: vi.fn(() => true),
  confirm: vi.fn(async () => true),
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
  useEffect: (fn: () => unknown) => h.effects.push(fn),
}));
vi.mock("@/lib/workbook/table-edit", () => ({ editTable: h.edit }));
vi.mock("@/components/ui/overlay-card", () => ({
  OverlayCard: ({ children }: { children: ReactNode }) => children,
  OverlayCardBody: ({ children }: { children: ReactNode }) => children,
  OverlayCardHeader: () => null,
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: { children: ReactNode; "aria-label"?: string; onClick?: () => void }) => {
    const label =
      props["aria-label"] ??
      (Array.isArray(props.children)
        ? props.children.filter((x) => typeof x === "string").join("")
        : props.children);
    if (typeof label === "string" && props.onClick) h.buttons.set(label, props.onClick);
    return createElement("button", null, props.children);
  },
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: {
    "aria-label": string;
    value: string;
    onChange: (e: { target: { value: string } }) => void;
  }) => {
    h.inputs.set(props["aria-label"], props.onChange);
    return createElement("input", { value: props.value, readOnly: true });
  },
}));
vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: any) => {
    h.inputs.set(props["aria-label"], props.onChange);
    return createElement("textarea", { value: props.value, readOnly: true });
  },
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmAction: h.confirm }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => {
  const pass = ({ children }: { children: ReactNode }) => children;
  return {
    DropdownMenu: pass,
    DropdownMenuContent: pass,
    DropdownMenuRadioGroup: pass,
    DropdownMenuRadioItem: pass,
    DropdownMenuTrigger: pass,
  };
});

import { ArrayFormulas } from "../src/components/excel/ArrayFormulas";

beforeEach(() => {
  h.values = [];
  h.index = 0;
  h.effects = [];
  h.buttons.clear();
  h.inputs.clear();
  h.edit.mockClear();
  h.confirm.mockClear();
});
function fixture() {
  const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 };
  const array = { id: "a", mode: "fixed", formula: "=1", range };
  const data = {
    custom: { excelmanusArrays: [array] },
    mergeData: [] as (typeof range)[],
    cellData: { 0: { 0: { f: "=1", v: 1, s: { bg: { rgb: "red" } } } } },
  };
  const sheet = {
    getSelection: () => null,
    getSheetId: () => "s",
    getSheetName: () => "Data",
    getSheet: () => ({ getSnapshot: () => data }),
  };
  const save = vi.fn(() => ({ sheets: { s: structuredClone(data) } }));
  const api = {
    disposed: false,
    univer: { __getInjector: () => ({ get: () => ({ getArrayFormulaRange: () => ({}) }) }) },
    wb: {
      getId: () => "unit",
      getActiveSheet: () => sheet,
      getSheetBySheetId: () => sheet,
      save,
      onCommandExecuted: () => ({ dispose() {} }),
    },
  };
  const render = () => {
    h.index = 0;
    h.effects = [];
    h.buttons.clear();
    h.inputs.clear();
    return renderToString(
      createElement(ArrayFormulas, { api } as unknown as Parameters<typeof ArrayFormulas>[0]),
    );
  };
  render();
  h.effects[0]();
  render();
  return { render, save, data, api };
}
test("array editing reads only current sheet while preserving source cells", () => {
  const f = fixture();
  h.buttons.get("编辑数组 A1:A1")!();
  f.render();
  h.inputs.get("数组表达式")!({ target: { value: "=2" } });
  f.render();
  h.buttons.get("保存数组公式")!();
  expect(h.edit).toHaveBeenCalledOnce();
  expect(f.save).not.toHaveBeenCalled();
  const mutations = (h.edit.mock.calls[0] as unknown as [unknown, any[]])[1];
  expect(mutations[0].params.arrays[0].formula).toBe("=2");
  expect(mutations[1].params.cellValue[0][0]).toMatchObject({ s: { bg: { rgb: "red" } }, v: null });
  expect(f.data.cellData[0][0]).toEqual({ f: "=1", v: 1, s: { bg: { rgb: "red" } } });
  expect(f.data.custom.excelmanusArrays[0].formula).toBe("=1");
  mutations[1].params.cellValue[0][0].s.bg.rgb = "blue";
  expect(f.data.cellData[0][0].s.bg.rgb).toBe("red");
});
test("array validation reads live merges without serializing unrelated sheets", () => {
  const f = fixture();
  h.buttons.get("编辑数组 A1:A1")!();
  f.render();
  f.data.mergeData.push({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 });
  h.buttons.get("保存数组公式")!();
  expect(f.render()).toContain("请先取消数组范围内的合并单元格");
  expect(h.edit).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

test("clearing an array preserves styles without preparing a whole-workbook snapshot", async () => {
  const f = fixture();
  h.buttons.get("清除数组 A1:A1")!();
  await vi.waitFor(() => expect(h.edit).toHaveBeenCalledOnce());
  expect(h.confirm).toHaveBeenCalledOnce();
  expect(f.save).not.toHaveBeenCalled();
  const mutations = (h.edit.mock.calls[0] as unknown as [unknown, any[]])[1];
  expect(mutations[0].params.arrays).toEqual([]);
  expect(mutations[1].params.cellValue[0][0]).toMatchObject({
    f: null,
    v: null,
    s: { bg: { rgb: "red" } },
  });
  expect(f.data.cellData[0][0].f).toBe("=1");
});
