import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/lib/workbook/recovery", async (original) => {
  const recovery = await original<typeof import("../src/lib/workbook/recovery")>();
  return { ...recovery, decodeRecovery: vi.fn(recovery.decodeRecovery) };
});

import { initialDocSync, markOffline } from "../src/lib/workbook/doc-sync";
import { decodeRecovery, encodeRecovery } from "../src/lib/workbook/recovery";
import { createRecoveryStorage } from "../src/lib/workbook/recovery-storage";

function fixture(raw: string | null) {
  let saved = raw;
  return {
    getItem: () => saved,
    setItem: vi.fn((_key: string, value: string) => {
      saved = value;
    }),
  };
}
const draft = (text: string, col = 0) => ({ sheetId: "sheet", row: 0, col, text });
const rawDraft = (text: string) => encodeRecovery(initialDocSync(1), [draft(text)]);
beforeEach(() => vi.mocked(decodeRecovery).mockClear());

test("an unchanged recovery snapshot is decoded once and still written and verified", () => {
  const raw = rawDraft("same");
  const local = fixture(raw),
    storage = createRecoveryStorage(local);
  storage.read("doc");
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    storage.write("doc", raw);
    expect(sort).not.toHaveBeenCalled();
  } finally {
    sort.mockRestore();
  }
  expect(decodeRecovery).toHaveBeenCalledTimes(1);
  expect(local.setItem).toHaveBeenCalledOnce();
  expect(local.getItem()).toBe(raw);
});
test("typing a new draft reuses the identical observed and stored baseline", () => {
  const local = fixture(rawDraft("old")),
    storage = createRecoveryStorage(local);
  storage.read("doc");
  storage.write("doc", rawDraft("new"));
  expect(decodeRecovery).toHaveBeenCalledTimes(2);
  expect(decodeRecovery(local.getItem(), 1)?.drafts).toEqual([draft("new")]);
});
test("divergent tabs still merge untouched cells and preserve newer pending submissions", () => {
  const submit = (text: string) =>
    markOffline(initialDocSync(1), "op", {
      baseRev: 1,
      mutation: { id: "set", params: { text } },
    });
  const old = encodeRecovery(submit("old"), [draft("old")]);
  const local = fixture(old),
    a = createRecoveryStorage(local),
    b = createRecoveryStorage(local);
  a.read("doc");
  b.read("doc");
  b.write("doc", encodeRecovery(submit("new"), [draft("new"), draft("other", 1)]));
  vi.mocked(decodeRecovery).mockClear();
  a.write("doc", null);
  expect(decodeRecovery).toHaveBeenCalledTimes(3);
  const saved = decodeRecovery(local.getItem(), 1);
  expect(saved?.drafts).toEqual([draft("new"), draft("other", 1)]);
  expect(saved?.docSync.pending.op?.submitted?.mutation.params).toEqual({ text: "new" });
  b.write("doc", null);
  expect(decodeRecovery(local.getItem(), 1)?.drafts).toEqual([]);
  expect(decodeRecovery(local.getItem(), 1)?.docSync.pending).toEqual({});
});

test("a stored snapshot matching this tab's next value shares decoding without stale state", () => {
  const local = fixture(rawDraft("old")),
    storage = createRecoveryStorage(local);
  storage.read("doc");
  const next = rawDraft("new");
  if (next === null) throw Error("draft fixture missing");
  local.setItem("doc", next);
  storage.write("doc", next);
  expect(decodeRecovery).toHaveBeenCalledTimes(2);
  expect(local.getItem()).toBe(next);
  storage.write("doc", null);
  expect(decodeRecovery(local.getItem(), 1)?.drafts).toEqual([]);
});
