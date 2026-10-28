import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceId: "old",
  createEmptyFile: vi.fn(),
  createFolder: vi.fn(),
  toggleDir: vi.fn(),
  openWorkspaceFile: vi.fn(),
  confirm: null as ((name: string) => void) | null,
}));
vi.mock("@/stores/files-store", () => ({
  createEmptyFile: mocks.createEmptyFile,
  createFolder: mocks.createFolder,
  toggleDir: mocks.toggleDir,
  loadDir: vi.fn(),
  useFilesStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ dirs: {}, loading: {}, errors: {} }),
    { getState: () => ({ workspaceId: mocks.workspaceId }) },
  ),
}));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: mocks.openWorkspaceFile }));
vi.mock("@/components/sidebar/InlineInputs", () => ({
  InlineCreateInput: ({ onConfirm }: { onConfirm: (name: string) => void }) => {
    mocks.confirm = onConfirm;
    return null;
  },
  InlineRenameInput: () => null,
}));

import { DirChildren, type TreeContext } from "../src/components/sidebar/TreeNodeItem";

const ctx: TreeContext = {
  marks: new Map(),
  openPaths: new Set(),
  selectMode: false,
  selectedPaths: new Set(),
  showSystem: false,
  onOpen: vi.fn(),
  dragEntries: () => [],
  onInfo: vi.fn(),
  onUploadTo: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceId = "old";
  mocks.confirm = null;
});

test.each(["file", "folder"] as const)(
  "late new %s creation does not open or expand paths in a different workspace",
  async (kind) => {
    let finish!: (path: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    mocks.createEmptyFile.mockReturnValueOnce(pending);
    mocks.createFolder.mockReturnValueOnce(pending);
    renderToString(createElement(DirChildren, { path: "reports", depth: 0, ctx, creating: kind }));
    if (!mocks.confirm) throw new Error("create entry missing");
    mocks.confirm("new.xlsx");
    mocks.workspaceId = "new";
    finish("reports/new.xlsx");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.openWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.toggleDir).not.toHaveBeenCalled();
  },
);

test("creating a workbook in the current workspace still opens it and expands its folder", async () => {
  mocks.createEmptyFile.mockResolvedValueOnce("reports/new.xlsx");
  renderToString(createElement(DirChildren, { path: "reports", depth: 0, ctx, creating: "file" }));
  if (!mocks.confirm) throw new Error("create entry missing");
  mocks.confirm("new.xlsx");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.openWorkspaceFile).toHaveBeenCalledWith("reports/new.xlsx");
  expect(mocks.toggleDir).toHaveBeenCalledWith("reports", true);
});
