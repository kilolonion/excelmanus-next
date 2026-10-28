import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  download: vi.fn(),
  render: vi.fn(),
  effects: [] as Array<() => undefined | (() => void)>,
  stateIndex: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => [mocks.stateIndex++ === 0 ? true : initial, vi.fn()],
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
    Button: ({ children }: { children: ReactNode }) => createElement("button", null, children),
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
function mount() {
  renderToString(
    createElement(BackupPreviewButton, {
      workspaceId: "ws",
      entry: {
        id: "backup",
        kind: "backup",
        originalPath: "a.xlsx",
        createdAt: "2026-10-17T00:00:00Z",
        size: 100,
        sessionId: "ses",
      },
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
  mocks.stateIndex = 0;
  vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });
  mocks.render.mockResolvedValue("png");
});
afterEach(() => vi.unstubAllGlobals());

test.each(["spreadsheet", "image"])(
  "closing before %s preview arrives stops follow-on rendering or download",
  async (kind) => {
    let resolve!: (value: unknown) => void;
    mocks.preview.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const close = mount();
    close();
    resolve({ kind, layout: {} });
    await flush();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  },
);

test("closing while fonts load stops the obsolete spreadsheet render", async () => {
  let resolveFonts!: () => void;
  vi.stubGlobal("document", {
    fonts: {
      ready: new Promise<void>((yes) => {
        resolveFonts = yes;
      }),
    },
  });
  mocks.preview.mockResolvedValueOnce({ kind: "spreadsheet", layout: {} });
  const close = mount();
  await flush();
  close();
  resolveFonts();
  await flush();
  expect(mocks.render).not.toHaveBeenCalled();
});

test("an active spreadsheet preview still renders normally", async () => {
  mocks.preview.mockResolvedValueOnce({ kind: "spreadsheet", layout: { marker: "current" } });
  const close = mount();
  await flush();
  expect(mocks.render).toHaveBeenCalledWith({ marker: "current" }, 1, expect.any(Function));
  const isCurrent = mocks.render.mock.lastCall?.[2] as () => boolean;
  expect(isCurrent()).toBe(true);
  close();
  expect(isCurrent()).toBe(false);
});
