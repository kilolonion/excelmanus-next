import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  openWorkbook: vi.fn(),
  close: vi.fn(),
  workspaceId: "old-workspace",
  picker: "panel" as "panel" | "full" | null,
  drop: null as
    | ((event: { preventDefault: () => void; dataTransfer: { files: File[] } }) => void)
    | null,
}));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: box,
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogContent: ({ children, onDrop }: { children: ReactNode; onDrop: typeof mocks.drop }) => {
      mocks.drop = onDrop;
      return createElement("div", null, children);
    },
  };
});
vi.mock("@/stores/files-store", () => ({
  listAllFiles: vi.fn().mockResolvedValue([]),
  uploadFiles: mocks.uploadFiles,
  useFilesStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ version: 0, workspaceId: mocks.workspaceId }),
    { getState: () => ({ workspaceId: mocks.workspaceId }) },
  ),
}));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: Object.assign(
    (select: (s: unknown) => unknown) =>
      select({ workbookPicker: mocks.picker, closeWorkbookPicker: mocks.close }),
    { getState: () => ({ workbookPicker: mocks.picker }) },
  ),
}));
vi.mock("@/stores/workbook-store", () => ({
  openWorkbook: mocks.openWorkbook,
  useWorkbookStore: Object.assign((select: (s: unknown) => unknown) => select({ tabs: [] }), {
    getState: () => ({ loadError: null }),
  }),
}));

import { OpenWorkbookDialog } from "../src/components/excel/OpenWorkbookDialog";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceId = "old-workspace";
  mocks.picker = "panel";
  mocks.openWorkbook.mockResolvedValue(true);
});

test.each(["workspace", "close"])(
  "upload completion cannot reopen a stale picker after %s",
  async (change) => {
    let finish!: (paths: string[]) => void;
    mocks.uploadFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderToString(createElement(OpenWorkbookDialog));
    if (!mocks.drop) throw new Error("drop entry was not rendered");
    mocks.drop({
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["test"], "sample.xlsx")] },
    });
    if (change === "workspace") mocks.workspaceId = "new-workspace";
    else mocks.picker = null;
    finish(["sample.xlsx"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.openWorkbook).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  },
);

test("an uninterrupted picker upload still opens the uploaded workbook", async () => {
  mocks.uploadFiles.mockResolvedValueOnce(["sample.xlsx"]);
  renderToString(createElement(OpenWorkbookDialog));
  if (!mocks.drop) throw new Error("drop entry was not rendered");
  mocks.drop({
    preventDefault: vi.fn(),
    dataTransfer: { files: [new File(["test"], "sample.xlsx")] },
  });
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  expect(mocks.openWorkbook).toHaveBeenCalledWith("sample.xlsx", {
    full: false,
    isCurrent: expect.any(Function),
  });
});

test("a late workbook-open completion cannot close a replacement picker", async () => {
  mocks.uploadFiles.mockResolvedValueOnce(["sample.xlsx"]);
  let finish!: () => void;
  mocks.openWorkbook.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  renderToString(createElement(OpenWorkbookDialog));
  if (!mocks.drop) throw new Error("drop entry was not rendered");
  mocks.drop({
    preventDefault: vi.fn(),
    dataTransfer: { files: [new File(["test"], "sample.xlsx")] },
  });
  await vi.waitFor(() => expect(mocks.openWorkbook).toHaveBeenCalledTimes(1));
  mocks.picker = "full";
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.close).not.toHaveBeenCalled();
});

test("the local picker allows both supported legacy workbook extensions", () => {
  const html = renderToString(createElement(OpenWorkbookDialog));
  const accept = html.match(/accept="([^"]+)"/)?.[1].split(",");
  expect(accept).toEqual(expect.arrayContaining([".xlsx", ".xlsm", ".xls", ".xlsb", ".csv", ".tsv"]));
});

test("cancelling legacy conversion keeps the workbook picker open", async () => {
  mocks.uploadFiles.mockResolvedValueOnce(["sample.xls"]);
  mocks.openWorkbook.mockResolvedValueOnce(false);
  renderToString(createElement(OpenWorkbookDialog));
  if (!mocks.drop) throw new Error("drop entry was not rendered");
  mocks.drop({
    preventDefault: vi.fn(),
    dataTransfer: { files: [new File(["test"], "sample.xls")] },
  });
  await vi.waitFor(() => expect(mocks.openWorkbook).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.close).not.toHaveBeenCalled();
});
