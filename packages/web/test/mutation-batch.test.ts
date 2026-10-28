import { expect, test, vi } from "vitest";
import { EditorMutationBatch } from "../src/lib/workbook/mutation-batch";

test("a structural mutation and its formula updates share one atomic submission", async () => {
  const send = vi.fn();
  const batch = new EditorMutationBatch(send);
  const insert = { id: "sheet.mutation.insert-row", params: { range: { startRow: 5, endRow: 5 } } };
  const formula = {
    id: "sheet.mutation.set-range-values",
    params: { cellValue: { 6: { 5: { f: "=D7*E7" } } } },
  };
  batch.push(insert, 3);
  batch.push(formula, 3);
  expect(send).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(send).toHaveBeenCalledExactlyOnceWith([insert, formula], 3);
});
test("new revision starts a new batch and explicit flush does not send twice", async () => {
  const send = vi.fn();
  const batch = new EditorMutationBatch(send);
  const mutation = { id: "value", params: { value: 1 } };
  batch.push(mutation, 1);
  mutation.params.value = 2;
  batch.push(mutation, 2);
  batch.flush();
  await Promise.resolve();
  expect(send.mock.calls).toEqual([
    [[{ id: "value", params: { value: 1 } }], 1],
    [[mutation], 2],
  ]);
});
