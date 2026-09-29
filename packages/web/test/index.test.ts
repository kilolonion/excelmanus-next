import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("web package exports its name", () => {
  expect(packageName).toBe("@excelmanus/web");
});
