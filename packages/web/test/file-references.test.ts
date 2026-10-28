import { expect, test } from "vitest";
import { isWorkspaceFileReference } from "../src/lib/file-kind.ts";

test("inline file references exclude tool code and JSON results", () => {
  expect(isWorkspaceFileReference("style.set(B1:B13, wrap:false)")).toBe(false);
  expect(
    isWorkspaceFileReference('{"status":"ok","data":{"buffered":true,...,"opsCount":1}}'),
  ).toBe(false);
  expect(isWorkspaceFileReference("cols.width")).toBe(false);
  expect(isWorkspaceFileReference("=SUM(A1:A5)/2")).toBe(false);
});

test("inline file references retain supported filenames and paths", () => {
  for (const path of [
    "收款收据.xlsx",
    "reports/销售 (最终版).xlsx",
    "data.json",
    "README",
    ".gitignore",
    "C:\\reports\\sales.csv",
  ]) {
    expect(isWorkspaceFileReference(path)).toBe(true);
  }
});
