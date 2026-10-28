import { createApiClient, SendMessageBody } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const network = vi.hoisted(() => ({
  openDoc: vi.fn(),
  getDocSnapshot: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => network, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  onConnection: vi.fn(),
  sendSync: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
  syncConnectionId: vi.fn(),
}));
vi.mock("@/stores/files-store", () => ({ loadDir: vi.fn().mockResolvedValue([]) }));

import { WorkbookContextChip } from "../src/components/excel/WorkbookConversation";
import { askAgent } from "../src/lib/workbook/ask";
import { sendMessage, useChatStore } from "../src/stores/chat-store";
import * as workbook from "../src/stores/workbook-store";

const store = workbook.useWorkbookStore;
const original = { ...store.getInitialState() };
const requests: Record<string, unknown>[] = [];
test("image-only messages keep empty text and reject genuinely empty messages", async () => {
  const ref = {
    sha256: "a".repeat(64),
    mediaType: "image/png" as const,
    name: "test.png",
    size: 1,
  };
  expect(
    SendMessageBody.safeParse({ clientMessageId: "image", text: "", attachments: [ref] }).success,
  ).toBe(true);
  expect(SendMessageBody.safeParse({ clientMessageId: "empty", text: "  " }).success).toBe(false);
  useChatStore.setState({
    attachments: [{ id: "image", name: "test.png", size: 1, status: "ready", ref }],
  });
  expect(await sendMessage({ text: "" })).toBe(true);
  expect(requests.at(-1)).toMatchObject({ text: "", attachments: [ref] });
  expect(useChatStore.getState().attachments).toEqual([]);
});
const client = createApiClient("https://app.test", null, async (_url, init) => {
  requests.push(JSON.parse(String(init?.body)));
  return Response.json({
    dispatch: {
      id: "dispatch",
      sessionId: "session",
      agentId: "main",
      clientMessageId: "test",
      mode: "steer",
      status: "accepted",
    },
    deduplicated: false,
  });
});

function renderChip() {
  // React's server renderer reads the initial Zustand snapshot.
  Object.assign(store.getInitialState(), store.getState());
  return renderToStaticMarkup(createElement(WorkbookContextChip));
}

async function send() {
  expect(await sendMessage({ text: "检查选区", context: workbook.composerMessageContext() })).toBe(
    true,
  );
  return requests.at(-1);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  requests.length = 0;
  useChatStore.setState({
    sessionId: "session",
    workspaceId: "ws",
    attachments: [],
    optimistic: [],
  });
  store.setState({ ...original, workspaceId: "ws" });
  network.sendMessage.mockImplementation(client.sendMessage);
  network.openDoc.mockImplementation(async (_ws, { path }) => ({ document: { id: path } }));
  network.getDocSnapshot.mockImplementation(async (_ws, id) => ({
    document: { id, path: id, kind: "xlsx", rev: 3 },
    snapshot: { sheets: { s1: { name: "订单" } } },
  }));
  await workbook.openWorkbook("a.xlsx");
  workbook.setSelection("'订单'!A1:B3");
});

afterEach(() => {
  Object.assign(store.getInitialState(), original);
  store.setState(original);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("collapsed panel still shows exactly the context serialized in the message request", async () => {
  workbook.setPanelOpen(false);
  const html = renderChip();
  expect(html).toContain("本次附带");
  expect(html).toContain("a.xlsx");
  expect(html).toContain("A1:B3");
  expect((await send())?.context).toEqual([{ docId: "a.xlsx", rev: 3, range: "'订单'!A1:B3" }]);
  await workbook.focusRange("'订单'!A1:B3", { docId: "a.xlsx" });
  expect(store.getState().panelOpen).toBe(true);
});

test("pin survives switching documents and labels and locates the original workbook", async () => {
  workbook.pinSelection(true);
  await workbook.openWorkbook("b.xlsx");
  workbook.setSelection("'订单'!D1:D5");
  const html = renderChip();
  expect(html).toContain("a.xlsx");
  expect(html).not.toContain("b.xlsx");
  expect(html).toContain("已钉住");
  expect((await send())?.context).toEqual([{ docId: "a.xlsx", rev: 3, range: "'订单'!A1:B3" }]);
  const context = workbook.composerContext();
  if (!context) throw new Error("Expected pinned context");
  await workbook.focusRange(context.range, { docId: context.docId });
  expect(store.getState().doc?.docId).toBe("a.xlsx");
  expect(store.getState().rangeFocus?.range).toBe(context.range);
});

test("asking about the active table cannot transplant another workbook's pinned range", async () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  workbook.pinSelection(true);
  await workbook.openWorkbook("b.xlsx");
  workbook.setSelection("'订单'!D1:D5");
  askAgent("explain");
  expect((await send())?.context).toEqual([{ docId: "b.xlsx", rev: 3, range: "'订单'!D1:D5" }]);
  workbook.setSelection(null);
  askAgent("explain");
  expect((await send())?.context).toBeUndefined();
});

test("dismiss removes pending context without closing the file; repeated selection events do not reattach", async () => {
  workbook.pinSelection(true);
  workbook.dismissContext();
  workbook.setSelection("'订单'!A1:B3");
  expect(renderChip()).toContain("当前打开");
  expect(renderChip()).not.toContain("本次附带");
  expect((await send())?.context).toBeUndefined();
  expect(store.getState().doc?.path).toBe("a.xlsx");
  expect(store.getState().panelOpen).toBe(true);
  workbook.setSelection("'订单'!C1:C2");
  expect((await send())?.context).toEqual([{ docId: "a.xlsx", rev: 3, range: "'订单'!C1:C2" }]);
});

test("pinned reference follows file relocation and clears on conversation switch", async () => {
  workbook.pinSelection(true);
  await workbook.openWorkbook("b.xlsx");
  workbook.relocateWorkbook("a.xlsx", "归档/a-new.xlsx");
  expect(renderChip()).toContain("a-new.xlsx");
  useChatStore.setState({ sessionId: "other" });
  expect(workbook.composerContext()).toBeNull();
  expect((await send())?.context).toBeUndefined();
  expect(renderChip()).toContain("当前打开");
  expect(renderChip()).toContain("b.xlsx");
});

test("late send cleanup preserves a newly pinned selection", () => {
  workbook.pinRange("'订单'!A1");
  const sent = store.getState();
  workbook.pinRange("'订单'!B2");
  workbook.resetComposerContext(sent);
  expect(store.getState().pinnedSelection?.range).toBe("'订单'!B2");
});

test("late send cleanup preserves an explicit reference dismissal", () => {
  const sent = store.getState();
  workbook.dismissContext();
  workbook.resetComposerContext(sent);
  expect(store.getState().selectionDismissed).toBe(true);
});

test("send cleanup still consumes its unchanged pinned reference", () => {
  workbook.pinRange("'订单'!A1");
  const sent = store.getState();
  workbook.resetComposerContext(sent);
  expect(store.getState().pinnedSelection).toBeNull();
});
