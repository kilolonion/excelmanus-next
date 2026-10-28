import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ uploadFile: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({ onSync: vi.fn(), subscribeTopic: vi.fn(), unsubscribeTopic: vi.fn() }));
vi.mock("@/stores/files-store", () => ({ useFilesStore: { getState: () => ({ workspaceId: "ws" }) }, loadDir: vi.fn() }));
import { addComposerFiles, attachWorkspaceFile, removeComposerAttachment, retryComposerAttachment, setViewAgent, useChatStore } from "../src/stores/chat-store";
beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ workspaceId: "ws", loading: false, loadError: null, sessionId: crypto.randomUUID(), viewAgentId: "main", attachments: [] });
});
test("retry reuses the original file and directory without duplicating attachment or request", async () => {
  mocks.uploadFile.mockRejectedValueOnce(new Error("temporary failure"));
  const file = new File(["sample"], "qa-retry.txt", { type: "text/plain" });
  await addComposerFiles([file], "reports");
  const id = useChatStore.getState().attachments[0]!.id;
  expect(useChatStore.getState().attachments[0]).toMatchObject({ status: "error", canRetry: true });
  let finish!: (value: { path: string }) => void;
  mocks.uploadFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const retry = retryComposerAttachment(id);
  await retryComposerAttachment(id);
  expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
  expect(mocks.uploadFile).toHaveBeenLastCalledWith("ws", { name: file.name, data: file, path: "reports" });
  setViewAgent("other");
  finish({ path: "reports/qa-retry.txt" }); await retry;
  expect(useChatStore.getState().attachments).toHaveLength(0);
  setViewAgent("main");
  expect(useChatStore.getState().attachments).toHaveLength(1);
  expect(useChatStore.getState().attachments[0]).toMatchObject({ id, status: "ready", path: "reports/qa-retry.txt" });
  removeComposerAttachment(id);
});
test("removing a failed attachment releases retry state and late replies do not resurrect it", async () => {
  mocks.uploadFile.mockRejectedValueOnce(new Error("offline"));
  await addComposerFiles([new File(["sample"], "qa-remove.txt")]);
  const id = useChatStore.getState().attachments[0]!.id;
  let finish!: (value: { path: string }) => void;
  mocks.uploadFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const retry = retryComposerAttachment(id);
  removeComposerAttachment(id);
  finish({ path: "qa-remove.txt" }); await retry;
  await retryComposerAttachment(id);
  expect(useChatStore.getState().attachments).toHaveLength(0);
  expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
});

test("new attachments cannot upload into the previous workspace while a conversation loads", async () => {
  useChatStore.setState({ loading: true, workspaceId: "previous-workspace" });
  await addComposerFiles([new File(["sample"], "waiting.txt")]);
  attachWorkspaceFile("previous.xlsx");
  expect(mocks.uploadFile).not.toHaveBeenCalled();
  expect(useChatStore.getState().attachments).toEqual([]);
  expect(useChatStore.getState().notice?.text).toContain("正在加载");
});

test("failed conversation loading requires retry before new attachments are added", async () => {
  useChatStore.setState({ loading: false, loadError: "failed" });
  attachWorkspaceFile("previous.xlsx");
  expect(useChatStore.getState().attachments).toEqual([]);
  expect(useChatStore.getState().notice?.text).toContain("重试");
});
