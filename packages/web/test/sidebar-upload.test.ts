import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ uploadFile: vi.fn(), listFiles: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  api: () => mocks,
  errorMessage: (e: Error) => e.message,
  saveBlob: vi.fn(),
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmAction: vi.fn() }));
vi.mock("@/stores/chat-store", () => ({ attachWorkspaceFile: vi.fn() }));
vi.mock("@/stores/workbook-store", () => ({
  closeTab: vi.fn(),
  relocateWorkbook: vi.fn(),
  useWorkbookStore: { getState: () => ({ tabs: [] }) },
}));
vi.mock("@/stores/app-store", () => ({ onAppEvent: vi.fn() }));
vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  return { useSessionStore: create(() => ({ activeWorkspaceId: null as string | null })) };
});

import { uploadInto } from "../src/components/sidebar/file-actions";
import { useFilesStore } from "../src/stores/files-store";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listFiles.mockResolvedValue({ items: [] });
  useFilesStore.setState({
    workspaceId: "original",
    dirs: {},
    loading: {},
    errors: {},
    version: 0,
  });
});

test("a sidebar upload batch keeps its original workspace after switching away", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: Array<{ workspace: string; name: string }> = [];
  mocks.uploadFile.mockImplementation(async (workspace: string, input: { name: string }) => {
    written.push({ workspace, name: input.name });
    if (written.length === 1) await first;
    return { path: `reports/${input.name}` };
  });
  const pending = uploadInto([new File(["a"], "a.txt"), new File(["b"], "b.txt")], "reports");
  useFilesStore.setState({ workspaceId: "new-workspace" });
  release();
  expect(await pending).toEqual(["reports/a.txt", "reports/b.txt"]);
  expect(written).toEqual([
    { workspace: "original", name: "a.txt" },
    { workspace: "original", name: "b.txt" },
  ]);
  expect(mocks.listFiles).not.toHaveBeenCalled();
});

test("a failed file does not stop later uploads or change their captured target", async () => {
  const written: string[] = [];
  mocks.uploadFile.mockImplementation(async (workspace: string, input: { name: string }) => {
    written.push(`${workspace}/${input.name}`);
    if (input.name === "bad.txt") {
      useFilesStore.setState({ workspaceId: "new-workspace" });
      throw new Error("上传失败");
    }
    return { path: input.name };
  });
  expect(await uploadInto([new File(["a"], "bad.txt"), new File(["b"], "good.txt")])).toEqual([
    "good.txt",
  ]);
  expect(written).toEqual(["original/bad.txt", "original/good.txt"]);
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "error", title: "1 个文件上传失败" }),
  );
});

test("uploads on the original workspace still refresh their destination directory", async () => {
  mocks.uploadFile.mockResolvedValue({ path: "reports/ok.txt" });
  expect(await uploadInto([new File(["ok"], "ok.txt")], "reports")).toEqual(["reports/ok.txt"]);
  expect(mocks.listFiles).toHaveBeenCalledWith("original", "reports");
  expect(useFilesStore.getState().dirs.reports).toEqual([]);
});
