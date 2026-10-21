import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
};
test("mobile settings categories use one scrollable row instead of a tall grid", () => {
  expect(rule(".em-settings-mobile-tabs")).toContain("overflow-x: auto");
  expect(rule(".em-settings-mobile-tabs")).not.toContain("grid-template-columns");
  expect(rule(".em-settings-mobile-tab")).toContain("white-space: nowrap");
});
test("full mobile workbook owns safe area and avoids duplicate workspace header", () => {
  expect(css).toContain('.em-main:has([data-workspace-surface="excel"]) > .em-topbar');
  expect(rule('[data-workbook-placement="full"]')).toContain("safe-area-inset-bottom");
});
test("mobile workbook reserves a separate footer slot for editable zoom", () => {
  expect(css).toContain("padding-right: 70px !important");
  expect(css).toContain(".em-workbook-zoom-button { display: none; }");
});

test("phone settings cancels both desktop transform and Tailwind individual translate at 640–767px", () => {
  expect(rule(".em-settings-phone.em-settings-dialog")).toContain("translate: none");
  expect(rule(".em-settings-phone.em-settings-dialog")).toContain("inset: 0");
});
