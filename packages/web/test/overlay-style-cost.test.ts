import { afterEach, expect, test, vi } from "vitest";
import * as colors from "../src/lib/workbook/overlay-colors";

afterEach(() => vi.unstubAllGlobals());
test("overlay styles read each color token once rather than once per opacity", () => {
  vi.stubGlobal("document", { documentElement: {} });
  const read = vi.fn((name: string) => (name === "--em-gold" ? "#e5a100" : "#0078d4"));
  const computed = vi.fn(() => ({ getPropertyValue: read }));
  vi.stubGlobal("getComputedStyle", computed);
  const styles = colors.overlayStyles();
  expect(styles.reading.fill).toBe("rgba(0, 120, 212, 0.06)");
  expect(styles.writing.stroke).toBe("rgb(0, 120, 212)");
  expect(styles.pending.fill).toBe("rgba(229, 161, 0, 0.08)");
  expect(computed).toHaveBeenCalledTimes(2);
});

test("a paint pass reuses RGB across marks and the next pass observes the new token", () => {
  vi.stubGlobal("document", { documentElement: {} });
  let token = "#112233";
  const computed = vi.fn(() => ({ getPropertyValue: () => token }));
  vi.stubGlobal("getComputedStyle", computed);
  const color = colors.overlayColor("ok");
  for (let i = 0; i < 100; i++) {
    expect(color(0.1)).toBe("rgba(17, 34, 51, 0.1)");
    expect(color(1)).toBe("rgb(17, 34, 51)");
  }
  expect(computed).toHaveBeenCalledTimes(1);
  token = "#445566";
  expect(colors.overlayColor("ok")(1)).toBe("rgb(68, 85, 102)");
  expect(computed).toHaveBeenCalledTimes(2);
});
