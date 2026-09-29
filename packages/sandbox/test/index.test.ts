import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("sandbox package exports its name", () => {
  expect(packageName).toBe("@excelmanus/sandbox");
});
