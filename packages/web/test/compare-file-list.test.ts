import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listAllFiles: vi.fn() }));
vi.mock("@/stores/files-store", () => ({
  listAllFiles: mocks.listAllFiles,
  useFilesStore: vi.fn(),
}));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));

import { readComparisonFiles } from "../src/components/excel/CompareDialog";

test("comparison file reads report failure and can be retried instead of silently looking empty", async () => {
  mocks.listAllFiles.mockRejectedValueOnce(new Error("读取目录失败"));
  const failed = await readComparisonFiles();
  expect(failed.error).toBe("读取目录失败");
  mocks.listAllFiles.mockResolvedValueOnce([
    { path: "sample.xlsx", name: "sample.xlsx", kind: "file" },
    { path: "notes.txt", name: "notes.txt", kind: "file" },
  ]);
  const ready = await readComparisonFiles();
  expect(ready.error).toBeNull();
  expect(ready.files.map((f) => f.path)).toEqual(["sample.xlsx"]);
});

test("an empty comparison file list is a successful empty result", async () => {
  mocks.listAllFiles.mockResolvedValueOnce([]);
  expect(await readComparisonFiles()).toEqual({ files: [], error: null });
});
