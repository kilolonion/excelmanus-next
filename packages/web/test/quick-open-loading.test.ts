import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listAllFiles: vi.fn() }));
vi.mock("@/stores/files-store", () => ({ listAllFiles: mocks.listAllFiles }));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));

vi.mock("radix-ui", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { Dialog: { Root: box, Portal: box, Overlay: box, Content: box, Title: box } };
});
vi.mock("@/lib/shortcuts", () => ({ isMac: () => false, runShortcut: vi.fn() }));
vi.mock("@/lib/theme", () => ({ isDarkTheme: () => false, setTheme: vi.fn() }));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: (s: unknown) => unknown) => select({ quickOpen: true, setQuickOpen: vi.fn() }),
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: unknown) => unknown) => select({ session: { roster: {} } }),
}));
vi.mock("@/stores/session-store", () => ({
  selectSession: vi.fn(),
  useSessionStore: (select: (s: unknown) => unknown) => select({ sessions: [], activeSessionId: null }),
}));

import { QuickOpen, readQuickOpenFiles } from "../src/components/command/QuickOpen";

test("quick open distinguishes a failed file search from an empty directory and allows retry", async () => {
  mocks.listAllFiles.mockRejectedValueOnce(new Error("读取目录失败"));
  expect(await readQuickOpenFiles()).toEqual({ files: [], error: "读取目录失败" });
  const files = [{ name: "report.xlsx", path: "report.xlsx", kind: "file" }];
  mocks.listAllFiles.mockResolvedValueOnce(files);
  expect(await readQuickOpenFiles()).toEqual({ files, error: null });
});

test("a genuine empty directory remains a successful quick-open result", async () => {
  mocks.listAllFiles.mockResolvedValueOnce([]);
  expect(await readQuickOpenFiles()).toEqual({ files: [], error: null });
});

test("quick open shows file loading without hiding available commands", () => {
  const html = renderToString(createElement(QuickOpen));
  expect(html).toContain("正在读取文件列表");
  expect(html).toContain("新对话");
  expect(html).not.toContain("没有匹配");
});
