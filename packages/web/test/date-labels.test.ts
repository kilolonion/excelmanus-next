import { expect, test, vi } from "vitest";
import { createDateLabels } from "../src/lib/date-labels";

test("list date labels preserve locale output and invalid-date fallbacks", () => {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  const at = "2026-10-18T00:00:00Z";
  const expected = new Date(at).toLocaleString("zh-CN", options);
  const spy = vi.spyOn(Intl, "DateTimeFormat");
  try {
    const format = createDateLabels(options);
    expect(format("bad-date")).toBe("bad-date");
    expect(format()).toBe("");
    expect(spy).toHaveBeenCalledTimes(0);
    expect(format(at)).toBe(expected);
    expect(format(at)).toBe(expected);
    expect(spy).toHaveBeenCalledTimes(1);
    const comments = createDateLabels(options, "");
    expect(comments("bad-date")).toBe("");
    expect(comments(at)).toBe(expected);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});
