import { expect, test } from "vitest";
import { parseSavedTabs } from "../src/lib/workbook/saved-tabs.ts";

test("restores only paths and selection, not stale workbook snapshots", () => {
  expect(
    parseSavedTabs(
      JSON.stringify({
        paths: ["a.xlsx", 7, "b.csv", "a.xlsx"],
        activePath: "b.csv",
        panelOpen: true,
        fullView: false,
        snapshot: {},
      }),
    ),
  ).toEqual({ paths: ["a.xlsx", "b.csv"], activePath: "b.csv", panelOpen: true, fullView: false });
  expect(parseSavedTabs("invalid")).toBeNull();
  expect(parseSavedTabs('{"paths":[],"activePath":"missing"}')?.activePath).toBeNull();
});
