import { expect, test } from "vitest";
import { initialDocSync, trackDocSubmit, markDisconnected, latestDocConflict, reduceDoc } from "../src/lib/workbook/doc-sync";

test("disconnect before acknowledgement retains input and exposes an uncertain outcome", () => {
  const submitted = { mutation: { id: "sheet.mutation.insert-row", params: { at: 3 } }, baseRev: 4 };
  const pending = trackDocSubmit(initialDocSync(4), "op", submitted);
  const disconnected = markDisconnected(pending);
  expect(disconnected.pending.op?.status).toBe("rejected");
  expect(latestDocConflict(disconnected)?.code).toBe("connection_lost");
  expect(latestDocConflict(disconnected)?.submitted).toEqual(submitted);
  expect(markDisconnected(disconnected)).toBe(disconnected);
  const lateAck = reduceDoc(disconnected, { type: "doc.ack", clientOpId: "op", rev: 5 });
  expect(lateAck.pending.op).toBeUndefined();
  expect(lateAck.rev).toBe(5);
  expect(latestDocConflict(lateAck)).toBeNull();
});

