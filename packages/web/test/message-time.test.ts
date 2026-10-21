import { afterEach, expect, test, vi } from "vitest";
import { formatClock, formatTimestamp } from "../src/lib/message-time";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("message clocks avoid constructing a locale formatter on each render", () => {
  const at = "2026-10-18T13:41:00Z";
  const expected = new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const locale = vi.spyOn(Date.prototype, "toLocaleTimeString");
  for (let i = 0; i < 500; i++) expect(formatClock(at)).toBe(expected);
  expect(locale).not.toHaveBeenCalled();
});
test("recent separators do not format a clock they never display", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T13:41:00Z"));
  const locale = vi.spyOn(Date.prototype, "toLocaleTimeString");
  expect(formatTimestamp("2026-10-18T13:40:45Z")).toBe("刚刚");
  expect(formatTimestamp("2026-10-18T13:36:00Z")).toBe("5 分钟前");
  expect(locale).not.toHaveBeenCalled();
});
test("clock output matches the previous zh-CN rendering for every minute", () => {
  for (const day of [new Date(2026, 0, 10), new Date(2026, 6, 10)]) {
    for (let minute = 0; minute < 1440; minute++) {
      const date = new Date(day);
      date.setMinutes(minute);
      expect(formatClock(date.toISOString())).toBe(
        date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      );
    }
  }
  expect(formatClock()).toBeNull();
  expect(formatClock("")).toBeNull();
  expect(formatClock("not a date")).toBeNull();
});
test("relative separators keep today, yesterday, older dates and time progression", () => {
  vi.useFakeTimers();
  const now = new Date(2026, 9, 18, 14, 0);
  vi.setSystemTime(now);
  const today = new Date(2026, 9, 18, 9, 7),
    yesterday = new Date(2026, 9, 17, 23, 5),
    older = new Date(2026, 9, 15, 8, 4);
  expect(formatTimestamp(today.toISOString())).toBe("09:07");
  expect(formatTimestamp(yesterday.toISOString())).toBe("昨天 23:05");
  expect(formatTimestamp(older.toISOString())).toBe("10/15 08:04");
  expect(formatTimestamp(now.toISOString())).toBe("刚刚");
  vi.setSystemTime(now.getTime() + 120000);
  expect(formatTimestamp(now.toISOString())).toBe("2 分钟前");
});
