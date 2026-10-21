import { expect, test, vi } from "vitest";
import { readAttachmentDraft, saveAttachmentDraft } from "../src/lib/attachment-drafts";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

test("attachment drafts preserve ready references without expired local preview URLs", () => {
  const s = storage();
  saveAttachmentDraft(s, "session/main", [
    { id: "a", name: "book.csv", size: 29, path: "book.csv", status: "ready" },
    {
      id: "b",
      name: "image.png",
      size: 12,
      previewUrl: "blob:expired",
      status: "ready",
      ref: { sha256: "a".repeat(64), name: "image.png", size: 12, mediaType: "image/png" },
    },
    { id: "c", name: "pending.png", size: 10, status: "uploading" },
  ]);
  const draft = readAttachmentDraft(s, "session/main");
  expect(draft).toHaveLength(3);
  expect(draft[0]).toMatchObject({ path: "book.csv", status: "ready" });
  expect(draft[1]).toHaveProperty("ref.sha256", "a".repeat(64));
  expect(draft[1]).not.toHaveProperty("previewUrl");
  expect([...s.data.values()].join()).not.toContain("blob:expired");
  expect(readAttachmentDraft(s, "other/main")).toEqual([]);
});

test("removing or sending clears the saved draft and storage failures do not break editing", () => {
  const s = storage();
  saveAttachmentDraft(s, "session/main", [
    { id: "a", name: "book.csv", size: 1, path: "book.csv", status: "ready" },
  ]);
  saveAttachmentDraft(s, "session/main", []);
  expect(readAttachmentDraft(s, "session/main")).toEqual([]);
  const unavailable = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  expect(readAttachmentDraft(unavailable, "session/main")).toEqual([]);
  expect(() => saveAttachmentDraft(unavailable, "session/main", [])).not.toThrow();
});

test("switching agents keeps their attachment drafts separate and removal stays removed", async () => {
  const { useChatStore, attachWorkspaceFile, setViewAgent, removeComposerAttachment } =
    await import("../src/stores/chat-store");
  const previous = useChatStore.getState();
  useChatStore.setState({
    sessionId: "draft-agent-test",
    workspaceId: "workspace",
    viewAgentId: "main",
    attachments: [],
  });
  try {
    attachWorkspaceFile("only-main.csv", 29);
    setViewAgent("child");
    expect(useChatStore.getState().attachments).toEqual([]);
    attachWorkspaceFile("only-child.csv", 12);
    setViewAgent("main");
    expect(useChatStore.getState().attachments.map((item) => item.path)).toEqual(["only-main.csv"]);
    removeComposerAttachment(useChatStore.getState().attachments[0]!.id);
    setViewAgent("child");
    setViewAgent("main");
    expect(useChatStore.getState().attachments).toEqual([]);
  } finally {
    useChatStore.setState(previous);
  }
});

test("a late upload finishes in its original agent draft, not the newly selected agent", async () => {
  const backend = await import("../src/lib/backend/api");
  const chat = await import("../src/stores/chat-store");
  let finish!: (value: { path: string }) => void;
  const pending = new Promise<{ path: string }>((resolve) => {
    finish = resolve;
  });
  const mock = vi
    .spyOn(backend, "api")
    .mockReturnValue({ uploadFile: () => pending } as unknown as ReturnType<typeof backend.api>);
  const previous = chat.useChatStore.getState();
  chat.useChatStore.setState({
    sessionId: "draft-upload-race",
    workspaceId: "workspace",
    viewAgentId: "main",
    attachments: [],
  });
  try {
    const upload = chat.addComposerFiles([new File(["test"], "late.csv", { type: "text/csv" })]);
    chat.setViewAgent("child");
    finish({ path: "late.csv" });
    await upload;
    expect(chat.useChatStore.getState().attachments).toEqual([]);
    chat.setViewAgent("main");
    expect(chat.useChatStore.getState().attachments[0]).toMatchObject({
      path: "late.csv",
      status: "ready",
    });
  } finally {
    mock.mockRestore();
    chat.useChatStore.setState(previous);
  }
});

test("a completed send clears only its original draft after the user switches agents", async () => {
  const backend = await import("../src/lib/backend/api");
  const chat = await import("../src/stores/chat-store");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mock = vi
    .spyOn(backend, "api")
    .mockReturnValue({ sendMessage: () => pending } as unknown as ReturnType<typeof backend.api>);
  const previous = chat.useChatStore.getState();
  chat.useChatStore.setState({
    sessionId: "draft-send-race",
    workspaceId: "workspace",
    viewAgentId: "main",
    attachments: [],
    optimistic: [],
  });
  try {
    chat.attachWorkspaceFile("sent.csv", 3);
    const send = chat.sendMessage({ text: "read only" });
    chat.setViewAgent("child");
    chat.attachWorkspaceFile("keep.csv", 4);
    finish();
    expect(await send).toBe(true);
    expect(chat.useChatStore.getState().attachments.map((item) => item.path)).toEqual(["keep.csv"]);
    chat.setViewAgent("main");
    expect(chat.useChatStore.getState().attachments).toEqual([]);
  } finally {
    mock.mockRestore();
    chat.useChatStore.setState(previous);
  }
});

test("interrupted uploads keep metadata after reopening but never pretend the original file is recovered", () => {
  const s = storage();
  saveAttachmentDraft(s, "session/main", [
    { id: "pending", name: "unfinished.csv", size: 13, status: "uploading", canRetry: true },
  ]);
  const draft = readAttachmentDraft(s, "session/main");
  expect(draft).toHaveLength(1);
  expect(draft[0]).toMatchObject({ status: "error", canRetry: false, name: "unfinished.csv" });
});

test("saving one tab merges other tab attachments and only removes known entries", async () => {
  const { mergeAttachmentDraft } = await import("../src/lib/attachment-drafts");
  const a = { id: "a", name: "a.csv", size: 1, status: "ready" as const, path: "a.csv" };
  const b = { id: "b", name: "b.csv", size: 1, status: "ready" as const, path: "b.csv" };
  expect(mergeAttachmentDraft([a, b], [a], [])).toEqual([b]);
  expect(mergeAttachmentDraft([a, b], [a], [a])).toEqual([a, b]);
});
