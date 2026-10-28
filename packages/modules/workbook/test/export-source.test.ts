import { WorkbookExportInput } from "@excelmanus/protocol";
import { expect, test } from "vitest";
test("export requires an explicit source rather than opening an empty path", () => {
  const result = WorkbookExportInput.safeParse({ to: "out.xlsx" });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toContain("源");
  expect(WorkbookExportInput.safeParse({ to: "out.xlsx", path: "" }).success).toBe(false);
  expect(WorkbookExportInput.parse({ to: "out.xlsx", path: "source.xlsx" }).format).toBe("xlsx");
  expect(WorkbookExportInput.safeParse({ to: "out.xlsx", docId: "doc_1" }).success).toBe(true);
});
