import { numericEvidence } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { captureNumericRead } from "../src/numeric-finalizer.ts";

test("successful reads missing identity stay in host provenance and invalidate the complete readset", () => {
  const broken = captureNumericRead("workbook_read", { status: "ok", data: { mode: "overview" } });
  expect(broken).toMatchObject({ toolName: "workbook_read", mode: "overview" });
  expect(
    numericEvidence("script", "run_script", {
      status: "ok",
      data: { value: 1, provenance: { code: "actual", reads: [broken] } },
    }),
  ).toBeUndefined();
});
