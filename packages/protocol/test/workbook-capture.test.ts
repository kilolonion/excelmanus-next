import { expect, test } from "vitest";
import type { ZodType } from "zod";
import * as protocol from "../src/index.ts";

test("capture packet has bounded viewport, range and JSON data without an executable field", () => {
  const schema = Reflect.get(protocol, "WorkbookCapturePacket") as ZodType | undefined;
  expect(schema).toBeDefined();
  const valid = {
    workspaceId: "w",
    docId: "d",
    sheetId: "s",
    rev: 0,
    snapshot: { id: "d", sheetOrder: ["s"], sheets: { s: { id: "s" } } },
    range: "A1:B2",
    bounds: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
    viewport: { width: 1180, height: 757 },
    dpr: 1,
  };
  expect(schema!.safeParse(valid).success).toBe(true);
  for (const input of [
    { ...valid, range: "C1:D2" },
    { ...valid, script: "alert(1)" },
    { ...valid, dpr: 4 },
    { ...valid, bounds: { ...valid.bounds, endRow: 80 } },
    { ...valid, viewport: { width: 9000, height: 800 } },
    { ...valid, snapshot: { ...valid.snapshot, padding: "x".repeat(16 * 1024 * 1024) } },
  ])
    expect(schema!.safeParse(input).success).toBe(false);
});
