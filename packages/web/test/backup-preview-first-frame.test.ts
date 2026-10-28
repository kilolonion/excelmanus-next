import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  download: vi.fn(),
  render: vi.fn(),
  effects: [] as Array<() => undefined | (() => void)>,
  stateIndex: 0,
  states: [] as unknown[],
  buttons: {} as Record<string, () => void>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => {
      const i = mocks.stateIndex++;
      if (!(i in mocks.states)) mocks.states[i] = i === 0 ? true : initial;
      return [
        mocks.states[i],
        (value: unknown) => {
          mocks.states[i] = typeof value === "function" ? value(mocks.states[i]) : value;
        },
      ];
    },
  };
});
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: box,
    DialogContent: box,
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogFooter: box,
  };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
      if (typeof children === "string" && onClick) mocks.buttons[children] = onClick;
      return createElement("button", null, children);
    },
  };
});
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ previewBackup: mocks.preview, downloadBackup: mocks.download }),
  errorMessage: (e: Error) => e.message,
  saveBlob: vi.fn(),
}));
vi.mock("@/lib/backend/render", () => ({ renderLayoutToPng: mocks.render }));

import { BackupPreviewButton } from "../src/components/files/BackupPreviewButton";

const flush = () => new Promise((done) => setTimeout(done, 0));
function render() {
  mocks.stateIndex = 0;
  mocks.effects = [];
  return renderToString(
    createElement(BackupPreviewButton, {
      workspaceId: "ws",
      entry: {
        id: "b",
        kind: "backup",
        originalPath: "book.xlsx",
        createdAt: "2026-10-17",
        size: 1,
        sessionId: "s",
      },
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.buttons = {};
  vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });
  mocks.render.mockResolvedValue("OLDPNG");
});
afterEach(() => vi.unstubAllGlobals());
test("changing backup pages shows loading before effects and suppresses the old image", async () => {
  mocks.preview.mockResolvedValue({
    kind: "spreadsheet",
    limitations: [],
    layout: {},
    sheetId: "s",
    range: "A1:B80",
    row: 0,
    column: 0,
    sheets: [{ id: "s", name: "Data", rows: 200, columns: 5 }],
  });
  render();
  const close = mocks.effects[0]?.();
  await flush();
  await flush();
  expect(render()).toContain("OLDPNG");
  mocks.buttons["下 80 行"]?.();
  const next = render();
  expect(next).toContain("正在读取备份");
  expect(next).not.toContain("OLDPNG");
  close?.();
});
