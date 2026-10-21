import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  epoch: 0,
  revision: 1,
  effects: [] as (() => unknown)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    state.epoch,
    (next: (value: number) => number) => {
      state.epoch = next(state.epoch);
    },
  ],
  useEffect: (effect: () => unknown) => state.effects.push(effect),
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (select: (s: { doc: { rev: number } }) => unknown) =>
    select({ doc: { rev: state.revision } }),
}));
vi.mock("@/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => children;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});

import { WorkbookOutlineDialog } from "../src/components/excel/WorkbookOutlineDialog";

function fixture() {
  const sheet = {
    name: "Grouping",
    rowData: { 8: { custom: { excelmanusCollapsed: true } } },
    columnData: {
      1: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
      2: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
      3: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
      4: { custom: { excelmanusCollapsed: true } },
      5: { hd: 1 },
    },
    custom: { excelmanusOutlineSettings: { summaryBelow: "0" } },
  };
  let current = sheet;
  let onCommand: () => void = () => {};
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const save = vi.fn();
  const dispose = vi.fn();
  const api = {
    wb: {
      save,
      getActiveSheet: () => ({ getSheet: () => ({ getSnapshot: () => current }) }),
      onCommandExecuted: (callback: () => void) => {
        onCommand = callback;
        return { dispose };
      },
    },
  } as unknown as Parameters<typeof WorkbookOutlineDialog>[0]["api"];
  return {
    render: () => renderToString(createElement(WorkbookOutlineDialog, { api, onClose() {} })),
    save,
    dispose,
    setSheet: (next: typeof sheet) => {
      current = next;
    },
    sheet,
    changed: () => {
      onCommand();
      frame?.(0);
    },
  };
}

beforeEach(() => {
  state.epoch = 0;
  state.revision = 1;
  state.effects = [];
  vi.unstubAllGlobals();
});

test("read-only outline dialog shows distinct flags and explicitly disclaims native group controls", () => {
  const f = fixture();
  const html = f.render();
  expect(html).toContain("分组与隐藏状态（只读）");
  expect(html).toContain("无原生 ± 分组控件");
  expect(html).toContain("隐藏、层级、折叠标记为独立状态");
  expect(html).toContain("修改由命令或工作簿工具完成");
  expect(html).toMatch(/B:D<\/th><td[^>]*>隐藏<\/td><td[^>]*>1<\/td><td[^>]*>无/);
  expect(html).toMatch(/E<\/th><td[^>]*>可见<\/td><td[^>]*>0<\/td><td[^>]*>有/);
  expect(html).toMatch(/F<\/th><td[^>]*>隐藏<\/td><td[^>]*>0<\/td><td[^>]*>无/);
  expect(html).toContain("否（文件指定）");
  expect(html).toContain("是（默认，文件未指定）");
  expect(f.save).not.toHaveBeenCalled();
});

test("outline dialog rereads the active sheet after mutations and snapshot revisions", () => {
  const f = fixture();
  f.render();
  const cleanup = state.effects[0]() as () => void;
  f.setSheet({
    ...f.sheet,
    name: "Updated",
    columnData: {
      ...f.sheet.columnData,
      4: { custom: { excelmanusCollapsed: false } },
    },
  });
  f.changed();
  expect(state.epoch).toBe(1);
  let html = f.render();
  expect(html).toContain("Updated");
  expect(html).not.toMatch(/E<\/th>/);
  f.setSheet({ ...f.sheet, name: "Reopened" });
  state.revision++;
  html = f.render();
  expect(html).toContain("Reopened");
  expect(html).toMatch(/E<\/th><td[^>]*>可见<\/td><td[^>]*>0<\/td><td[^>]*>有/);
  expect(f.save).not.toHaveBeenCalled();
  cleanup();
  expect(f.dispose).toHaveBeenCalledOnce();
});
