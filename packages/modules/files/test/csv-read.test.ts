import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTable, type ToolContext } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { FILES_TOOLS } from "../src/tools.ts";

test("CSV read returns complete small input and supports bounded continuation without losing identifiers", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-read-"));
  try {
    const text = "编号,金额\n001,10\n002,20\n003,30\n004,40\n005,\n006,60\n";
    writeFileSync(join(root, "data.csv"), text);
    const tool = FILES_TOOLS.find((t) => t.name === "read");
    if (!tool) throw new Error("read tool missing");
    const ctx = {
      workspaceId: "w",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
      toolCallId: "r",
      role: "main",
      signal: new AbortController().signal,
      reads: createReadTable(),
    } as ToolContext;
    const whole = await tool.execute(tool.input.parse({ path: "data.csv" }), ctx);
    expect(whole).toMatchObject({
      status: "ok",
      data: { kind: "csv", content: text, truncated: false, nextOffset: null },
    });
    expect(whole.versions?.["data.csv"]).toMatch(/^[a-f0-9]{64}$/);
    const first = await tool.execute(tool.input.parse({ path: "data.csv", limit: 3 }), ctx);
    expect(first.data).toMatchObject({
      content: "编号,金额\n001,10\n002,20",
      truncated: true,
      nextOffset: 4,
    });
    const rest = await tool.execute(tool.input.parse({ path: "data.csv", offset: 4 }), ctx);
    expect(rest.data).toMatchObject({
      content: "003,30\n004,40\n005,\n006,60\n",
      truncated: false,
    });
    writeFileSync(join(root, "long.tsv"), `001\t${"甲".repeat(18000)}`);
    const long = await tool.execute(tool.input.parse({ path: "long.tsv" }), ctx);
    expect(long.data).toMatchObject({
      kind: "csv",
      truncated: true,
      nextOffset: 1,
      nextCharOffset: 16000,
    });
    const tail = await tool.execute(
      tool.input.parse({ path: "long.tsv", offset: 1, charOffset: 16000 }),
      ctx,
    );
    expect(
      (long.data as { content: string }).content + (tail.data as { content: string }).content,
    ).toBe(`001\t${"甲".repeat(18000)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
