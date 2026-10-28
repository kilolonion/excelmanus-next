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
  rewrite: vi.fn(),
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
vi.mock("@excelmanus/core", async (original) => {
  const core = await original<typeof import("@excelmanus/core")>();
  h.rewrite.mockImplementation(core.rewriteTableReferences);
  return { ...core, rewriteTableReferences: h.rewrite };
});
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
vi.mock("@/components/ui/textarea", () => ({ Textarea: () => null }));
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

import { TableManagerPanel } from "../src/components/excel/TableManagerPanel";

beforeEach(() => {
  h.values = [];
  h.index = 0;
  h.effects = [];
  h.buttons.clear();
  h.inputs.clear();
  h.edit.mockClear();
  h.rewrite.mockClear();
});
function fixture(tableCount = 1) {
  const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 };
  const old = {
    id: "table-1",
    name: "Table1",
    range,
    columns: ["Sales", "Cost"].map((displayName, i) => ({
      id: `c${i}`,
      displayName,
      dataType: 0,
      formula: "",
      meta: {},
      style: {},
    })),
    options: {
      showHeader: true,
      showFooter: false,
      showAutoFilter: true,
      tableStyleId: "table-default-0",
    },
    filters: {},
    meta: {},
  };
  const data = {
    cellData: { 0: { 0: { v: "Sales" }, 1: { v: "Sales" } } },
    mergeData: [] as (typeof range)[],
  };
  const formulas = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      i,
      { 0: { f: "=SUM(Table1[Sales])", s: { bg: { rgb: "red" } } } },
    ]),
  );
  const tableList = vi.fn(() =>
    Array.from({ length: tableCount }, (_, i) => ({ id: `table-${i + 1}`, name: `Table${i + 1}` })),
  );
  const manager = { getTableList: tableList, getTablesBySubunitId: () => [{ toJSON: () => old }] };
  const sheet = {
    getSheetId: () => "s",
    getSheetName: () => "Data",
    getSheet: () => ({ getSnapshot: () => data }),
    getSelection: () => ({ getActiveRange: () => ({ getRange: () => range }) }),
  };
  const save = vi.fn(() => ({
    sheets: { s: structuredClone(data), other: { cellData: formulas } },
  }));
  const api = {
    univer: { __getInjector: () => ({ get: () => manager }) },
    wb: {
      getId: () => "unit",
      getActiveSheet: () => sheet,
      getSheetBySheetId: () => sheet,
      getSheets: () => [
        sheet,
        {
          getSheetId: () => "other",
          getSheet: () => ({ getSnapshot: () => ({ cellData: formulas }) }),
        },
      ],
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
      createElement(TableManagerPanel, { api } as unknown as Parameters<
        typeof TableManagerPanel
      >[0]),
    );
  };
  render();
  h.effects[0]();
  render();
  return { render, save, data, tableList, old, formulas };
}
test("new table draft reads only its selected header and indexes names once", () => {
  const f = fixture(100);
  h.buttons.get("从选区创建表")!();
  expect(f.render()).toContain('value="Table101"');
  expect(h.values[4]).toBe("Sales\n列2");
  expect(f.save).not.toHaveBeenCalled();
  expect(f.tableList).toHaveBeenCalledTimes(1);
  expect(f.data.cellData[0][1].v).toBe("Sales");
});
test("overlap validation reads current sheet merges without saving the whole workbook", () => {
  const f = fixture();
  h.buttons.get("编辑表 Table1")!();
  f.render();
  f.data.mergeData.push({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 });
  h.buttons.get("保存表对象")!();
  expect(f.render()).toContain("请先取消范围内的合并单元格");
  expect(f.save).not.toHaveBeenCalled();
  expect(h.edit).not.toHaveBeenCalled();
});
test("table rename prepares shared references once and preserves cross-sheet formula rewrites", () => {
  const f = fixture();
  h.buttons.get("编辑表 Table1")!();
  f.render();
  h.inputs.get("表名称")!({ target: { value: "RenamedSales" } });
  f.render();
  h.buttons.get("保存表对象")!();
  expect(h.edit).toHaveBeenCalledOnce();
  expect(h.rewrite).toHaveBeenCalledTimes(100);
  expect(new Set(h.rewrite.mock.calls.map((c) => c[1])).size).toBe(1);
  expect(new Set(h.rewrite.mock.calls.map((c) => c[2])).size).toBe(1);
  const mutations = h.edit.mock.calls[0] as unknown as [
    unknown,
    Array<{
      params: { subUnitId: string; cellValue?: Record<string, Record<string, { f?: string }>> };
    }>,
  ];
  const changed = mutations[1].find((m) => m.params.subUnitId === "other")?.params.cellValue;
  expect(changed?.["99"]?.["0"]?.f).toBe("=SUM(RenamedSales[Sales])");
  expect(f.formulas[99][0].f).toBe("=SUM(Table1[Sales])");
  expect(f.save).not.toHaveBeenCalled();
});

test("creating a table avoids scanning other worksheets and detaches header styles", () => {
  const f = fixture();
  h.values[1] = [];
  const style = { bg: { rgb: "red" } };
  Object.assign(f.data.cellData[0][0], { s: style });
  f.render();
  h.buttons.get("从选区创建表")!();
  f.render();
  h.buttons.get("保存表对象")!();
  expect(h.edit).toHaveBeenCalledOnce();
  expect(f.save).not.toHaveBeenCalled();
  expect(h.rewrite).not.toHaveBeenCalled();
  const mutations = (h.edit.mock.calls[0] as unknown as [unknown, any[]])[1];
  const cell = mutations.find((m) => m.params.cellValue)?.params.cellValue[0][0];
  expect(cell.s).toEqual(style);
  cell.s.bg.rgb = "blue";
  expect(style.bg.rgb).toBe("red");
});
