import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolResult } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { capToolOutput } from "../src/projections.ts";
import { pageResult } from "../src/result-pages.ts";

test("结果分页可完整拼回原结果；会话、代理与工具隔离，非法游标不泄漏数据", () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-result-pages-"));
  const db = new DatabaseSync(join(dir, "page.sqlite"));
  try {
    db.exec(
      "CREATE TABLE session_log(session_id TEXT, agent_id TEXT, seq INTEGER, type TEXT, data TEXT)",
    );
    const result: ToolResult = { status: "ok", data: { content: '数据\\"\n'.repeat(10000) } };
    db.prepare("INSERT INTO session_log VALUES (?, ?, ?, ?, ?)").run(
      "s1",
      "main",
      7,
      "tool.result",
      JSON.stringify({ toolName: "run_script", result }),
    );
    const first = capToolOutput(result, 7);
    let cursor = first.truncated?.cursor;
    let text = (first.data as { preview: string }).preview;
    expect(cursor).toBeDefined();
    for (const [session, agent, name, value] of [
      ["s2", "main", "run_script", cursor],
      ["s1", "child", "run_script", cursor],
      ["s1", "main", "write", cursor],
      ["s1", "main", "run_script", "result:7:-1"],
      ["s1", "main", "run_script", "result:7:999999999"],
    ])
      expect(pageResult(db, session!, agent!, name!, value!).status).toBe("error");
    while (cursor) {
      const page = pageResult(db, "s1", "main", "run_script", cursor);
      expect(page.status).toBe("ok");
      expect(JSON.stringify(page).length).toBeLessThan(16000);
      text += (page.data as { chunk: string }).chunk;
      cursor = page.truncated?.cursor;
    }
    expect(JSON.parse(text)).toEqual(result);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
