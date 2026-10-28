import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workspaces: [] as unknown[] }));
vi.mock("@/lib/backend/api", () => ({
  api: vi.fn(),
  desktop: () => null,
  errorMessage: (e: Error) => e.message,
  saveBlob: vi.fn(),
}));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ workspaces: mocks.workspaces, dataDir: "/data" }),
  onAppEvent: vi.fn(),
  removeWorkspace: vi.fn(),
  setDefaultWorkspace: vi.fn(),
}));
vi.mock("@/components/sidebar/AddWorkspaceDialog", () => ({ AddWorkspaceDialog: () => null }));
vi.mock("@/components/settings/model/form-widgets", () => ({ GlassSelect: () => null }));

import { WorkspaceTab } from "../src/components/settings/WorkspaceTab";

test("backup first paint waits for the list instead of declaring no backups", () => {
  mocks.workspaces = [{ id: "ws", name: "Workspace", path: "/workspace", isDefault: true }];
  const html = renderToString(createElement(WorkspaceTab));
  expect(html).toContain("正在读取备份");
  expect(html).not.toContain("暂无备份");
});
test("no registered workspace still shows the workspace guidance", () => {
  mocks.workspaces = [];
  const html = renderToString(createElement(WorkspaceTab));
  expect(html).toContain("添加工作区后可在这里查看备份");
  expect(html).not.toContain("正在读取备份");
});
