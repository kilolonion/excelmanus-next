import { expect, test } from "vitest";
import { WorkbookEditInput, WorkbookEditJsonSchema } from "../src/edit-input.ts";

test("style.set rejects sheet with a usable qualified-range correction", () => {
  const bad = WorkbookEditInput.safeParse({
    path: "report.xlsx",
    ops: [{ op: "style.set", sheet: "汇总", range: "A1:B2", bold: true }],
  });
  expect(bad.success).toBe(false);
  if (bad.success) throw new Error("invalid arguments accepted");
  expect(bad.error.issues[0]?.message).toContain("range");
  expect(bad.error.issues[0]?.message).toContain("sheet");
  expect(
    WorkbookEditInput.parse({
      path: "report.xlsx",
      ops: [{ op: "style.set", range: "'汇总'!A1:B2", bold: true }],
    }).ops[0],
  ).toEqual({ op: "style.set", range: "'汇总'!A1:B2", bold: true });
  const schema = WorkbookEditJsonSchema.properties?.ops?.items;
  expect(JSON.stringify(schema)).toContain("style.set 不传 sheet");
});
