import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.states)) mocks.states[slot] = initial;
      return [
        mocks.states[slot],
        (next: unknown) => {
          mocks.states[slot] = next;
        },
      ];
    },
  };
});
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: vi.fn(),
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: box,
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogContent: box,
  };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ children }: { children: ReactNode }) => createElement("button", null, children),
  };
});
vi.mock("@/stores/files-store", () => ({
  listAllFiles: mocks.listAllFiles,
  uploadFiles: vi.fn(),
  useFilesStore: (select: (s: unknown) => unknown) => select({ version: 0, workspaceId: "ws" }),
}));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: (s: unknown) => unknown) =>
    select({ workbookPicker: "panel", closeWorkbookPicker: vi.fn() }),
}));
vi.mock("@/stores/workbook-store", () => ({
  openWorkbook: vi.fn(),
  useWorkbookStore: (select: (s: unknown) => unknown) => select({ tabs: [] }),
}));

import { OpenWorkbookDialog } from "../src/components/excel/OpenWorkbookDialog";

const render = () => {
  mocks.cursor = 0;
  return renderToString(createElement(OpenWorkbookDialog));
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.effects = [];
});

async function loaded() {
  render();
  for (const effect of mocks.effects) effect();
  await new Promise((done) => setTimeout(done, 0));
  return render();
}

test("a failed workbook list does not claim the workspace has no workbooks", async () => {
  mocks.listAllFiles.mockRejectedValueOnce(new Error("读取目录失败"));
  const html = await loaded();
  expect(html).toContain("读取目录失败");
  expect(html).not.toContain("工作区里还没有表格");
});

test("a successfully read empty workspace keeps its upload guidance", async () => {
  mocks.listAllFiles.mockResolvedValueOnce([]);
  expect(await loaded()).toContain("工作区里还没有表格，可以从本地上传并打开");
});

test("the initial workbook picker does not declare an empty workspace before reading", () => {
  const html = render();
  expect(html).not.toContain("工作区里还没有表格");
  expect(html).toContain("正在读取");
});
