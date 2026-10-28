import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  doc: { rev: 1, snapshot: { sheets: { s: { name: "Data" } } } },
  draftConflict: null,
  recoveredDrafts: [
    { sheetId: "s", row: 0, col: 0, text: "draft", baseRev: 1, source: "window:recovery" },
  ],
}));
vi.mock("@/stores/workbook-store", async (original) => ({
  ...(await original<typeof import("../src/stores/workbook-store")>()),
  useWorkbookStore: (select: (s: typeof store) => unknown) => select(store),
}));

import { ThreadedCommentsPanel } from "../src/components/excel/ThreadedCommentsPanel";
import { DraftConflictBar } from "../src/components/excel/WorkbookBars";

test("comment display reads sheet metadata without serializing unrelated cell data", () => {
  const comment = {
    id: "{11111111-1111-4111-8111-111111111111}",
    personId: "{22222222-2222-4222-8222-222222222222}",
    ref: "A1",
    text: "First",
    author: "QA",
    done: false,
  };
  const data = {
    name: "Data",
    custom: { excelmanusObjects: { charts: [], images: [], threadedComments: [comment] } },
  };
  const save = vi.fn(() => ({ sheetOrder: ["s"], sheets: { s: data } }));
  const api = {
    wb: {
      save,
      getSheets: () => [{ getSheetId: () => "s", getSheet: () => ({ getSnapshot: () => data }) }],
    },
  };
  const render = () =>
    renderToString(
      createElement(ThreadedCommentsPanel, { api, onClose() {} } as unknown as Parameters<
        typeof ThreadedCommentsPanel
      >[0]),
    );
  expect(render()).toContain("First");
  comment.text = "Updated";
  data.name = "Renamed";
  store.doc.rev++;
  expect(render()).toContain("Updated");
  expect(render()).toContain("Renamed");
  expect(save).not.toHaveBeenCalled();
});

test("recovered draft reads the current cell without a complete workbook save", () => {
  const data = { cellData: { 0: { 0: { v: "Current" } } } };
  const save = vi.fn(() => ({ sheets: { s: data } }));
  const api = {
    wb: { save, getSheetBySheetId: () => ({ getSheet: () => ({ getSnapshot: () => data }) }) },
  };
  const render = () =>
    renderToString(
      createElement(DraftConflictBar, { api } as unknown as Parameters<typeof DraftConflictBar>[0]),
    );
  expect(render()).toContain("Current");
  data.cellData[0][0].v = "Latest";
  expect(render()).toContain("Latest");
  expect(save).not.toHaveBeenCalled();
});
