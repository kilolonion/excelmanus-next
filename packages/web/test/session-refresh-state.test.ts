import type { LogRecord, PendingInteraction, ServerMessage } from "@excelmanus/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const network = vi.hoisted(() => ({
  getSessionLog: vi.fn(),
  getSession: vi.fn(),
  getSessionHistoryWindow: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  receive: null as null | ((message: ServerMessage) => void),
  subscribeTopic: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  api: () => network,
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/backend/channel", () => ({
  onSync: (receive: (message: ServerMessage) => void) => {
    const previous = network.receive;
    network.receive = (message) => {
      previous?.(message);
      receive(message);
    };
  },
  subscribeTopic: network.subscribeTopic,
  unsubscribeTopic: vi.fn(),
}));

import { agentBusy, visibleTimeline } from "../src/lib/session/reducer";
import {
  clearChatSession,
  loadChatSession,
  loadOlderChat,
  useChatStore,
} from "../src/stores/chat-store";
import {
  openWorkspace,
  refreshSessions,
  restoreSavedWorkspace,
  selectSession,
  useSessionStore,
} from "../src/stores/session-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function record(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  agentId = "main",
): LogRecord {
  return {
    sessionId: "refresh-session",
    agentId,
    seq,
    type,
    data,
    createdAt: "2026-10-21T08:00:00Z",
  };
}

const prefix = [
  record(1, "session.created", { title: "刷新恢复", permissionMode: "standard" }),
  record(2, "agent.spawned", { name: "主代理", role: "main", parentId: null }),
  record(3, "user.message", { dispatchId: "dispatch", clientMessageId: "message", text: "任务" }),
  record(4, "dispatch.updated", { dispatchId: "dispatch", status: "applied" }),
  record(5, "turn.started", { turnId: "turn" }),
];

function detail(headSeq: number, status: string) {
  return {
    session: { workspaceId: "workspace", permissionMode: "standard", title: "刷新恢复" },
    headSeq,
    pendingInteractions: undefined as PendingInteraction[] | undefined,
    agents: [
      { id: "main", name: "主代理", role: "main", parentId: null, status, modelProfileId: null },
    ],
  };
}

function pending(
  id: string,
  kind: PendingInteraction["kind"],
  agentId = "worker",
): PendingInteraction {
  return { id, kind, agentId, toolCallId: null, createdAt: "2026-10-21T08:00:00Z" };
}

async function restoreWithEarlierDetail(
  snapshot: ReturnType<typeof detail>,
  records: LogRecord[],
  detailFirst = true,
) {
  const logResponse = deferred<{ items: LogRecord[] }>();
  const detailResponse = deferred<ReturnType<typeof detail>>();
  network.getSessionLog.mockReturnValueOnce(logResponse.promise);
  network.getSession.mockReturnValueOnce(detailResponse.promise);
  const restoring = loadChatSession("refresh-session");
  // Response arrival order does not determine the freshness of either snapshot.
  if (detailFirst) {
    detailResponse.resolve(snapshot);
    await Promise.resolve();
    logResponse.resolve({ items: records });
  } else {
    logResponse.resolve({ items: records });
    await Promise.resolve();
    detailResponse.resolve(snapshot);
  }
  await restoring;
  const cursor = useChatStore.getState().session.cursor;
  network.receive?.({
    type: "sub.ok",
    topic: "session:refresh-session",
    cursor,
    headCursor: cursor,
  });
  return useChatStore.getState();
}

beforeEach(() => {
  clearChatSession();
  vi.resetAllMocks();
  network.getSessionHistoryWindow.mockResolvedValue({ kind: "overflow", headSeq: 10000 });
  useChatStore.setState(useChatStore.getInitialState());
  useSessionStore.setState(useSessionStore.getInitialState());
});
afterEach(() => vi.unstubAllGlobals());

function saveNavigation(sessionId = "refresh-session") {
  const values = new Map([
    ["excelmanus.navigation", JSON.stringify({ sessions: { workspace: sessionId } })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
}

test("saved restore begins while sidebar page two is pending without publishing a partial list", async () => {
  saveNavigation();
  const pageTwo = deferred<{ items: never[] }>();
  network.listSessions
    .mockResolvedValueOnce({ items: [], nextCursor: "page-two" })
    .mockReturnValueOnce(pageTwo.promise);
  network.getSession.mockResolvedValue(detail(5, "running"));
  network.getSessionLog.mockResolvedValue({ items: prefix });
  useSessionStore.setState({ seen: { retained: 42 } });
  const options = { signal: new AbortController().signal };
  const listing = refreshSessions(options);
  await Promise.resolve();
  expect(await restoreSavedWorkspace("workspace", options)).toBe(true);
  expect(network.getSessionLog).toHaveBeenCalled();
  expect(useSessionStore.getState()).toMatchObject({
    activeSessionId: "refresh-session",
    listLoaded: false,
    seen: { retained: 42 },
  });
  expect(network.listSessions).toHaveBeenLastCalledWith(
    { limit: 200, cursor: "page-two" },
    options,
  );
  expect(network.createSession).not.toHaveBeenCalled();
  pageTwo.resolve({ items: [] });
  await listing;
  expect(useSessionStore.getState().listLoaded).toBe(true);
});

test("saved restore validates workspace ownership before publishing or loading history", async () => {
  saveNavigation();
  const wrong = detail(0, "idle");
  wrong.session.workspaceId = "another-workspace";
  network.getSession.mockResolvedValueOnce(wrong);
  expect(await restoreSavedWorkspace("workspace")).toBe(false);
  expect(useSessionStore.getState().activeSessionId).toBeNull();
  expect(network.getSessionLog).not.toHaveBeenCalled();
  expect(network.createSession).not.toHaveBeenCalled();
});

test("saved restore only treats a 404 as absence, not network or authentication failure", async () => {
  saveNavigation();
  const { ApiError } = await import("@excelmanus/protocol");
  network.getSession.mockRejectedValueOnce(new ApiError(404, "not_found", "missing"));
  expect(await restoreSavedWorkspace("workspace")).toBe(false);
  for (const error of [
    new Error("network"),
    new ApiError(401, "unauthorized", "no"),
    new ApiError(403, "forbidden", "no"),
  ]) {
    network.getSession.mockRejectedValueOnce(error);
    await expect(restoreSavedWorkspace("workspace")).rejects.toBe(error);
  }
  expect(network.createSession).not.toHaveBeenCalled();
});

test("new navigation wins over a late saved-session validation", async () => {
  saveNavigation();
  const old = deferred<ReturnType<typeof detail>>();
  network.getSession.mockReturnValueOnce(old.promise);
  const restoring = restoreSavedWorkspace("workspace");
  network.getSession.mockResolvedValueOnce(detail(5, "running"));
  network.getSessionLog.mockResolvedValueOnce({ items: prefix });
  await selectSession("new-session");
  old.resolve(detail(5, "running"));
  expect(await restoring).toBe(true);
  expect(useSessionStore.getState().activeSessionId).toBe("new-session");
  expect(network.getSessionLog).toHaveBeenCalledTimes(1);
});

test("a failed or aborted complete-list read retains the previous sidebar and unread state", async () => {
  useSessionStore.setState({ seen: { retained: 42 }, listLoaded: false });
  network.listSessions.mockRejectedValueOnce(new Error("offline"));
  await expect(refreshSessions()).rejects.toThrow("offline");
  expect(useSessionStore.getState()).toMatchObject({ seen: { retained: 42 }, listLoaded: false });
  const page = deferred<{ items: never[] }>();
  network.listSessions.mockReturnValueOnce(page.promise);
  const controller = new AbortController();
  const listing = refreshSessions({ signal: controller.signal });
  controller.abort();
  page.resolve({ items: [] });
  await expect(listing).rejects.toMatchObject({ name: "AbortError" });
  expect(useSessionStore.getState()).toMatchObject({ seen: { retained: 42 }, listLoaded: false });
});

test("a canceled saved validation cannot publish, and missing preference never creates a session", async () => {
  saveNavigation();
  const validation = deferred<ReturnType<typeof detail>>();
  network.getSession.mockReturnValueOnce(validation.promise);
  const controller = new AbortController();
  const restoring = restoreSavedWorkspace("workspace", { signal: controller.signal });
  controller.abort();
  validation.resolve(detail(5, "running"));
  await expect(restoring).rejects.toMatchObject({ name: "AbortError" });
  expect(useSessionStore.getState().activeSessionId).toBeNull();
  expect(await restoreSavedWorkspace("unknown-workspace")).toBe(false);
  expect(network.getSessionLog).not.toHaveBeenCalled();
  expect(network.createSession).not.toHaveBeenCalled();
});

test("an obsolete saved validation failure cannot replace the newer navigation with an error", async () => {
  saveNavigation();
  let reject!: (reason: Error) => void;
  network.getSession.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const restoring = restoreSavedWorkspace("workspace");
  network.getSession.mockResolvedValueOnce(detail(5, "running"));
  network.getSessionLog.mockResolvedValueOnce({ items: prefix });
  await selectSession("new-session");
  reject(new Error("old request failed"));
  expect(await restoring).toBe(true);
  expect(useSessionStore.getState().activeSessionId).toBe("new-session");
});

test("a boot canceled during create does not repeat the mutation or select its late result", async () => {
  const creating = deferred<{ session: { id: string } }>();
  network.createSession.mockReturnValueOnce(creating.promise);
  const controller = new AbortController();
  const opening = openWorkspace("workspace", { signal: controller.signal });
  controller.abort();
  creating.resolve({ session: { id: "late-created" } });
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(network.createSession).toHaveBeenCalledTimes(1);
  expect(network.createSession).toHaveBeenCalledWith({
    workspaceId: "workspace",
    reuseBlank: true,
  });
  expect(network.listSessions).not.toHaveBeenCalled();
  expect(useSessionStore.getState().activeSessionId).toBeNull();
});

test("a complete history window replays equivalent current facts without legacy reads", async () => {
  const records = [...prefix, record(6, "turn.completed", { turnId: "turn" })];
  network.getSessionHistoryWindow.mockResolvedValueOnce({
    kind: "complete",
    detail: detail(6, "idle"),
    headSeq: 6,
    items: records,
    hasMore: false,
  });
  await loadChatSession("refresh-session", undefined, "workspace");
  expect(network.getSessionLog).not.toHaveBeenCalled();
  expect(network.getSession).not.toHaveBeenCalled();
  const state = useChatStore.getState();
  expect(state).toMatchObject({ loading: false, workspaceId: "workspace", hasOlder: false });
  expect(state.session.cursor).toBe(6);
  expect(visibleTimeline(state.session, "main").find((item) => item.kind === "turn")).toMatchObject(
    { status: "completed" },
  );
  expect(state.session.dispatches.dispatch?.status).toBe("applied");
  expect(agentBusy(state.session, "main")).toBe(false);
});

test("overflow retains loading until the complete legacy fallback has arrived", async () => {
  network.getSessionHistoryWindow.mockResolvedValueOnce({ kind: "overflow", headSeq: 5 });
  const history = deferred<{ items: LogRecord[] }>();
  network.getSessionLog.mockReturnValueOnce(history.promise);
  network.getSession.mockResolvedValueOnce(detail(5, "running"));
  const restoring = loadChatSession("refresh-session");
  await vi.waitFor(() => expect(network.getSessionLog).toHaveBeenCalled());
  expect(useChatStore.getState().loading).toBe(true);
  expect(useChatStore.getState().session.cursor).toBe(0);
  expect(network.getSessionLog).toHaveBeenCalledWith(
    "refresh-session",
    { before: 6, limit: 100 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  history.resolve({ items: prefix });
  await restoring;
  expect(useChatStore.getState().loading).toBe(false);
  expect(useChatStore.getState().session.cursor).toBe(5);
});

test("a complete window with changed workspace ownership cannot publish history", async () => {
  const snapshot = detail(5, "running");
  snapshot.session.workspaceId = "wrong-workspace";
  network.getSessionHistoryWindow.mockResolvedValueOnce({
    kind: "complete",
    detail: snapshot,
    headSeq: 5,
    items: prefix,
    hasMore: false,
  });
  await expect(loadChatSession("refresh-session", undefined, "workspace")).rejects.toThrow(
    "不属于当前工作区",
  );
  expect(useChatStore.getState().session.cursor).toBe(0);
  expect(useChatStore.getState().workspaceId).not.toBe("wrong-workspace");
});

test("overflow detail failure aborts the pending history read and prevents another page", async () => {
  network.getSessionHistoryWindow.mockResolvedValueOnce({ kind: "overflow", headSeq: 199 });
  const firstPage = deferred<{ items: LogRecord[] }>();
  let historySignal: AbortSignal | undefined;
  network.getSessionLog.mockImplementationOnce((_session, _query, options) => {
    historySignal = options.signal;
    return firstPage.promise;
  });
  const failure = new Error("detail unavailable");
  network.getSession.mockRejectedValueOnce(failure);
  await expect(loadChatSession("refresh-session")).rejects.toBe(failure);
  expect(historySignal?.aborted).toBe(true);
  expect(network.getSessionLog).toHaveBeenCalledTimes(1);
  // A full page without a safe turn boundary would normally fetch the previous page.
  firstPage.resolve({
    items: Array.from({ length: 100 }, (_, index) =>
      record(100 + index, "model.output", { text: "partial" }),
    ),
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(network.getSessionLog).toHaveBeenCalledTimes(1);
  expect(useChatStore.getState().session.cursor).toBe(0);
});

test.each([true, false])(
  "refresh keeps a completed log turn idle (detail first: %s)",
  async (detailFirst) => {
    const records = [
      ...prefix,
      record(6, "step.started", { stepId: "step" }),
      record(7, "model.output", { stepId: "step", text: "任务已完成" }),
      record(8, "turn.completed", { turnId: "turn" }),
    ];
    const state = await restoreWithEarlierDetail(detail(6, "running"), records, detailFirst);
    expect(state.loading).toBe(false);
    expect(state.session.cursor).toBe(8);
    const timeline = visibleTimeline(state.session, "main");
    expect(timeline.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(timeline.find((item) => item.kind === "turn")).toMatchObject({
      status: "completed",
      blocks: [expect.objectContaining({ type: "text", text: "任务已完成" })],
    });
    expect(state.session.dispatches.dispatch?.status).toBe("applied");
    expect(state.session.roster.main?.status).toBe("idle");
    expect(agentBusy(state.session, "main")).toBe(false);
  },
);

test("refresh keeps a newly started log turn busy when the parallel detail still says idle", async () => {
  const state = await restoreWithEarlierDetail(detail(4, "idle"), prefix);
  expect(state.loading).toBe(false);
  expect(state.session.cursor).toBe(5);
  expect(visibleTimeline(state.session, "main").find((item) => item.kind === "turn")).toMatchObject(
    { status: "running" },
  );
  expect(state.session.roster.main?.status).toBe("running");
  expect(agentBusy(state.session, "main")).toBe(true);
});

test("refresh does not retain blocked status after replaying an answered question beyond the detail", async () => {
  const records = [
    ...prefix,
    record(6, "question.asked", { questionId: "question", questionType: "text", spec: {} }),
    record(7, "question.answered", { questionId: "question", answer: "继续" }),
  ];
  const state = await restoreWithEarlierDetail(detail(6, "blocked"), records);
  expect(state.session.cursor).toBe(7);
  expect(state.session.questions.question).toMatchObject({ status: "answered", answer: "继续" });
  expect(state.session.dispatches.dispatch?.status).toBe("applied");
  expect(state.session.roster.main?.status).toBe("running");
});

test("a newer detail can seed current status while older history waits for catch-up", async () => {
  const logResponse = deferred<{ items: LogRecord[] }>();
  const detailResponse = deferred<ReturnType<typeof detail>>();
  network.getSessionLog.mockReturnValueOnce(logResponse.promise);
  network.getSession.mockReturnValueOnce(detailResponse.promise);
  const restoring = loadChatSession("refresh-session");
  logResponse.resolve({ items: prefix });
  detailResponse.resolve(detail(6, "blocked"));
  await restoring;
  const state = useChatStore.getState();
  expect(state.loading).toBe(true);
  expect(state.headCursor).toBe(6);
  expect(state.session.cursor).toBe(5);
  expect(state.session.roster.main?.status).toBe("blocked");
  const asked = record(6, "question.asked", {
    questionId: "question",
    questionType: "text",
    spec: {},
  });
  network.receive?.({ type: "rec", topic: "session:refresh-session", seq: 6, record: asked });
  expect(useChatStore.getState().loading).toBe(false);
  expect(useChatStore.getState().session.questions.question?.status).toBe("pending");
});

test("partial history only overrides snapshot fields changed after its head, per agent", async () => {
  const snapshot = detail(104, "running");
  snapshot.agents.push(
    { ...snapshot.agents[0], id: "worker", name: "Worker", status: "blocked" },
    { ...snapshot.agents[0], id: "absent", name: "Absent", status: "running" },
  );
  const state = await restoreWithEarlierDetail(snapshot, [
    record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
    record(101, "turn.started", { turnId: "turn" }),
    // The worker's question was asked before this window. Metadata alone cannot infer its status.
    record(102, "agent.updated", { modelProfileId: null }, "worker"),
    record(103, "model.output", { stepId: "step", text: "工作中" }),
    record(104, "step.started", { stepId: "step" }),
    record(105, "agent.updated", { modelProfileId: null }, "worker"),
    record(106, "turn.completed", { turnId: "turn" }),
    record(107, "agent.updated", { modelProfileId: "new-profile" }),
  ]);
  expect(state.hasOlder).toBe(true);
  expect(state.session.roster.main).toMatchObject({
    status: "idle",
    modelProfileId: "new-profile",
  });
  expect(state.session.roster.worker).toMatchObject({
    name: "Worker",
    status: "blocked",
    modelProfileId: null,
  });
  expect(state.session.roster.absent).toMatchObject({ name: "Absent", status: "running" });
});

test("a snapshot at the log head remains authoritative when partial history has no current status", async () => {
  const snapshot = detail(102, "running");
  snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
  const state = await restoreWithEarlierDetail(snapshot, [
    record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
    record(101, "turn.started", { turnId: "turn" }),
    record(102, "model.output", { stepId: "step", text: "工作中" }),
  ]);
  expect(state.session.roster.worker?.status).toBe("blocked");
  expect(state.loading).toBe(false);
});

test.each([
  ["question.answered", { questionId: "outside-window", answer: "继续" }],
  ["approval.decided", { approvalId: "outside-window", decision: "approved" }],
])(
  "%s resumes a blocked agent even when its request precedes the history window",
  async (type, data) => {
    const snapshot = detail(104, "running");
    snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
    snapshot.pendingInteractions = [
      pending("outside-window", type === "question.answered" ? "question" : "approval"),
    ];
    const state = await restoreWithEarlierDetail(snapshot, [
      record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
      record(101, "turn.started", { turnId: "turn" }),
      // There is no record at headSeq in the retained window; the worker's request is older still.
      record(105, type, data, "worker"),
      record(106, "turn.completed", { turnId: "turn" }),
    ]);
    expect(state.session.roster.worker?.status).toBe("running");
    expect(state.session.roster.main?.status).toBe("idle");
    expect(state.session.questions).toEqual({});
    expect(state.session.approvals).toEqual({});
  },
);

test.each(["closed", "paused"])(
  "a %s snapshot is not regressed by an asynchronous turn interruption",
  async (status) => {
    const state = await restoreWithEarlierDetail(detail(6, status), [
      ...prefix,
      record(6, "agent.status", { status }),
      record(7, "turn.interrupted", { turnId: "turn" }),
    ]);
    expect(state.session.roster.main?.status).toBe(status);
    expect(
      visibleTimeline(state.session, "main").find((item) => item.kind === "turn"),
    ).toMatchObject({ status: "interrupted" });
  },
);

test("a paused snapshot can resume explicitly before a newer turn starts", async () => {
  const state = await restoreWithEarlierDetail(detail(6, "paused"), [
    ...prefix,
    record(6, "agent.status", { status: "paused" }),
    record(7, "agent.status", { status: "idle" }),
    record(8, "turn.started", { turnId: "resumed" }),
  ]);
  expect(state.session.roster.main?.status).toBe("running");
});

test.each([
  ["question.answered", { questionId: "outside-window", answer: "继续" }, "paused"],
  ["approval.decided", { approvalId: "outside-window", decision: "approved" }, "closed"],
])("%s without a loaded request does not resume a %s agent", async (type, data, status) => {
  const snapshot = detail(5, status);
  snapshot.pendingInteractions = [
    pending("outside-window", type === "question.answered" ? "question" : "approval", "main"),
  ];
  const state = await restoreWithEarlierDetail(snapshot, [...prefix, record(6, type, data)]);
  expect(state.session.roster.main?.status).toBe(status);
  expect(state.session.questions).toEqual({});
  expect(state.session.approvals).toEqual({});
});

test("a newer snapshot retains interaction identity for a later live answer outside the history window", async () => {
  const snapshot = detail(106, "running");
  snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
  snapshot.pendingInteractions = [pending("outside-window", "question")];
  network.getSession.mockResolvedValueOnce(snapshot);
  network.getSessionLog.mockResolvedValueOnce({
    items: [
      record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
      record(101, "turn.started", { turnId: "turn" }),
      record(105, "step.started", { stepId: "step" }),
    ],
  });
  await loadChatSession("refresh-session");
  expect(useChatStore.getState().loading).toBe(true);
  for (const rec of [
    record(106, "model.output", { stepId: "step", text: "工作中" }),
    record(107, "question.answered", { questionId: "outside-window", answer: "继续" }, "worker"),
  ])
    network.receive?.({ type: "rec", topic: "session:refresh-session", seq: rec.seq, record: rec });
  expect(useChatStore.getState().loading).toBe(false);
  expect(useChatStore.getState().session.roster.worker?.status).toBe("running");
  expect(useChatStore.getState().session.questions).toEqual({});
});

test.each(["snapshot", "later log"])(
  "answering one missing request does not clear another pending request from %s",
  async (source) => {
    const snapshot = detail(104, "running");
    snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
    snapshot.pendingInteractions = [pending("outside-window", "question")];
    if (source === "snapshot") snapshot.pendingInteractions.push(pending("other", "approval"));
    const state = await restoreWithEarlierDetail(snapshot, [
      record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
      record(101, "turn.started", { turnId: "turn" }),
      ...(source === "later log"
        ? [
            record(
              105,
              "question.asked",
              { questionId: "other", questionType: "text", spec: {} },
              "worker",
            ),
          ]
        : []),
      record(106, "question.answered", { questionId: "outside-window", answer: "继续" }, "worker"),
    ]);
    expect(state.session.roster.worker?.status).toBe("blocked");
    expect(state.session.roster.main?.status).toBe("running");
    expect(state.session.questions["outside-window"]).toBeUndefined();
  },
);

test("an unrelated agent or interaction kind cannot release a snapshot's blocked agent", async () => {
  const snapshot = detail(104, "running");
  snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
  snapshot.pendingInteractions = [pending("outside-window", "approval")];
  const state = await restoreWithEarlierDetail(snapshot, [
    record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
    record(101, "turn.started", { turnId: "turn" }),
    record(105, "approval.decided", { approvalId: "outside-window", decision: "approved" }),
    record(106, "question.answered", { questionId: "outside-window", answer: "继续" }, "worker"),
  ]);
  expect(state.session.roster.worker?.status).toBe("blocked");
  expect(state.session.roster.main?.status).toBe("running");
});

test("an answer without snapshot identity conservatively retains an unknown block", async () => {
  const state = await restoreWithEarlierDetail(detail(5, "blocked"), [
    ...prefix,
    record(6, "question.answered", { questionId: "unknown", answer: "继续" }),
  ]);
  expect(state.session.roster.main?.status).toBe("blocked");
});

test("older-history loading preserves current pending identities without resurrecting settled ones", async () => {
  const snapshot = detail(105, "running");
  snapshot.agents.push({ ...snapshot.agents[0], id: "worker", status: "blocked" });
  snapshot.pendingInteractions = [pending("outside-window", "question")];
  await restoreWithEarlierDetail(snapshot, [
    record(100, "user.message", { dispatchId: "dispatch", text: "任务" }),
    record(101, "turn.started", { turnId: "turn" }),
    record(105, "step.started", { stepId: "step" }),
  ]);
  network.getSessionLog.mockResolvedValueOnce({
    items: [
      record(80, "user.message", { dispatchId: "older", text: "此前任务" }),
      record(81, "turn.started", { turnId: "older-turn" }),
      record(90, "turn.completed", { turnId: "older-turn" }),
    ],
  });
  await loadOlderChat();
  expect(useChatStore.getState().session.pendingInteractions).toEqual(snapshot.pendingInteractions);
  expect(useChatStore.getState().session.questions["outside-window"]).toBeUndefined();
  const answered = record(
    106,
    "question.answered",
    { questionId: "outside-window", answer: "继续" },
    "worker",
  );
  network.receive?.({ type: "rec", topic: "session:refresh-session", seq: 106, record: answered });
  expect(useChatStore.getState().session.pendingInteractions).toEqual([]);
  expect(useChatStore.getState().session.roster.worker?.status).toBe("running");
  network.getSessionLog.mockResolvedValueOnce({
    items: [
      record(1, "session.created", { title: "刷新恢复" }),
      record(
        50,
        "question.asked",
        { questionId: "outside-window", questionType: "text", spec: {} },
        "worker",
      ),
    ],
  });
  await loadOlderChat();
  expect(useChatStore.getState().session.pendingInteractions).toEqual([]);
  expect(useChatStore.getState().session.questions["outside-window"]?.status).toBe("answered");
  expect(useChatStore.getState().session.roster.worker?.status).toBe("running");
});

test("a repeated answer for an old question cannot clear a newer known question", async () => {
  const state = await restoreWithEarlierDetail(detail(5, "running"), [
    ...prefix,
    record(6, "question.asked", { questionId: "old", questionType: "text", spec: {} }),
    record(7, "question.answered", { questionId: "old", answer: "继续" }),
    record(8, "question.asked", { questionId: "new", questionType: "text", spec: {} }),
    record(9, "question.answered", { questionId: "old", answer: "继续" }),
  ]);
  expect(state.session.roster.main?.status).toBe("blocked");
  expect(state.session.questions.new?.status).toBe("pending");
});

test("a late previous-session load cannot restore its old pending identities", async () => {
  const oldLog = deferred<{ items: LogRecord[] }>();
  const oldDetail = detail(5, "blocked");
  oldDetail.pendingInteractions = [pending("old-question", "question", "main")];
  network.getSession.mockResolvedValueOnce(oldDetail);
  network.getSessionLog.mockReturnValueOnce(oldLog.promise);
  const oldLoad = loadChatSession("old-session");
  await vi.waitFor(() => expect(network.getSessionLog).toHaveBeenCalledTimes(1));
  const nextDetail = detail(5, "running");
  nextDetail.session.workspaceId = "new-workspace";
  network.getSession.mockResolvedValueOnce(nextDetail);
  network.getSessionLog.mockResolvedValueOnce({ items: prefix });
  await loadChatSession("new-session");
  oldLog.resolve({ items: prefix });
  await oldLoad;
  expect(useChatStore.getState()).toMatchObject({
    sessionId: "new-session",
    workspaceId: "new-workspace",
  });
  expect(useChatStore.getState().session.pendingInteractions).toBeUndefined();
  expect(useChatStore.getState().session.roster.main?.status).toBe("running");
});
