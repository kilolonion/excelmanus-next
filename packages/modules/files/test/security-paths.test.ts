import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  type ToolContext,
  type ToolDefinition,
} from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import { afterAll, describe, expect, test } from "vitest";
import { writableFilesModule } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "excelmanus-files-sec-"));
  dirs.push(root);
  const db = openDb(join(root, "test.db"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('ws','t',?,?)").run(
    root,
    new Date().toISOString(),
  );
  const backups = new BackupService(db);
  const ctx: ToolContext = {
    workspaceId: "ws",
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    toolCallId: "call",
    role: "main",
    signal: AbortSignal.timeout(30000),
    reads: createReadTable(),
    backups: backups.bind({
      workspaceId: "ws",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const tools = new Map((writableFilesModule(db, backups).tools ?? []).map((t) => [t.name, t]));
  const run = async (name: string, args: unknown) =>
    (await (tools.get(name) as ToolDefinition<unknown>).execute(args, ctx)) as ToolResult;
  return { root, db, run };
}

describe("files 安全与读取回归", () => {
  test("read：超长单行按字符切片，游标每次前进并能读完（P1-16）", async () => {
    const { root, db, run } = setup();
    const line = "a".repeat(20_000);
    writeFileSync(join(root, "long.txt"), `${line}\nnext`);
    let offset = 1;
    let charOffset: number | undefined;
    let text = "";
    for (let i = 0; i < 5; i++) {
      const r = await run("read", { path: "long.txt", offset, charOffset });
      expect(r.status).toBe("ok");
      const d = r.data as { content: string; nextOffset: number | null; nextCharOffset?: number };
      expect(d.content.length).toBeGreaterThan(0);
      text += d.content;
      if (d.nextOffset === null) break;
      if (d.nextCharOffset === undefined) text += "\n";
      offset = d.nextOffset;
      charOffset = d.nextCharOffset;
    }
    expect(text).toBe(`${line}\nnext`);
    db.close();
  });

  test("已注册工作簿：移动/删除其上级目录被拒绝（P1-18）", async () => {
    const { root, db, run } = setup();
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "sales.xlsx"), "x");
    db.exec("CREATE TABLE documents (id TEXT, workspace_id TEXT, path TEXT)");
    db.prepare("INSERT INTO documents VALUES ('d','ws','data/sales.xlsx')").run();
    for (const ops of [
      [{ op: "move", path: "data", to: "data2" }],
      [{ op: "move", path: "DATA/../data", to: "data3" }],
      [{ op: "delete", path: "data" }],
    ]) {
      const r = await run("files", { ops });
      expect(r.status, JSON.stringify(ops)).toBe("error");
      expect(r.error?.code).toBe("UNSUPPORTED_FEATURE");
    }
    db.close();
  });

  test("read 不能经 Unicode 折叠别名读取 .excelmanus（P0-09）", async () => {
    const { root, db, run } = setup();
    mkdirSync(join(root, ".excelmanus", "tmp"), { recursive: true });
    writeFileSync(join(root, ".excelmanus", "tmp", "probe.txt"), "secret");
    const r = await run("read", { path: ".excelmanuſ/tmp/probe.txt" });
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("NOT_FOUND");
    db.close();
  });
});
