import { expect, test } from "vitest";
import {
  initialDocSync,
  latestDocConflict,
  markDisconnected,
  markOffline,
  reduceDoc,
  trackDocSubmit,
} from "../src/lib/workbook/doc-sync";
import { encodeRecovery } from "../src/lib/workbook/recovery";

const submitted = {
  baseRev: 0,
  mutation: { id: "sheet.mutation.set-range-values", params: { value: "keep" } },
};

test("a long acknowledged editing session does not grow the outstanding submission set", () => {
  let state = initialDocSync();
  for (let i = 1; i <= 1000; i++) {
    state = trackDocSubmit(state, `op-${i}`, submitted);
    state = reduceDoc(state, { type: "doc.ack", clientOpId: `op-${i}`, rev: i });
  }
  expect(state.rev).toBe(1000);
  expect(Object.keys(state.pending)).toHaveLength(0);
  expect(latestDocConflict(state)).toBeNull();
  expect(encodeRecovery(state, [])).toBeNull();
});
test("acknowledgement removes only its own entry and preserves unsent and rejected input", () => {
  let state = trackDocSubmit(initialDocSync(5), "done", submitted);
  state = trackDocSubmit(state, "waiting", submitted);
  state = markOffline(state, "offline", submitted);
  const next = reduceDoc(state, { type: "doc.ack", clientOpId: "done", rev: 6 });
  expect(next.pending.done).toBeUndefined();
  expect(next.pending.waiting).toBe(state.pending.waiting);
  expect(next.pending.offline).toBe(state.pending.offline);
  expect(state.pending.done?.status).toBe("pending");
  expect(latestDocConflict(next)?.clientOpId).toBe("offline");
  expect(encodeRecovery(next, [])).toContain('"offline"');
});
test("a late acknowledgement resolves an uncertain input and duplicate responses remain inert", () => {
  const uncertain = markDisconnected(trackDocSubmit(initialDocSync(9), "lost", submitted));
  const ack = { type: "doc.ack" as const, clientOpId: "lost", rev: 8 };
  const next = reduceDoc(uncertain, ack);
  expect(next.rev).toBe(9);
  expect(next.pending.lost).toBeUndefined();
  expect(reduceDoc(next, ack)).toBe(next);
  expect(
    reduceDoc(next, { type: "doc.reject", clientOpId: "lost", conflict: { code: "late" } }),
  ).toBe(next);
  const offline = markOffline(initialDocSync(9), "unsent", submitted);
  expect(reduceDoc(offline, { ...ack, clientOpId: "unsent" })).toBe(offline);
});
