import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("core package exports its name", () => {
  expect(packageName).toBe("@excelmanus/core");
});
