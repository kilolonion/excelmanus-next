import { expect, test } from "vitest";

import { composedName, packageName } from "../src/index.ts";

test("server package composes protocol via workspace dependency", () => {
  expect(packageName).toBe("@excelmanus/server");
  expect(composedName).toBe("@excelmanus/server -> @excelmanus/protocol");
});
