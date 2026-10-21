import type { FileEntry } from "@excelmanus/protocol";
import { expect, test, vi } from "vitest";
import { sortFiles } from "../src/lib/file-sorting";

const files: FileEntry[] = [
  {
    name: "old.csv",
    path: "old.csv",
    kind: "file",
    openedAt: "2026-10-01T00:00:00Z",
    modifiedAt: "2026-10-13T00:00:00Z",
  },
  { name: "new.csv", path: "new.csv", kind: "file", openedAt: "2026-10-12T00:00:00Z" },
  { name: "unopened.csv", path: "unopened.csv", kind: "file", modifiedAt: "2026-10-14T00:00:00Z" },
];
test("recent use is based on openedAt, unaffected by session marks or modification time", () => {
  expect(sortFiles(files, "recent", new Map([["old.csv", "modified"]])).map((f) => f.name)).toEqual(
    ["new.csv", "old.csv", "unopened.csv"],
  );
  expect(files[0]?.name).toBe("old.csv");
});
test("folders stay first; other sorting modes are explicit and stable", () => {
  expect(
    sortFiles([...files, { name: "folder", path: "folder", kind: "dir" }], "recent")[0]?.kind,
  ).toBe("dir");
  expect(sortFiles(files, "modified")[0]?.name).toBe("unopened.csv");
  expect(sortFiles(files, "session", new Map([["old.csv", "modified"]]))[0]?.name).toBe("old.csv");
  expect(sortFiles(files, "name").map((f) => f.name)).toEqual([
    "new.csv",
    "old.csv",
    "unopened.csv",
  ]);
});

test("sorting parses each file timestamp at most once", () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({
    name: `文件${i}.xlsx`,
    path: `文件${i}.xlsx`,
    kind: "file" as const,
    openedAt: new Date(Date.UTC(2026, 0, ((i * 17) % 28) + 1)).toISOString(),
  }));
  const parse = vi.spyOn(Date, "parse");
  try {
    sortFiles(entries, "recent");
    expect(parse.mock.calls.length).toBeLessThanOrEqual(entries.length);
  } finally {
    parse.mockRestore();
  }
});

test("natural Chinese name sorting reuses a collator without constructing options per comparison", () => {
  const entries = ["表10.xlsx", "表2.xlsx", "阿.xlsx", "中.xlsx", "a.xlsx", "A.xlsx"].map(
    (name, i) => ({
      name,
      path: `folder${i}/${name}`,
      kind: "file" as const,
    }),
  );
  const expected = [...entries].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.path.localeCompare(b.path),
  );
  const compare = vi.spyOn(String.prototype, "localeCompare");
  try {
    expect(sortFiles(entries, "name")).toEqual(expected);
    expect(compare.mock.calls.filter((args) => args[1] === "zh-CN")).toHaveLength(0);
  } finally {
    compare.mockRestore();
  }
});
