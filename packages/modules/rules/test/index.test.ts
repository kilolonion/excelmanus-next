import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("rules package exports its name", () => {
  expect(packageName).toBe("@excelmanus/rules");
});
