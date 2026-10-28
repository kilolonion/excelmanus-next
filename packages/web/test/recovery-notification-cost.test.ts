import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(() => null) }));
vi.mock("@/lib/workbook/recovery-storage", () => ({ createRecoveryStorage: () => h }));

import { initialDocSync, reduceDoc, trackDocSubmit } from "../src/lib/workbook/doc-sync";
import { decodeRecovery } from "../src/lib/workbook/recovery";
import { type OpenDoc, useWorkbookStore } from "../src/stores/workbook-store";

const doc: OpenDoc = {
  docId: "doc",
  path: "qa.xlsx",
  kind: "xlsx",
  rev: 1,
  snapshotRev: 1,
  snapshot: {},
};
beforeEach(() => {
  useWorkbookStore.setState(useWorkbookStore.getInitialState());
  useWorkbookStore.setState({ workspaceId: "ws", doc, docSync: initialDocSync(1) });
  h.write.mockClear();
});
test("revision, checkpoint and snapshot notifications do not rewrite unchanged recovery data", () => {
  for (let i = 2; i <= 101; i++) {
    useWorkbookStore.setState((s) => ({ docSync: { ...s.docSync, rev: i } }));
    useWorkbookStore.setState((s) => ({ doc: { ...s.doc!, rev: i } }));
    useWorkbookStore.setState((s) => ({ doc: { ...s.doc!, checkpointRev: i } }));
  }
  useWorkbookStore.setState((s) => ({
    doc: { ...s.doc!, snapshotRev: 101, snapshot: { sheets: {} }, path: "renamed.xlsx" },
  }));
  expect(h.write.mock.calls.length).toBe(0);
});
test("actual drafts, submitted edits and acknowledgements still persist immediately", () => {
  useWorkbookStore.setState({
    inputDraft: { docId: "doc", sheetId: "s", row: 0, col: 0, text: "draft" },
  });
  expect(h.write).toHaveBeenCalledTimes(1);
  expect(decodeRecovery(h.write.mock.lastCall?.[1], 1)?.drafts[0]?.text).toBe("draft");
  useWorkbookStore.setState((s) => ({
    inputDraft: null,
    docSync: trackDocSubmit(s.docSync, "op", {
      baseRev: 1,
      mutation: { id: "test", params: { text: "draft" } },
    }),
  }));
  expect(h.write).toHaveBeenCalledTimes(2);
  expect(
    decodeRecovery(h.write.mock.lastCall?.[1], 1)?.docSync.pending.op?.submitted,
  ).toBeDefined();
  useWorkbookStore.setState((s) => ({
    docSync: reduceDoc(s.docSync, { type: "doc.ack", clientOpId: "op", rev: 2 }),
  }));
  expect(h.write).toHaveBeenCalledTimes(3);
  expect(h.write.mock.lastCall?.[1]).toBeNull();
});
test("switching document scope and closing still save the departing input", () => {
  useWorkbookStore.setState({
    inputDraft: { docId: "doc", sheetId: "s", row: 0, col: 0, text: "retain old" },
  });
  h.write.mockClear();
  useWorkbookStore.setState({
    workspaceId: "other",
    doc: { ...doc, docId: "next" },
    inputDraft: null,
    docSync: initialDocSync(),
  });
  expect(h.write).toHaveBeenCalledTimes(2);
  expect(h.write.mock.calls[0]?.[0]).toBe("excelmanus.recovery.ws.doc");
  expect(decodeRecovery(h.write.mock.calls[0]?.[1], 1)?.drafts[0]?.text).toBe("retain old");
  expect(h.write.mock.calls[1]?.[0]).toBe("excelmanus.recovery.other.next");
  h.write.mockClear();
  useWorkbookStore.setState({ doc: null });
  expect(h.write).toHaveBeenCalledOnce();
  expect(h.write.mock.lastCall?.[0]).toBe("excelmanus.recovery.other.next");
});

test("conflict input and recovered draft changes still update recovery", () => {
  useWorkbookStore.setState({
    draftConflict: {
      docId: "doc",
      sheetId: "s",
      row: 1,
      col: 0,
      text: "mine",
      theirs: "remote",
      source: "agent",
    },
  });
  expect(decodeRecovery(h.write.mock.lastCall?.[1], 1)?.drafts[0]?.text).toBe("mine");
  useWorkbookStore.setState({
    draftConflict: null,
    recoveredDrafts: [
      {
        docId: "doc",
        sheetId: "s",
        row: 2,
        col: 0,
        text: "restored",
        theirs: null,
        source: "recovered",
      },
    ],
  });
  expect(decodeRecovery(h.write.mock.lastCall?.[1], 1)?.drafts[0]?.text).toBe("restored");
  useWorkbookStore.setState({ recoveredDrafts: [] });
  expect(h.write).toHaveBeenCalledTimes(3);
  expect(h.write.mock.lastCall?.[1]).toBeNull();
});
