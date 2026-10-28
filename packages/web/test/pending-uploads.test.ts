import { expect, test } from "vitest";
import { snapshotUploadFile } from "../src/lib/pending-uploads";
test("pending file snapshot copies bytes and refuses incomplete data", async () => {
  const file = new File(["item,amount\ndraft,17\n"], "draft.csv", { type: "text/csv" });
  const copy = await snapshotUploadFile(file);
  expect(copy.name).toBe(file.name);
  expect(await copy.text()).toBe(await file.text());
  const unreadable = new File(["abc"], "bad.csv");
  Object.defineProperty(unreadable, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
  await expect(snapshotUploadFile(unreadable)).rejects.toThrow("不完整");
});
