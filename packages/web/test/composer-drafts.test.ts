import { describe, expect, test, vi } from "vitest";
import { appendDraft, readDraft, saveDraft } from "../src/lib/composer-drafts.ts";

const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};
describe("conversation drafts", () => {
  test("switching conversations preserves each draft independently", () => {
    const s = storage();
    saveDraft(s, "A/main", "A 的需求");
    saveDraft(s, "B/main", "B 的需求");
    expect(readDraft(s, "A/main")).toBe("A 的需求");
    expect(readDraft(s, "B/main")).toBe("B 的需求");
    saveDraft(s, "B/main", "");
    expect(readDraft(s, "A/main")).toBe("A 的需求");
    expect(readDraft(s, "B/main")).toBe("");
  });
  test("shortcuts append to an existing request instead of replacing it", () => {
    expect(appendDraft("先核对金额", "检查数据质量")).toBe("先核对金额\n\n检查数据质量");
    expect(appendDraft("", "检查数据质量")).toBe("检查数据质量");
    expect(appendDraft("检查数据质量", "检查数据质量")).toBe("检查数据质量");
  });
  test("unavailable browser storage does not block typing", () => {
    const denied = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDraft(denied, "a")).toBe("");
    expect(() => saveDraft(denied, "a", "text")).not.toThrow();
  });
});

test("persistent drafts survive a new tab and an old send cannot clear newer text", async () => {
  const { persistentDraftStorage } = await import("../src/lib/draft-storage");
  const { clearDraftIfUnchanged } = await import("../src/lib/composer-drafts");
  const local = storage(),
    oldTab = storage(),
    newTab = storage();
  const first = persistentDraftStorage(local, oldTab);
  saveDraft(first, "A/main", "保存到浏览器");
  expect(readDraft(persistentDraftStorage(local, newTab), "A/main")).toBe("保存到浏览器");
  saveDraft(persistentDraftStorage(local, newTab), "A/main", "另一标签页的新内容");
  clearDraftIfUnchanged(first, "A/main", "保存到浏览器");
  expect(readDraft(persistentDraftStorage(local, newTab), "A/main")).toBe("另一标签页的新内容");
});

test("typing and rereading reuse the exact current draft payload across storage wrappers", async () => {
  const { persistentDraftStorage } = await import("../src/lib/draft-storage");
  const { DRAFTS_KEY } = await import("../src/lib/composer-drafts");
  const local = storage(),
    tab = storage();
  local.setItem(
    DRAFTS_KEY,
    JSON.stringify({ "parse-cost/main": "retained", "active/main": "before" }),
  );
  const parse = vi.spyOn(JSON, "parse");
  try {
    for (let i = 0; i < 30; i++) {
      saveDraft(persistentDraftStorage(local, tab), "active/main", `typing ${i}`);
      expect(readDraft(persistentDraftStorage(local, tab), "active/main")).toBe(`typing ${i}`);
    }
    expect(parse.mock.calls.length).toBe(1);
    expect(readDraft(persistentDraftStorage(local, tab), "parse-cost/main")).toBe("retained");
  } finally {
    parse.mockRestore();
  }
});

test("external payload changes and failed writes never reuse stale draft values", async () => {
  const { DRAFTS_KEY, clearDraftIfUnchanged } = await import("../src/lib/composer-drafts");
  const s = storage();
  saveDraft(s, "external/main", "old");
  s.setItem(
    DRAFTS_KEY,
    JSON.stringify({ "external/main": "new from another tab", "other/main": "keep" }),
  );
  clearDraftIfUnchanged(s, "external/main", "old");
  expect(readDraft(s, "external/main")).toBe("new from another tab");
  const failed = {
    getItem: s.getItem,
    setItem: () => {
      throw new Error("quota");
    },
  };
  saveDraft(failed, "external/main", "not saved");
  expect(readDraft(s, "external/main")).toBe("new from another tab");
  saveDraft(s, "external/main", "edited");
  expect(readDraft(s, "other/main")).toBe("keep");
  expect(readDraft(s, "external/main")).toBe("edited");
});

test("cached reads preserve malformed payload recovery and remove only the requested draft", async () => {
  const { DRAFTS_KEY, clearDraftIfUnchanged } = await import("../src/lib/composer-drafts");
  const s = storage();
  s.setItem(DRAFTS_KEY, '{"valid/main":"keep","discard":42}');
  expect(readDraft(s, "discard")).toBe("");
  saveDraft(s, "active/main", "send this");
  expect(JSON.parse(s.getItem(DRAFTS_KEY) ?? "null")).toEqual({
    "valid/main": "keep",
    "active/main": "send this",
  });
  clearDraftIfUnchanged(s, "active/main", "send this");
  expect(readDraft(s, "valid/main")).toBe("keep");
  expect(readDraft(s, "active/main")).toBe("");
  s.setItem(DRAFTS_KEY, "{broken");
  expect(readDraft(s, "valid/main")).toBe("");
  saveDraft(s, "after-broken/main", "recovered");
  expect(readDraft(s, "after-broken/main")).toBe("recovered");
});
