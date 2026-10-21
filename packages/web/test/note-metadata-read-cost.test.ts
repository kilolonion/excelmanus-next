import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  refs: [] as unknown[],
  refIndex: 0,
  doc: { docId: "d", path: "qa.xlsx", rev: 1 },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: h.refs[h.refIndex++] }),
  useState: () => {
    const i = h.stateIndex++;
    return [
      h.states[i],
      (v: unknown) => {
        h.states[i] = v;
      },
    ];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/workbook/use-overlay-data", () => ({
  usePendingOverlay: () => ({ ranges: "", values: "" }),
  useDocActivity: () => [],
}));
vi.mock("@/stores/workbook-store", async (original) => ({
  ...(await original<typeof import("@/stores/workbook-store")>()),
  useWorkbookStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ doc: h.doc, selection: null }),
    { getState: () => ({ doc: h.doc }) },
  ),
}));
// This render-only test never mounts the canvas; the UI plugin constructs Path2D at import time.
vi.mock("@univerjs/sheets-data-validation-ui", () => ({
  UniverSheetsDataValidationUIPlugin: class {},
}));
vi.mock("../src/components/excel/FormatToolbar", () => ({ focusGrid: () => {} }));

import { UniverSheet } from "../src/components/excel/UniverSheet";

type Node = { props?: Record<string, any> };
function nodes(n: unknown): Node[] {
  if (!n || typeof n !== "object") return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  const node = n as Node;
  return [node, ...nodes(node.props?.children)];
}
function fixture() {
  const objects = {
    charts: [],
    images: [],
    notes: [
      { ref: "A1", text: "existing", author: "QA" },
      { ref: "B1", text: "other", author: "QA" },
    ],
  };
  const data = { custom: { excelmanusObjects: objects } };
  const sheet = {
    getSheetId: () => "s",
    getSheet: () => ({ getSnapshot: () => data }),
    getSelection: () => ({
      getActiveRange: () => ({ getRange: () => ({ startRow: 0, startColumn: 0 }) }),
    }),
    getRange: () => ({ getA1Notation: () => "A1" }),
  };
  const save = vi.fn(() => ({ sheets: { s: structuredClone(data) } }));
  const executeCommand = vi.fn(async () => true);
  const api = {
    univer: { __getInjector: () => ({ get: () => ({}) }) },
    univerAPI: { executeCommand },
    wb: {
      getId: () => "unit",
      getActiveSheet: () => sheet,
      getSheetBySheetId: () => sheet,
      endEditingAsync: async () => true,
      save,
    },
  };
  h.refs = [null, api, 0];
  const render = () => {
    h.refIndex = 0;
    h.stateIndex = 0;
    return UniverSheet({
      visibility: { activity: true, pending: true, changed: true },
      changes: [],
      onApi() {},
      onAsk() {},
      onReference() {},
    });
  };
  return { render, save, executeCommand, objects };
}
beforeEach(() => {
  h.states = [0, null, "s", false, null, null, []];
  h.stateIndex = 0;
  h.refIndex = 0;
  h.doc.rev = 1;
});
test("opening a cell note reads only the selected sheet metadata", async () => {
  const f = fixture();
  const menu = nodes(f.render()).find((n) => n.props?.onEdit);
  menu?.props?.onEdit("note.edit");
  await vi.waitFor(() =>
    expect(h.states[4]).toMatchObject({ text: "existing", author: "QA", ref: "A1" }),
  );
  expect(f.save).not.toHaveBeenCalled();
});
test("saving a note uses current isolated metadata without workbook serialization", async () => {
  const f = fixture();
  h.states[4] = {
    docId: "d",
    sheetId: "s",
    revision: 1,
    ref: "A1",
    text: "existing",
    author: "QA",
    exists: true,
  };
  const dialog = nodes(f.render()).find((n) => n.props?.onSave);
  expect(dialog).toBeDefined();
  await dialog?.props?.onSave("updated", "QA");
  expect(f.save).not.toHaveBeenCalled();
  const params = (
    f.executeCommand.mock.calls[0] as unknown as [string, { objects: typeof f.objects }]
  )[1];
  expect(params.objects.notes).toEqual([
    f.objects.notes[1],
    { ref: "A1", text: "updated", author: "QA" },
  ]);
  expect(f.objects.notes[0].text).toBe("existing");
});
