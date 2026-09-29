import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("mcp package exports its name", () => {
  expect(packageName).toBe("@excelmanus/mcp");
});
