import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("protocol package exports its name", () => {
  expect(packageName).toBe("@excelmanus/protocol");
});
