import { expect, test } from "vitest";
import { useUIStore } from "../src/stores/ui-store";

test("generic settings enters the index, explicit links select detail, back does not change category", () => {
  const ui = useUIStore.getState();
  ui.openSettings();
  expect(useUIStore.getState()).toMatchObject({ settingsOpen: true, settingsOverview: true });
  ui.openSettings("rules");
  expect(useUIStore.getState()).toMatchObject({ settingsOverview: false, settingsTab: "rules" });
  ui.showSettingsOverview();
  expect(useUIStore.getState()).toMatchObject({ settingsOverview: true, settingsTab: "rules" });
  ui.closeSettings();
  expect(useUIStore.getState().settingsOpen).toBe(false);
});
