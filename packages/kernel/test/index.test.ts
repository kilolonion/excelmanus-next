import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("kernel package exports its name", () => {
  expect(packageName).toBe("@excelmanus/kernel");
});
