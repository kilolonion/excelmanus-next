import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ downloadFile: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks, errorMessage: (e: Error) => e.message }));

vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  return { useSessionStore: create(() => ({ activeWorkspaceId: "ws" as string | null })) };
});

import * as preview from "../src/stores/preview-store";
import { useSessionStore } from "../src/stores/session-store";

function deferred() {
  let resolve!: (value: Blob) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Blob>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  preview.closePreview();
  mocks.downloadFile.mockReset();
});
test("switching text tabs discards the old response and old loading state", async () => {
  expect(preview.loadTextPreview).toBeTypeOf("function");
  const a = deferred(),
    b = deferred();
  mocks.downloadFile.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = preview.loadTextPreview("ws", "a.txt", 1);
  const second = preview.loadTextPreview("ws", "b.txt", 1);
  b.resolve(new Blob(["B"]));
  await second;
  a.resolve(new Blob(["A"]));
  await first;
  expect(preview.usePreviewStore.getState().textContent).toMatchObject({
    path: "b.txt",
    content: "B",
    loading: false,
    error: "",
  });
});
test("old errors and responses cannot revive a closed preview", async () => {
  expect(preview.loadTextPreview).toBeTypeOf("function");
  const pending = deferred();
  mocks.downloadFile.mockReturnValue(pending.promise);
  const loading = preview.loadTextPreview("ws", "a.txt", 1);
  preview.closePreview();
  pending.reject(new Error("old failure"));
  await loading;
  expect(preview.usePreviewStore.getState().textContent).toBeNull();
});
test("cache keys include workspace and revision; a new selection clears displayed text immediately", async () => {
  expect(preview.loadTextPreview).toBeTypeOf("function");
  mocks.downloadFile.mockResolvedValueOnce(new Blob(["A"]));
  await preview.loadTextPreview("a", "same.txt", 1);
  await preview.loadTextPreview("a", "same.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
  const next = deferred();
  mocks.downloadFile.mockReturnValue(next.promise);
  const loading = preview.loadTextPreview("b", "same.txt", 1);
  expect(preview.usePreviewStore.getState().textContent).toMatchObject({
    workspaceId: "b",
    content: "",
    loading: true,
  });
  next.resolve(new Blob(["B"]));
  await loading;
  expect(preview.usePreviewStore.getState().textContent?.content).toBe("B");
});

test("reopening the same text file creates a fresh view identity", () => {
  preview.openTextPreview("a.txt");
  const first = preview.usePreviewStore.getState().text;
  preview.openTextPreview("a.txt");
  expect(preview.usePreviewStore.getState().text?.generation).not.toBe(first?.generation);
});

test("failed text reads can retry in place and closing during retry discards late content", async () => {
  preview.openTextPreview("a.txt");
  mocks.downloadFile.mockRejectedValueOnce(new Error("temporary"));
  await preview.loadTextPreview("ws", "a.txt", 1);
  expect(preview.usePreviewStore.getState().textContent?.error).toBe("temporary");
  const next = deferred();
  mocks.downloadFile.mockReturnValueOnce(next.promise);
  const retry = preview.loadTextPreview("ws", "a.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
  expect(preview.usePreviewStore.getState().textContent).toMatchObject({
    loading: true,
    error: "",
  });
  next.resolve(new Blob(["recovered"]));
  await retry;
  expect(preview.usePreviewStore.getState().textContent?.content).toBe("recovered");
  const late = deferred();
  mocks.downloadFile.mockReturnValueOnce(late.promise);
  const refreshing = preview.loadTextPreview("ws", "a.txt", 2);
  preview.closePreview();
  late.resolve(new Blob(["late"]));
  await refreshing;
  expect(preview.usePreviewStore.getState().textContent).toBeNull();
});

test.each(["close", "switch"])("%s skips decoding an obsolete text download", async (action) => {
  const pending = deferred();
  mocks.downloadFile.mockReturnValueOnce(pending.promise);
  const loading = preview.loadTextPreview("ws", "old.txt", 1);
  if (action === "close") preview.closePreview();
  else preview.openTextPreview("new.txt");
  const blob = new Blob(["obsolete text"]);
  const decode = vi.spyOn(blob, "text");
  pending.resolve(blob);
  await loading;
  expect(decode).not.toHaveBeenCalled();
  expect(preview.usePreviewStore.getState().textContent).toBeNull();
});

test("switching workspace clears preview targets and recent relative paths", () => {
  useSessionStore.setState({ activeWorkspaceId: "a" });
  preview.openTextPreview("report.txt");
  preview.openImagePreview("chart.png");
  useSessionStore.setState({ activeWorkspaceId: "b" });
  expect(preview.usePreviewStore.getState()).toMatchObject({
    text: null,
    image: null,
    textContent: null,
    recent: [],
  });
});

test("switching workspace invalidates a pending text read; same workspace retains the preview", async () => {
  useSessionStore.setState({ activeWorkspaceId: "a" });
  preview.openTextPreview("report.txt");
  useSessionStore.setState({ activeWorkspaceId: "a" });
  expect(preview.usePreviewStore.getState().text?.path).toBe("report.txt");
  const pending = deferred();
  mocks.downloadFile.mockReturnValueOnce(pending.promise);
  const reading = preview.loadTextPreview("a", "report.txt", 1);
  useSessionStore.setState({ activeWorkspaceId: "b" });
  pending.resolve(new Blob(["old workspace"]));
  await reading;
  expect(preview.usePreviewStore.getState().textContent).toBeNull();
});
test("text cache releases entries that fall out of the recent preview tabs", async () => {
  mocks.downloadFile.mockResolvedValue(new Blob(["text"]));
  for (let i = 0; i < 11; i++) {
    preview.openTextPreview(`preview-${i}.txt`);
    await preview.loadTextPreview("ws", `preview-${i}.txt`, 1);
  }
  expect(preview.usePreviewStore.getState().recent).toHaveLength(10);
  await preview.loadTextPreview("ws", "preview-10.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(11);
  preview.openTextPreview("preview-0.txt");
  await preview.loadTextPreview("ws", "preview-0.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(12);
});

test("large text previews evict older cache contents without truncating the active file", async () => {
  const text = "中".repeat(9 * 1024 * 1024);
  mocks.downloadFile.mockImplementation(async () => ({ text: async () => text }));
  await preview.loadTextPreview("budget", "a.txt", 1);
  await preview.loadTextPreview("budget", "b.txt", 1);
  expect(preview.usePreviewStore.getState().textContent?.content).toBe(text);
  await preview.loadTextPreview("budget", "b.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
  await preview.loadTextPreview("budget", "a.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(3);
});

test("oversized text remains viewable but is not retained in the preview cache", async () => {
  const text = "中".repeat(17 * 1024 * 1024);
  mocks.downloadFile.mockImplementation(async (_ws: string, path: string) => ({
    text: async () => (path === "big.txt" ? text : "small"),
  }));
  await preview.loadTextPreview("budget", "small.txt", 1);
  await preview.loadTextPreview("budget", "big.txt", 1);
  expect(preview.usePreviewStore.getState().textContent?.content).toBe(text);
  await preview.loadTextPreview("budget", "small.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
  await preview.loadTextPreview("budget", "big.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(3);
});

test("text cache pressure evicts the least recently viewed file", async () => {
  const text = "中".repeat(6 * 1024 * 1024);
  mocks.downloadFile.mockImplementation(async () => ({ text: async () => text }));
  await preview.loadTextPreview("lru", "a.txt", 1);
  await preview.loadTextPreview("lru", "b.txt", 1);
  await preview.loadTextPreview("lru", "a.txt", 1);
  await preview.loadTextPreview("lru", "c.txt", 1);
  await preview.loadTextPreview("lru", "a.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(3);
  await preview.loadTextPreview("lru", "b.txt", 1);
  expect(mocks.downloadFile).toHaveBeenCalledTimes(4);
});
