import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listFileBackups: vi.fn(),
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => [
      initial,
      (next: unknown) => {
        mocks.updates.push(next);
      },
    ],
  };
});
vi.mock("@/components/sidebar/file-actions", () => ({
  listFileBackups: mocks.listFileBackups,
  deleteBackupWithConfirm: vi.fn(),
  restoreBackupWithConfirm: vi.fn(),
  saveBackupAs: vi.fn(),
}));
vi.mock("@/components/sidebar/session-file-marks", () => ({
  useSessionFileMarks: () => new Map(),
  SESSION_MARK_LABEL: {},
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({ workspaceId: "ws" }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ activeWorkspaceId: "ws", sessions: [] }),
  selectSession: vi.fn(),
}));
vi.mock("@/components/ui/overlay-card", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { OverlayCard: box, OverlayCardBody: box, OverlayCardHeader: () => null };
});
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ fileHistory: async () => ({ events: [] }) }),
  errorMessage: (e: Error) => e.message,
}));

import { FileInfoDialog } from "../src/components/sidebar/FileInfoDialog";

const backup = { id: "old-backup", originalPath: "old.xlsx" };
function mount() {
  renderToString(
    createElement(FileInfoDialog, {
      entry: { name: "old.xlsx", path: "old.xlsx", kind: "file" },
      onOpenChange: vi.fn(),
    }),
  );
  const cleanups = mocks.effects.map((run) => run());
  return () => {
    for (const cleanup of cleanups) cleanup?.();
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.updates = [];
});

test.each(["success", "failure"])(
  "closing or replacing file info ignores a late backup %s",
  async (result) => {
    let resolve!: (value: unknown[]) => void;
    let reject!: (error: Error) => void;
    mocks.listFileBackups.mockReturnValueOnce(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const cleanup = mount();
    cleanup();
    mocks.updates = [];
    if (result === "success") resolve([backup]);
    else reject(new Error("old backup read failed"));
    await new Promise((done) => setTimeout(done, 0));
    expect(mocks.updates).not.toContainEqual([backup]);
    expect(mocks.updates).not.toContain("old backup read failed");
  },
);

test("the current file info still receives its backup list", async () => {
  mocks.listFileBackups.mockResolvedValueOnce([backup]);
  mount();
  await new Promise((done) => setTimeout(done, 0));
  expect(mocks.updates).toContainEqual([backup]);
});
