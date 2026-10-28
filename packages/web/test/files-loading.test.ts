import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listFiles: vi.fn(), manageFiles: vi.fn(), createFile: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks, errorMessage: (e: Error) => e.message }));
vi.mock("@/stores/app-store", () => ({ onAppEvent: vi.fn() }));
vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  return { useSessionStore: create(() => ({ activeWorkspaceId: null as string | null })) };
});

import {
  createEmptyFile,
  createFolder,
  listAllFiles,
  loadDir,
  refreshFiles,
  useFilesStore,
} from "../src/stores/files-store";
import { useSessionStore } from "../src/stores/session-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const entry = (name: string) => ({ path: name, name, kind: "file", size: 1 });
beforeEach(() => {
  mocks.listFiles.mockReset().mockResolvedValue({ items: [] });
  useSessionStore.setState({ activeWorkspaceId: null });
  useFilesStore.setState({ workspaceId: "a", dirs: {}, loading: {}, errors: {}, version: 0 });
});
test("concurrent reads of the same directory share one request", async () => {
  const response = deferred<{ items: ReturnType<typeof entry>[] }>();
  mocks.listFiles.mockReturnValue(response.promise);
  const first = loadDir();
  const second = loadDir();
  expect(mocks.listFiles).toHaveBeenCalledTimes(1);
  response.resolve({ items: [entry("a.xlsx")] });
  expect(await first).toEqual(await second);
});
test("an invalidation during loading does one trailing read without flashing stale entries", async () => {
  const first = deferred<{ items: ReturnType<typeof entry>[] }>();
  const next = deferred<{ items: ReturnType<typeof entry>[] }>();
  mocks.listFiles.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  const loading = loadDir();
  const refresh = refreshFiles();
  const repeated = refreshFiles();
  first.resolve({ items: [entry("old.xlsx")] });
  await vi.waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(2));
  expect(useFilesStore.getState().dirs[""]).toBeUndefined();
  next.resolve({ items: [entry("new.xlsx")] });
  await Promise.all([loading, refresh, repeated]);
  expect(useFilesStore.getState().dirs[""]?.[0]?.path).toBe("new.xlsx");
});
test("a failed request from the previous workspace cannot overwrite the new workspace", async () => {
  const old = deferred<{ items: never[] }>();
  mocks.listFiles.mockReturnValueOnce(old.promise);
  const loading = loadDir();
  useSessionStore.setState({ activeWorkspaceId: "b" });
  await vi.waitFor(() => expect(useFilesStore.getState().dirs[""]).toEqual([]));
  old.reject(new Error("old workspace failed"));
  await loading;
  expect(useFilesStore.getState().errors).toEqual({});
  expect(useFilesStore.getState().loading[""]).toBe(false);
});
test("reading an unchanged directory does not invalidate every file preview", async () => {
  mocks.listFiles.mockResolvedValue({ items: [entry("same.xlsx")] });
  await loadDir();
  const version = useFilesStore.getState().version;
  await loadDir();
  expect(useFilesStore.getState().version).toBe(version);
});

test("refresh includes first-time pending children and retries failed children", async () => {
  await loadDir();
  const pending = deferred<{ items: ReturnType<typeof entry>[] }>();
  mocks.listFiles.mockImplementation((_workspace: string, path: string) =>
    path === "reports" ? pending.promise : Promise.resolve({ items: [] }),
  );
  const child = loadDir("reports");
  const refresh = refreshFiles();
  mocks.listFiles.mockResolvedValue({ items: [entry("new.xlsx")] });
  pending.resolve({ items: [entry("stale.xlsx")] });
  await Promise.all([child, refresh]);
  expect(useFilesStore.getState().dirs.reports?.[0]?.path).toBe("new.xlsx");

  mocks.listFiles.mockRejectedValueOnce(new Error("temporary"));
  await loadDir("unread");
  expect(useFilesStore.getState().errors.unread).toBe("temporary");
  await refreshFiles();
  expect(useFilesStore.getState().dirs.unread?.[0]?.path).toBe("new.xlsx");
  expect(useFilesStore.getState().errors.unread).toBeUndefined();
});

test("retry clears the previous directory error immediately while preserving cached entries", async () => {
  useFilesStore.setState({ dirs: { reports: [] }, errors: { reports: "temporary" } });
  const pending = deferred<{ items: never[] }>();
  mocks.listFiles.mockReturnValueOnce(pending.promise);
  const retry = loadDir("reports", true);
  expect(useFilesStore.getState().loading.reports).toBe(true);
  expect(useFilesStore.getState().errors.reports).toBeUndefined();
  expect(useFilesStore.getState().dirs.reports).toEqual([]);
  pending.resolve({ items: [] });
  await retry;
});

test("file pickers receive read failures instead of a false empty list", async () => {
  mocks.listFiles.mockRejectedValueOnce(new Error("root unavailable"));
  await expect(listAllFiles()).rejects.toThrow("root unavailable");
  useFilesStore.setState({
    dirs: { "": [{ path: "reports", name: "reports", kind: "dir" }] },
    errors: {},
  });
  mocks.listFiles.mockRejectedValueOnce(new Error("child unavailable"));
  await expect(listAllFiles()).rejects.toThrow("child unavailable");
});

test("a recursive listing never returns a mix of old and new workspaces", async () => {
  useFilesStore.setState({
    dirs: {
      "": [
        { path: "old.xlsx", name: "old.xlsx", kind: "file" },
        { path: "reports", name: "reports", kind: "dir" },
      ],
    },
  });
  const pending = deferred<{ items: never[] }>();
  mocks.listFiles.mockReturnValueOnce(pending.promise);
  const listing = listAllFiles();
  useSessionStore.setState({ activeWorkspaceId: "b" });
  pending.resolve({ items: [] });
  expect(await listing).toEqual([]);
});

for (const kind of ["folder", "file"] as const) {
  test(`${kind} creation finishing in the old workspace does not refresh the new workspace`, async () => {
    const pending = deferred<unknown>();
    if (kind === "folder") mocks.manageFiles.mockReturnValueOnce(pending.promise);
    else mocks.createFile.mockReturnValueOnce(pending.promise);
    const create = kind === "folder" ? createFolder("reports") : createEmptyFile("report.xlsx");
    useSessionStore.setState({ activeWorkspaceId: "b" });
    await vi.waitFor(() => expect(useFilesStore.getState().dirs[""]).toEqual([]));
    mocks.listFiles.mockClear();
    pending.resolve(kind === "folder" ? { paths: ["reports"] } : { path: "report.xlsx" });
    await create;
    expect(mocks.listFiles).not.toHaveBeenCalled();
  });
}

test("creation in the current workspace still refreshes and returns its result", async () => {
  mocks.manageFiles.mockResolvedValueOnce({ paths: ["reports"] });
  expect(await createFolder("reports")).toEqual(["reports"]);
  expect(mocks.listFiles).toHaveBeenLastCalledWith("a", "");
  mocks.listFiles.mockClear();
  mocks.createFile.mockResolvedValueOnce({ path: "report.xlsx" });
  expect(await createEmptyFile("report")).toBe("report.xlsx");
  expect(mocks.listFiles).toHaveBeenLastCalledWith("a", "");
});

test("an abandoned file picker stops walking remaining directories", async () => {
  useFilesStore.setState({
    dirs: {
      "": [
        { path: "first", name: "first", kind: "dir" },
        { path: "later", name: "later", kind: "dir" },
      ],
    },
  });
  const pending = deferred<{ items: never[] }>();
  mocks.listFiles.mockReturnValueOnce(pending.promise);
  let active = true;
  const listing = listAllFiles(2000, 6, () => active);
  active = false;
  pending.resolve({ items: [] });
  expect(await listing).toEqual([]);
  expect(mocks.listFiles).toHaveBeenCalledTimes(1);
  expect(mocks.listFiles).not.toHaveBeenCalledWith("a", "later");
});

test("directory refresh compares entries without serializing both full lists", async () => {
  const previous = [{ path: "a.xlsx", name: "a.xlsx", kind: "file" as const, size: 1 }];
  const next = previous.map((item) => ({ ...item }));
  useFilesStore.setState({ dirs: { "": previous } });
  mocks.listFiles.mockResolvedValue({ items: next });
  const stringify = vi.spyOn(JSON, "stringify");
  let listSerializations = 0;
  try {
    await loadDir();
    listSerializations = stringify.mock.calls.filter(
      ([value]) => value === previous || value === next,
    ).length;
  } finally {
    stringify.mockRestore();
  }
  expect(listSerializations).toBe(0);
  expect(useFilesStore.getState().dirs[""]).toBe(previous);
  expect(useFilesStore.getState().version).toBe(0);
});
test("a changed first entry does not force reading every remaining entry", async () => {
  const readLastName = vi.fn(() => "last.xlsx");
  const last = {
    path: "last.xlsx",
    get name() {
      return readLastName();
    },
    kind: "file" as const,
  };
  useFilesStore.setState({
    dirs: { "": [{ path: "a.xlsx", name: "a.xlsx", kind: "file" }, last] },
  });
  mocks.listFiles.mockResolvedValue({
    items: [{ path: "new.xlsx", name: "new.xlsx", kind: "file" }, last],
  });
  await loadDir();
  expect(readLastName).not.toHaveBeenCalled();
  expect(useFilesStore.getState().version).toBe(1);
});
test("property ordering and absent optional metadata do not invalidate unchanged directories", async () => {
  const previous = [{ name: "a.xlsx", path: "a.xlsx", kind: "file" as const, size: undefined }];
  useFilesStore.setState({ dirs: { "": previous } });
  mocks.listFiles.mockResolvedValue({ items: [{ kind: "file", path: "a.xlsx", name: "a.xlsx" }] });
  await loadDir();
  expect(useFilesStore.getState().dirs[""]).toBe(previous);
  expect(useFilesStore.getState().version).toBe(0);
});
test("all directory metadata changes still publish a new version", async () => {
  const base = {
    name: "a.xlsx",
    path: "a.xlsx",
    kind: "file" as const,
    size: 1,
    modifiedAt: "old",
    openedAt: "old",
  };
  for (const change of [
    { name: "b.xlsx" },
    { path: "folder/a.xlsx" },
    { kind: "dir" },
    { size: 2 },
    { modifiedAt: "new" },
    { openedAt: "new" },
  ]) {
    useFilesStore.setState({ dirs: { "": [base] }, version: 0 });
    const next = [{ ...base, ...change }];
    mocks.listFiles.mockResolvedValue({ items: next });
    await loadDir();
    expect(useFilesStore.getState().dirs[""]).toBe(next);
    expect(useFilesStore.getState().version).toBe(1);
  }
});
test("cached directory traversal keeps breadth-first order without shifting the queue", async () => {
  const dir = (path: string) => ({ path, name: path, kind: "dir" as const });
  const file = (path: string) => ({ path, name: path, kind: "file" as const });
  useFilesStore.setState({
    dirs: {
      "": [dir("a"), dir("b"), file("root.txt")],
      a: [dir("a/deep"), file("a/first.txt")],
      b: [file("b/second.txt")],
      "a/deep": [file("a/deep/third.txt")],
    },
  });
  const shift = Array.prototype.shift;
  let shiftCalls = 0;
  let result: ReturnType<typeof listAllFiles> = Promise.resolve([]);
  Array.prototype.shift = function () {
    shiftCalls++;
    return shift.call(this);
  };
  try {
    result = listAllFiles();
  } finally {
    Array.prototype.shift = shift;
  }
  expect((await result).map((entry) => entry.path)).toEqual([
    "root.txt",
    "a/first.txt",
    "b/second.txt",
    "a/deep/third.txt",
  ]);
  expect(shiftCalls).toBe(0);
  expect(mocks.listFiles).not.toHaveBeenCalled();
  expect((await listAllFiles(2)).map((entry) => entry.path)).toEqual(["root.txt", "a/first.txt"]);
  expect((await listAllFiles(20, 1)).map((entry) => entry.path)).toEqual(["root.txt"]);
});
