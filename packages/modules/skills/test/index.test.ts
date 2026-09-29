import { expect, test } from "vitest";

import { packageName } from "../src/index.ts";

test("skills package exports its name", () => {
  expect(packageName).toBe("@excelmanus/skills");
});
