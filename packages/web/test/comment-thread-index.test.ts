import type { ThreadComment } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { createStableCommentSheets, indexCommentReplies } from "../src/lib/workbook/comment-threads";

const c = (id: string, parentId?: string): ThreadComment => ({
  id,
  ...(parentId ? { parentId } : {}),
  personId: "p",
  ref: "A1",
  text: id,
  author: "QA",
  done: false,
});
test("nested replies keep file order, and missing parents or cycles remain excluded", () => {
  const comments = [
    c("nested", "reply"),
    c("root"),
    c("other"),
    c("reply", "root"),
    c("other-reply", "other"),
    c("orphan", "missing"),
    c("cycle-a", "cycle-b"),
    c("cycle-b", "cycle-a"),
  ];
  const groups = indexCommentReplies(comments);
  expect(groups.get("root")?.map((c) => c.id)).toEqual(["nested", "reply"]);
  expect(groups.get("other")?.map((c) => c.id)).toEqual(["other-reply"]);
  expect(groups.size).toBe(2);
});
test("deep reply chains are indexed without repeated whole-list parent searches", () => {
  let reads = 0;
  const comments = Array.from({ length: 5000 }, (_, i) => {
    const comment = c(String(i), i ? String(i - 1) : undefined);
    Object.defineProperty(comment, "id", {
      get() {
        reads++;
        return String(i);
      },
      enumerable: true,
    });
    return comment;
  });
  const groups = indexCommentReplies(comments);
  expect(groups.get("0")).toHaveLength(4999);
  expect(groups.get("0")?.at(-1)).toBe(comments[4999]);
  expect(reads).toBeLessThan(20000);
});

test("stable comment sheets preserve order and invalidate optional fields, renames and removals", () => {
  const share = createStableCommentSheets();
  const comment: ThreadComment = {
    id: "root",
    personId: "person",
    ref: "A1",
    text: "QA",
    author: "QA",
    done: false,
  };
  const first = share([
    { id: "a", name: "A", comments: [comment] },
    { id: "b", name: "B", comments: [] },
  ]);
  const copy = () => structuredClone(first);
  expect(share(copy())).toBe(first);
  const changed = copy();
  changed[0].comments[0] = { ...comment, dateTime: "2026-10-18T00:00:00Z" };
  const updated = share(changed);
  expect(updated[0]).not.toBe(first[0]);
  expect(updated[1]).toBe(first[1]);
  const ordered = share([updated[1], updated[0]]);
  expect(ordered[0]).toBe(updated[1]);
  const renamed = share([{ ...ordered[0], name: "Renamed" }, ordered[1]]);
  expect(renamed[0]).not.toBe(ordered[0]);
  expect(share([])).toEqual([]);
  expect(share(copy())[0]).not.toBe(first[0]);
});
