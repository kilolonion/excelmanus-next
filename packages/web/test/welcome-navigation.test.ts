import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clicks: [] as Array<() => Promise<void>>,
  state: {
    sessionId: "old" as string | null,
    workspaceId: "old-workspace" as string | null,
    viewAgentId: "main",
    attachments: [] as Array<{ id: string; status: string }>,
  },
  addComposerFiles: vi.fn(),
  uploadFiles: vi.fn(),
  attachWorkspaceFile: vi.fn(),
  openWorkbook: vi.fn(),
}));
vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    motion: {
      div: box,
      section: box,
      button: ({ children, onClick }: { children: ReactNode; onClick: () => Promise<void> }) => {
        mocks.clicks.push(onClick);
        return createElement("button", null, children);
      },
    },
  };
});
vi.mock("../src/components/welcome/WorkbookStart", () => ({ WorkbookStart: () => null }));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: () => mocks.state },
  addComposerFiles: mocks.addComposerFiles,
  attachWorkspaceFile: mocks.attachWorkspaceFile,
}));
vi.mock("@/stores/files-store", () => ({
  uploadFiles: mocks.uploadFiles,
  useFilesStore: { getState: () => ({ workspaceId: mocks.state.workspaceId }) },
}));
vi.mock("@/stores/workbook-store", () => ({ openWorkbook: mocks.openWorkbook }));

import { WelcomePage } from "../src/components/welcome/WelcomePage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clicks.length = 0;
  mocks.state = {
    sessionId: "old",
    workspaceId: "old-workspace",
    viewAgentId: "main",
    attachments: [],
  };
  mocks.openWorkbook.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

function clickFirstSample() {
  const click = mocks.clicks[0];
  if (!click) throw new Error("sample button was not rendered");
  return click();
}

test("a delayed homepage sample download cannot add files or a suggestion to a newer conversation", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  mocks.clicks.length = 0;
  mocks.addComposerFiles.mockResolvedValue([]);
  const suggest = vi.fn();
  renderToString(createElement(WelcomePage, { onSuggestionClick: suggest }));
  const pending = clickFirstSample();
  mocks.state = { ...mocks.state, sessionId: "new", workspaceId: "new-workspace" };
  finish(new Response("item,value\na,1", { headers: { "Content-Type": "text/csv" } }));
  await pending;
  expect(mocks.addComposerFiles).not.toHaveBeenCalled();
  expect(suggest).not.toHaveBeenCalled();
});

test("switching during sample attachment upload cannot auto-open its result on the new view", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a,b")));
  let finish!: (paths: string[]) => void;
  mocks.addComposerFiles.mockImplementationOnce(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const suggest = vi.fn();
  renderToString(createElement(WelcomePage, { onSuggestionClick: suggest }));
  const pending = clickFirstSample();
  await vi.waitFor(() => expect(mocks.addComposerFiles).toHaveBeenCalledTimes(1));
  mocks.state = { ...mocks.state, sessionId: "new", workspaceId: "new-workspace" };
  finish(["sample.csv"]);
  await pending;
  expect(mocks.openWorkbook).not.toHaveBeenCalled();
  expect(suggest).not.toHaveBeenCalled();
});

test("blank home upload completion cannot attach old workspace paths to a new conversation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a,b")));
  mocks.state.sessionId = null;
  mocks.state.workspaceId = null;
  let finish!: (paths: string[]) => void;
  mocks.uploadFiles.mockImplementationOnce(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const suggest = vi.fn();
  renderToString(createElement(WelcomePage, { onSuggestionClick: suggest }));
  const pending = clickFirstSample();
  await vi.waitFor(() => expect(mocks.uploadFiles).toHaveBeenCalledTimes(1));
  mocks.state = { ...mocks.state, sessionId: "new", workspaceId: "new-workspace" };
  finish(["sample.csv"]);
  await pending;
  expect(mocks.attachWorkspaceFile).not.toHaveBeenCalled();
  expect(mocks.openWorkbook).not.toHaveBeenCalled();
});

test("an uninterrupted sample still prepares attachments, opens its sheet and fills the suggestion", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a,b")));
  mocks.addComposerFiles.mockImplementationOnce(async () => {
    mocks.state = { ...mocks.state, attachments: [{ id: "sample", status: "ready" }] };
    return ["sample.csv"];
  });
  const suggest = vi.fn();
  renderToString(createElement(WelcomePage, { onSuggestionClick: suggest }));
  await clickFirstSample();
  expect(mocks.openWorkbook).toHaveBeenCalledWith("sample.csv");
  expect(suggest).toHaveBeenCalledWith(expect.stringContaining("月度销售"));
});
