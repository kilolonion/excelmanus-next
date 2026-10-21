import { DatabaseSync } from "node:sqlite";
import { SessionLog, withResultCursor } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { z } from "zod";
import { MemoryService, memoryTool } from "../src/index.ts";

test("memory advertises action and branch fields alongside the result cursor", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const tool = memoryTool(new MemoryService(db), new SessionLog(db));
    const schema = withResultCursor(tool.inputJsonSchema ?? z.toJSONSchema(tool.input));
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.action).toMatchObject({ enum: ["save", "search", "delete"] });
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    for (const key of ["content", "category", "scope", "query", "limit", "id", "cursor"])
      expect(properties[key], key).toBeDefined();
    expect(schema.anyOf).toBeUndefined();
    expect(tool.input.safeParse({ cursor: "undefined" }).success).toBe(false);
    expect(
      tool.input.safeParse({ action: "save", content: "test", category: "preference" }).success,
    ).toBe(true);
    expect(tool.input.safeParse({ action: "save", content: "test" }).success).toBe(false);
    expect(tool.input.safeParse({ action: "search", query: "test" }).success).toBe(true);
    expect(
      tool.input.safeParse({ action: "search", query: "test", content: "extra" }).success,
    ).toBe(false);
    expect(tool.input.safeParse({ action: "delete", id: "memory-test" }).success).toBe(true);
    expect(tool.input.safeParse({ action: "delete" }).success).toBe(false);
  } finally {
    db.close();
  }
});
