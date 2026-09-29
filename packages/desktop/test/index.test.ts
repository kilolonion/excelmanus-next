import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("desktop package exports its name", () => {
  expect(packageName).toBe("@excelmanus/desktop");
});
