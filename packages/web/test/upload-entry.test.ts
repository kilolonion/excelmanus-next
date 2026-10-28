import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ensureActiveSession: vi.fn() }));
vi.mock("@/stores/session-store", () => mocks);
vi.mock("@/lib/backend/api", () => ({ api: () => ({}), errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

import { useChatUpload } from "../src/components/chat/use-chat-upload";
import { useChatStore } from "../src/stores/chat-store";

function entry() {
  let upload!: ReturnType<typeof useChatUpload>;
  function Probe() {
    upload = useChatUpload();
    return null;
  }
  renderToString(createElement(Probe));
  return upload;
}

beforeEach(() => {
  vi.resetAllMocks();
  useChatStore.setState({
    sessionId: null,
    workspaceId: null,
    viewAgentId: "main",
    loading: false,
    loadError: null,
    notice: null,
    attachments: [],
  });
});

test.each([
  { sessionId: "new-session", workspaceId: "new-workspace", viewAgentId: "main" },
  { sessionId: null, workspaceId: null, viewAgentId: "child-agent" },
])("failed implicit upload session does not put an old error on a newer view: %j", async (next) => {
  let reject!: (error: Error) => void;
  mocks.ensureActiveSession.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  entry().addFiles([new File(["sample"], "sample.txt")]);
  useChatStore.setState(next);
  reject(new Error("已切换对话，请在当前对话重新操作"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useChatStore.getState().notice).toBeNull();
  expect(useChatStore.getState().attachments).toEqual([]);
});

test("implicit session failure still explains the error on the original view", async () => {
  mocks.ensureActiveSession.mockRejectedValueOnce(new Error("创建失败"));
  entry().attachWorkspaceFiles([{ path: "sample.xlsx", filename: "sample.xlsx" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useChatStore.getState().notice?.text).toBe("创建失败");
});
