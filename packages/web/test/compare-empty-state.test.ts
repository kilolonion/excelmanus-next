import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ compare: { left: "same.xlsx", right: "same.xlsx" } }));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: (s: unknown) => unknown) =>
    select({ compare: state.compare, closeCompare: vi.fn() }),
}));
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (select: (s: unknown) => unknown) => select({ version: 0 }),
  listAllFiles: vi.fn(),
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: unknown) => unknown) => select({ workspaceId: "ws" }),
}));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));
vi.mock("@/components/ui/overlay-card", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { OverlayCard: box, OverlayCardBody: box, OverlayCardHeader: () => null };
});
vi.mock("@/components/settings/model/form-widgets", () => ({ GlassSelect: () => null }));

import { CompareDialog } from "../src/components/excel/CompareDialog";

test("choosing the same workbook explains how to recover instead of showing a blank result", () => {
  state.compare = { left: "same.xlsx", right: "same.xlsx" };
  expect(renderToString(createElement(CompareDialog))).toContain("请选择两份不同的表格");
});

test("an unselected right workbook still shows the initial selection hint", () => {
  state.compare = { left: "same.xlsx", right: "" };
  expect(renderToString(createElement(CompareDialog))).toContain("选择右侧的表格后开始对比");
});

test("comparison lists show an explicit loading state before their first response", () => {
  state.compare = { left: "same.xlsx", right: "" };
  expect(renderToString(createElement(CompareDialog))).toContain("正在读取工作区表格");
});
