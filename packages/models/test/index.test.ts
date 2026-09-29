import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("models package exports its name", () => {
  expect(packageName).toBe("@excelmanus/models");
});
