import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => ({ getDocRevBefore: h.read }) }));

import { readRevisionBefore } from "../src/lib/workbook/change-reads";

test("completed revision previews retain a bounded recent set", async () => {
  h.read.mockImplementation(async (_ws, _doc, rev) => ({ cells: [], rev }));
  for (let rev = 1; rev <= 64; rev++) await readRevisionBefore("bounded", "doc", rev);
  const calls = h.read.mock.calls.length;
  await readRevisionBefore("bounded", "doc", 64);
  expect(h.read).toHaveBeenCalledTimes(calls);
  await readRevisionBefore("bounded", "doc", 1);
  expect(h.read).toHaveBeenCalledTimes(calls + 1);
});

test("cache pressure does not duplicate a still-pending revision request", async () => {
  let resolve!: (v: { cells: never[] }) => void;
  h.read.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = readRevisionBefore("pending", "doc", 1);
  h.read.mockImplementation(async () => ({ cells: [] }));
  for (let rev = 2; rev <= 65; rev++) await readRevisionBefore("pending", "doc", rev);
  expect(readRevisionBefore("pending", "doc", 1)).toBe(pending);
  resolve({ cells: [] });
  await pending;
});

function largeBefore(count: number) {
  const value = "中".repeat(20000);
  return {
    cells: Array.from({ length: count }, (_, row) => ({ sheet: "Data", row, col: 0, value })),
  };
}
test("large completed before-values are evicted by retained content size", async () => {
  h.read.mockReset().mockResolvedValue(largeBefore(500));
  const a = await readRevisionBefore("byte-budget", "doc", 1);
  await readRevisionBefore("byte-budget", "doc", 2);
  await readRevisionBefore("byte-budget", "doc", 2);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(a.cells).toHaveLength(500);
  await readRevisionBefore("byte-budget", "doc", 1);
  expect(h.read).toHaveBeenCalledTimes(3);
});

test("oversized before-values still share their pending request but are not retained", async () => {
  const data = largeBefore(1000);
  let resolve!: (v: typeof data) => void;
  h.read.mockReset().mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const first = readRevisionBefore("oversized", "doc", 1);
  expect(readRevisionBefore("oversized", "doc", 1)).toBe(first);
  resolve(data);
  expect((await first).cells).toHaveLength(1000);
  h.read.mockResolvedValue(data);
  await readRevisionBefore("oversized", "doc", 1);
  expect(h.read).toHaveBeenCalledTimes(2);
});

test("before-value cache pressure preserves the most recently reused entry", async () => {
  h.read.mockReset().mockResolvedValue(largeBefore(300));
  await readRevisionBefore("byte-lru", "doc", 1);
  await readRevisionBefore("byte-lru", "doc", 2);
  await readRevisionBefore("byte-lru", "doc", 1);
  await readRevisionBefore("byte-lru", "doc", 3);
  await readRevisionBefore("byte-lru", "doc", 1);
  expect(h.read).toHaveBeenCalledTimes(3);
  await readRevisionBefore("byte-lru", "doc", 2);
  expect(h.read).toHaveBeenCalledTimes(4);
});
