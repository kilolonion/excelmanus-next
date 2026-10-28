import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTable } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { FILES_TOOLS } from "../src/tools.ts";

test("find pattern is an explicit glob alias, never silently ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "find-input-"));
  try {
    writeFileSync(join(root, "target.csv"), "a,b\n1,2\n");
    writeFileSync(join(root, "unrelated.txt"), "other");
    const tool = FILES_TOOLS.find((tool) => tool.name === "find")!;
    const args = tool.input.parse({ pattern: "target.csv" });
    const result = await tool.execute(args, { workspaceId: "w", workspaceRoot: root, sessionId: "s", agentId: "main", toolCallId: "f", role: "main", signal: new AbortController().signal, reads: createReadTable(), backups: { needsBackup: () => false, ensureBackup: () => undefined, list: () => [], markCreated: () => { throw new Error("unexpected write"); }, backup: () => { throw new Error("unexpected write"); }, trash: () => { throw new Error("unexpected write"); } } });
    expect(result.data).toMatchObject({ total: 1, entries: [{ path: "target.csv" }] });
    expect(tool.input.safeParse({ glob: "a.csv", pattern: "b.csv" }).success).toBe(false);
    expect(tool.input.safeParse({ pattren: "target.csv" }).success).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
