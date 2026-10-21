import { ApiError } from "@excelmanus/protocol";
import { beforeEach, expect, test, vi } from "vitest";

const network = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getDocSnapshot: vi.fn(),
  rewindAgent: vi.fn(),
  cancelDispatch: vi.fn(),
  switchAgentModel: vi.fn(),
  updateSession: vi.fn(),
  compactAgent: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => network, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

import {
  cancelQueuedMessage,
  compactNow,
  resendFailedMessage,
  restartFrom,
  rewindTo,
  sendMessage,
  setPermissionMode,
  useChatStore,
} from "../src/stores/chat-store";

const failed = () => ({
  clientMessageId: "failed",
  agentId: "main",
  text: "保留这个任务",
  at: "2026-10-15T00:00:00Z",
  context: [{ docId: "doc", rev: 2, range: "'订单'!A2:D4" }],
  attachments: [],
  error: "选区修订已变化，请重新选择区域",
  contextStale: true,
});
beforeEach(() => {
  vi.resetAllMocks();
  useChatStore.setState({
    sessionId: "session",
    workspaceId: "workspace",
    viewAgentId: "main",
    optimistic: [failed()],
    attachments: [],
    notice: null,
    composerInsert: null,
  });
  network.sendMessage.mockResolvedValue({});
});
test("retry refreshes stale revision but preserves the original message and range", async () => {
  network.getDocSnapshot.mockResolvedValue({ document: { rev: 5 } });
  expect(await resendFailedMessage("failed")).toBe(true);
  expect(network.sendMessage).toHaveBeenCalledWith(
    "session",
    "main",
    expect.objectContaining({
      text: "保留这个任务",
      context: [{ docId: "doc", rev: 5, range: "'订单'!A2:D4" }],
    }),
  );
});
test("failed refresh keeps the unsent message instead of sending or losing it", async () => {
  network.getDocSnapshot.mockRejectedValue(new Error("文档已不存在"));
  expect(await resendFailedMessage("failed")).toBe(false);
  expect(network.sendMessage).not.toHaveBeenCalled();
  expect(useChatStore.getState().optimistic).toEqual([
    expect.objectContaining({
      clientMessageId: "failed",
      text: "保留这个任务",
      error: "文档已不存在",
    }),
  ]);
});
test("repeated clicks do not duplicate refresh or send after navigating away", async () => {
  let finish!: (value: unknown) => void;
  network.getDocSnapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = resendFailedMessage("failed");
  await resendFailedMessage("failed");
  expect(network.getDocSnapshot).toHaveBeenCalledTimes(1);
  useChatStore.setState({ sessionId: "other", optimistic: [] });
  finish({ document: { rev: 5 } });
  expect(await pending).toBe(false);
  expect(network.sendMessage).not.toHaveBeenCalled();
  expect(useChatStore.getState().optimistic).toEqual([]);
});
test("ordinary send failures retain their original references", async () => {
  useChatStore.setState({ optimistic: [{ ...failed(), contextStale: false, error: "offline" }] });
  expect(await resendFailedMessage("failed")).toBe(true);
  expect(network.getDocSnapshot).not.toHaveBeenCalled();
  expect(network.sendMessage).toHaveBeenCalledWith(
    "session",
    "main",
    expect.objectContaining({ context: failed().context }),
  );
});

test("server revision conflicts are marked for refresh on the next explicit retry", async () => {
  useChatStore.setState({ optimistic: [{ ...failed(), contextStale: false, error: "offline" }] });
  network.sendMessage.mockRejectedValueOnce(
    new ApiError(409, "conflict", "选区修订已变化，请重新选择区域"),
  );
  expect(await resendFailedMessage("failed")).toBe(false);
  expect(useChatStore.getState().optimistic).toEqual([
    expect.objectContaining({ contextStale: true, context: failed().context }),
  ]);
});

const priorMessage = {
  id: "dispatch-old",
  agentId: "main",
  text: "原任务",
  context: [],
  attachments: [],
} as never;
function pendingResponse() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("restart does not send the old task to the new conversation after rewind completes", async () => {
  const pending = pendingResponse();
  network.rewindAgent.mockReturnValueOnce(pending.promise);
  useChatStore.setState({ viewAgentId: "main" });
  const restarting = restartFrom(priorMessage);
  useChatStore.setState({ sessionId: "other", optimistic: [] });
  pending.resolve({});
  expect(await restarting).toBe(false);
  expect(network.sendMessage).not.toHaveBeenCalled();
});

test("rewind completion cannot insert old text into a new conversation", async () => {
  const pending = pendingResponse();
  network.rewindAgent.mockReturnValueOnce(pending.promise);
  const rewinding = rewindTo(priorMessage);
  useChatStore.setState({ sessionId: "other", composerInsert: null });
  pending.resolve({});
  expect(await rewinding).toBe(false);
  expect(useChatStore.getState().composerInsert).toBeNull();
});

test("cancel completion cannot insert queued text after switching agents", async () => {
  const pending = pendingResponse();
  network.cancelDispatch.mockReturnValueOnce(pending.promise);
  useChatStore.setState({ viewAgentId: "main", composerInsert: null });
  const cancelling = cancelQueuedMessage(priorMessage);
  useChatStore.setState({ viewAgentId: "reader" });
  pending.resolve({});
  await cancelling;
  expect(useChatStore.getState().composerInsert).toBeNull();
});

test("restart keeps its normal rewind and resend flow when the view is unchanged", async () => {
  network.rewindAgent.mockResolvedValue({});
  expect(await restartFrom(priorMessage)).toBe(true);
  expect(network.sendMessage).toHaveBeenCalledWith(
    "session",
    "main",
    expect.objectContaining({ text: "原任务" }),
  );
  useChatStore.setState({ composerInsert: null });
  expect(await rewindTo(priorMessage)).toBe(true);
  expect(useChatStore.getState().composerInsert?.text).toBe("原任务");
});

test("navigation during model switch prevents the later rewind and resend", async () => {
  const pending = pendingResponse();
  network.switchAgentModel.mockReturnValueOnce(pending.promise);
  const restarting = restartFrom(priorMessage, { modelProfileId: "configured-model" });
  useChatStore.setState({ sessionId: "other" });
  pending.resolve({});
  expect(await restarting).toBe(false);
  expect(network.rewindAgent).not.toHaveBeenCalled();
  expect(network.sendMessage).not.toHaveBeenCalled();
});

test("permission update response cannot relabel a different conversation", async () => {
  const pending = pendingResponse();
  network.updateSession.mockReturnValueOnce(pending.promise);
  const updating = setPermissionMode("auto");
  useChatStore.setState((s) => ({
    sessionId: "other",
    session: { ...s.session, permissionMode: "confirm" },
  }));
  pending.resolve({});
  await updating;
  expect(useChatStore.getState().session.permissionMode).toBe("confirm");
});

test("late model command notice is not displayed in another conversation", async () => {
  const pending = pendingResponse();
  network.switchAgentModel.mockReturnValueOnce(pending.promise);
  const switching = sendMessage({ text: "/model configured" });
  useChatStore.setState({ sessionId: "other", notice: null });
  pending.resolve({ name: "old model" });
  await switching;
  expect(useChatStore.getState().notice).toBeNull();
});

test("late compact notice is not displayed after switching agent views", async () => {
  const pending = pendingResponse();
  network.compactAgent.mockReturnValueOnce(pending.promise);
  useChatStore.setState({ viewAgentId: "main", notice: null });
  const compacting = compactNow();
  useChatStore.setState({ viewAgentId: "reader" });
  pending.resolve({ compacted: true });
  await compacting;
  expect(useChatStore.getState().notice).toBeNull();
});

test("an unrecognized slash message cannot pick up the new conversation's attachments", async () => {
  const sending = sendMessage({ text: "/ordinary text" });
  useChatStore.setState({
    sessionId: "other",
    optimistic: [],
    attachments: [{ id: "new-file", name: "new.txt", size: 1, status: "ready", path: "new.txt" }],
  });
  expect(await sending).toBe(false);
  expect(network.sendMessage).not.toHaveBeenCalled();
  expect(useChatStore.getState().optimistic).toEqual([]);
});
