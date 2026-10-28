import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspaceId: "ws",
  version: 0,
  listAllFiles: vi.fn(),
  listSkills: vi.fn(),
  updates: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [null, h.updates],
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => h }));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ workspaceId: h.workspaceId }) },
}));
vi.mock("@/stores/files-store", () => ({
  listAllFiles: h.listAllFiles,
  useFilesStore: { getState: () => ({ version: h.version }) },
}));

import { useChatMentions } from "../src/components/chat/ChatMentionList";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount() {
  let result!: ReturnType<typeof useChatMentions>;
  function Probe() {
    result = useChatMentions();
    return null;
  }
  renderToString(createElement(Probe));
  const cleanups = h.effects.map((run) => run());
  return {
    ...result,
    unmount: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.workspaceId = "ws";
  h.version = 0;
  h.effects = [];
  h.listAllFiles.mockResolvedValue([{ path: "sample.xlsx" }]);
  h.listSkills.mockResolvedValue({ items: [] });
});
test("typing several mention characters shares the pending candidate read", async () => {
  const files = deferred<Array<{ path: string }>>();
  h.listAllFiles.mockReturnValue(files.promise);
  const page = mount();
  const first = page.fetchMentionData();
  const second = page.fetchMentionData();
  h.version++; // Directory traversal itself can populate another directory cache.
  const third = page.fetchMentionData();
  expect(h.listAllFiles).toHaveBeenCalledTimes(1);
  expect(h.listSkills).toHaveBeenCalledTimes(1);
  files.resolve([{ path: "sample.xlsx" }]);
  await Promise.all([first, second, third]);
});
test("closing mentions stops subsequent traversal and ignores the late result", async () => {
  const files = deferred<Array<{ path: string }>>();
  h.listAllFiles.mockReturnValue(files.promise);
  const page = mount();
  const read = page.fetchMentionData();
  const isActive = h.listAllFiles.mock.calls[0]?.[2] ?? (() => true);
  expect(isActive()).toBe(true);
  page.cancelMentionRead?.();
  expect(isActive()).toBe(false);
  h.updates.mockClear();
  files.resolve([{ path: "late.xlsx" }]);
  await read;
  expect(h.updates).not.toHaveBeenCalled();
});
test("unmount invalidates the read without aborting the shared directory request", async () => {
  const files = deferred<Array<{ path: string }>>();
  h.listAllFiles.mockReturnValue(files.promise);
  const page = mount();
  const read = page.fetchMentionData();
  page.unmount();
  h.updates.mockClear();
  files.resolve([{ path: "late.xlsx" }]);
  await read;
  expect(h.updates).not.toHaveBeenCalled();
});
test("reopening starts a new read and an old completion cannot release it", async () => {
  const old = deferred<Array<{ path: string }>>();
  const fresh = deferred<Array<{ path: string }>>();
  h.listAllFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const page = mount();
  const first = page.fetchMentionData();
  page.cancelMentionRead?.();
  const second = page.fetchMentionData();
  old.resolve([{ path: "old.xlsx" }]);
  await first;
  const third = page.fetchMentionData();
  expect(h.listAllFiles).toHaveBeenCalledTimes(2);
  fresh.resolve([{ path: "fresh.xlsx" }]);
  await Promise.all([second, third]);
  expect(h.updates).toHaveBeenLastCalledWith(expect.objectContaining({ files: ["fresh.xlsx"] }));
});
test("a changed workspace invalidates traversal even before a new candidate request", async () => {
  const files = deferred<Array<{ path: string }>>();
  h.listAllFiles.mockReturnValue(files.promise);
  const page = mount();
  const read = page.fetchMentionData();
  h.workspaceId = "new";
  const isActive = h.listAllFiles.mock.calls[0]?.[2] ?? (() => true);
  expect(isActive()).toBe(false);
  h.updates.mockClear();
  files.resolve([{ path: "old.xlsx" }]);
  await read;
  expect(h.updates).not.toHaveBeenCalled();
});
