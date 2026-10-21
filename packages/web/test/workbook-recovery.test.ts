import { expect, test } from "vitest";
import { initialDocSync, markOffline, trackDocSubmit } from "../src/lib/workbook/doc-sync";
import { decodeRecovery, encodeRecovery } from "../src/lib/workbook/recovery";

test("refresh recovery retains input and marks sent operations uncertain without replay", () => {
  const submitted = {
    mutation: { id: "sheet.mutation.insert-row", params: { at: 2 } },
    baseRev: 3,
  };
  const sync = trackDocSubmit(
    markOffline(initialDocSync(3), "offline", submitted),
    "sent",
    submitted,
  );
  const draft = { sheetId: "s1", row: 0, col: 1, text: "未提交输入", baseRev: 3 };
  const restored = decodeRecovery(encodeRecovery(sync, [draft]), 5);
  expect(restored?.docSync.rev).toBe(5);
  expect(restored?.docSync.pending.sent).toMatchObject({
    status: "rejected",
    conflict: { code: "connection_lost" },
    submitted,
  });
  expect(restored?.docSync.pending.offline).toMatchObject({
    conflict: { code: "offline" },
    submitted,
  });
  expect(restored?.drafts).toEqual([draft]);
});

test("settled or malformed recovery data cannot resurrect old edits", () => {
  expect(encodeRecovery({ rev: 3, pending: { done: { status: "acked", rev: 3 } } }, [])).toBeNull();
  expect(decodeRecovery('{"version":1,"drafts":[{"text":"bad"}]}', 3)).toBeNull();
});

test("cell recovery survives a fresh tab and an old tab cannot erase newer input", async () => {
  const { createRecoveryStorage } = await import("../src/lib/workbook/recovery-storage");
  const values = new Map<string, string>();
  const local = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const a = createRecoveryStorage(local),
    b = createRecoveryStorage(local);
  const first = { sheetId: "s", row: 0, col: 0, text: "old", baseRev: 1 };
  const raw = (text: string) => encodeRecovery(initialDocSync(1), [{ ...first, text }]);
  a.read("workspace/doc");
  a.write("workspace/doc", raw("old"));
  expect(decodeRecovery(b.read("workspace/doc"), 2)?.drafts[0]?.text).toBe("old");
  b.write("workspace/doc", raw("new"));
  a.write("workspace/doc", null);
  expect(
    decodeRecovery(createRecoveryStorage(local).read("workspace/doc"), 2)?.drafts[0]?.text,
  ).toBe("new");
  b.write("workspace/doc", null);
  expect(decodeRecovery(createRecoveryStorage(local).read("workspace/doc"), 2)?.drafts).toEqual([]);
});

test("independent tabs merge cells and workspace keys stay isolated", async () => {
  const { createRecoveryStorage } = await import("../src/lib/workbook/recovery-storage");
  const values = new Map<string, string>();
  const local = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const a = createRecoveryStorage(local),
    b = createRecoveryStorage(local);
  a.read("one/doc");
  b.read("one/doc");
  const raw = (col: number) =>
    encodeRecovery(initialDocSync(1), [{ sheetId: "s", row: 0, col, text: String(col) }]);
  a.write("one/doc", raw(0));
  b.write("one/doc", raw(1));
  expect(
    decodeRecovery(createRecoveryStorage(local).read("one/doc"), 1)?.drafts.map((d) => d.col),
  ).toEqual([0, 1]);
  a.write("one/doc", null);
  expect(
    decodeRecovery(createRecoveryStorage(local).read("one/doc"), 1)?.drafts.map((d) => d.col),
  ).toEqual([1]);
  expect(createRecoveryStorage(local).read("two/doc")).toBeNull();
});

test("silent storage failures surface instead of reporting a saved cell draft", async () => {
  const { createRecoveryStorage } = await import("../src/lib/workbook/recovery-storage");
  const storage = createRecoveryStorage({ getItem: () => null, setItem: () => {} });
  expect(() =>
    storage.write(
      "doc",
      encodeRecovery(initialDocSync(1), [{ sheetId: "s", row: 0, col: 0, text: "retain" }]),
    ),
  ).toThrow("浏览器未能保存单元格草稿");
});

test("acknowledged submissions are removed from persistent recovery", async () => {
  const { createRecoveryStorage } = await import("../src/lib/workbook/recovery-storage");
  const values = new Map<string, string>();
  const local = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const storage = createRecoveryStorage(local);
  storage.read("doc");
  storage.write(
    "doc",
    encodeRecovery(
      trackDocSubmit(initialDocSync(1), "sent", {
        baseRev: 1,
        mutation: { id: "test", params: {} },
      }),
      [],
    ),
  );
  storage.write("doc", null);
  expect(decodeRecovery(storage.read("doc"), 2)?.docSync.pending).toEqual({});
});
