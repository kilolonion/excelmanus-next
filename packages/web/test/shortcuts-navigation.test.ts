import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  state: {
    workspaceView: "files",
    layout: { chatCollapsed: false, tableCollapsed: false },
    doc: null,
  },
  setState: vi.fn(),
  createSession: vi.fn(async () => {}),
}));
vi.mock("../src/api.ts", () => ({ desktop: () => null }));
vi.mock("../src/components/ui/overlay.tsx", () => ({ toast: vi.fn() }));
vi.mock("../src/store.ts", () => ({
  useApp: { getState: () => store.state, setState: store.setState },
  createSession: store.createSession,
  setLayout: vi.fn(),
  setNarrowTab: vi.fn(),
  setSettingsOpen: vi.fn(),
  stopAgent: vi.fn(),
}));
const { runShortcut } = await import("../src/shortcuts.ts");
describe("跨页面快捷键", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });
  test.each(["focus-composer", "focus-chat", "focus-workbench"] as const)(
    "%s 先返回真正的工作台再尝试聚焦",
    (action) => {
      runShortcut(action);
      expect(store.setState).toHaveBeenCalledWith({ workspaceView: "workbench" });
      expect(requestAnimationFrame).toHaveBeenCalledOnce();
    },
  );
  test("新会话成功后切回工作台", async () => {
    runShortcut("new-session");
    await vi.waitFor(() =>
      expect(store.setState).toHaveBeenCalledWith({ workspaceView: "workbench" }),
    );
  });
});
