import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  sha256,
  type ToolContext,
} from "@excelmanus/kernel";
import { afterAll, describe, expect, test } from "vitest";
import { mutationTools } from "../src/mutations.ts";

const dirs: string[] = [];
const dbs: Array<ReturnType<typeof openDb>> = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "m2b-files-"));
  dirs.push(root);
  const db = openDb(join(root, "test.db"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  dbs.push(db);
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES (?,?,?,?)").run(
    "ws",
    "test",
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
  const tools = new Map(mutationTools(backups).map((t) => [t.name, t]));
  return { root, db, backups, ctx, tools };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("M2b text/files with real filesystem and SQLite", () => {
  test("version guard + exact replacements + once/session backup + same-session new file exclusion + recovery hashes", async () => {
    const { root, ctx, tools, db } = setup();
    writeFileSync(join(root, "a.txt"), "alpha alpha\n");
    const write = tools.get("write");
    const edit = tools.get("edit");
    if (!write || !edit) throw new Error();
    expect(await write.execute({ path: "a.txt", content: "wrong" }, ctx)).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
    expect(db.prepare("SELECT COUNT(*) n FROM backups").get()).toMatchObject({ n: 0 });
    const args = {
      path: "a.txt",
      content: "beta\n",
      expectedVersion: sha256(Buffer.from("alpha alpha\n")),
    };
    const meta = write.intentMeta?.(args, ctx);
    expect(
      write.recover?.({ sessionId: "s", agentId: "main", toolCallId: "x", args, intentMeta: meta }),
    ).toMatchObject({ status: "not_executed" });
    const result = await write.execute(args, ctx);
    expect(result).toMatchObject({ status: "ok" });
    expect(
      write.recover?.({ sessionId: "s", agentId: "main", toolCallId: "x", args, intentMeta: meta }),
    ).toMatchObject({ status: "uncertain" });
    const backup = (result.data as { backupPath: string }).backupPath;
    expect(readFileSync(join(root, backup), "utf8")).toBe("alpha alpha\n");
    expect(
      await edit.execute(
        {
          path: "a.txt",
          expectedVersion: sha256(Buffer.from("beta\n")),
          edits: [{ oldText: "missing", newText: "x" }],
        },
        ctx,
      ),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(
      await edit.execute(
        {
          path: "a.txt",
          expectedVersion: sha256(Buffer.from("beta\n")),
          edits: [{ oldText: "beta", newText: "gamma" }],
        },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    expect(db.prepare("SELECT COUNT(*) n FROM backups WHERE kind='backup'").get()).toMatchObject({
      n: 1,
    });
    expect(await write.execute({ path: "nested/new.txt", content: "new" }, ctx)).toMatchObject({
      status: "ok",
    });
    expect(
      await write.execute(
        { path: "nested/new.txt", content: "newer", expectedVersion: sha256(Buffer.from("new")) },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM backups WHERE original_path='nested/new.txt' AND kind='backup'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
    expect(await write.execute({ path: "book.xlsx", content: "bad" }, ctx)).toMatchObject({
      status: "error",
      error: { code: "UNSUPPORTED_FEATURE" },
    });
  });

  test("whole-batch preflight, execution rollback, directories, approved trash and backup listing", async () => {
    const { root, ctx, tools } = setup();
    const files = tools.get("files");
    if (!files) throw new Error();
    writeFileSync(join(root, "a.txt"), "a");
    expect(
      await files.execute(
        {
          ops: [
            { op: "copy", path: "a.txt", to: "copy.txt" },
            { op: "move", path: "missing", to: "out.txt" },
          ],
        },
        ctx,
      ),
    ).toMatchObject({ status: "error" });
    expect(existsSync(join(root, "copy.txt"))).toBe(false);
    // A real filesystem boundary rejects a destination whose parent is a regular file;
    // the earlier copy must be rolled back, without faking any product implementation.
    writeFileSync(join(root, "blocked"), "regular file");
    expect(
      await files.execute(
        {
          ops: [
            { op: "copy", path: "a.txt", to: "first.txt" },
            { op: "copy", path: "a.txt", to: "blocked/out.txt" },
          ],
        },
        ctx,
      ),
    ).toMatchObject({ status: "error" });
    expect(existsSync(join(root, "first.txt"))).toBe(false);
    expect(await files.execute({ ops: [{ op: "mkdir", path: "new-dir" }] }, ctx)).toMatchObject({
      status: "ok",
    });
    writeFileSync(join(root, "new-dir", "note.txt"), "content");
    expect(
      await files.execute({ ops: [{ op: "copy", path: "new-dir", to: "copy-dir" }] }, ctx),
    ).toMatchObject({ status: "ok" });
    expect(readFileSync(join(root, "copy-dir", "note.txt"), "utf8")).toBe("content");
    expect(
      await files.execute({ ops: [{ op: "move", path: "copy-dir", to: "moved-dir" }] }, ctx),
    ).toMatchObject({ status: "ok" });
    expect(await files.execute({ ops: [{ op: "delete", path: "a.txt" }] }, ctx)).toMatchObject({
      status: "error",
      error: { code: "APPROVAL_DENIED" },
    });
    expect(existsSync(join(root, "a.txt"))).toBe(true);
    const deleted = await files.execute(
      { ops: [{ op: "delete", path: "a.txt" }] },
      { ...ctx, destructiveApproved: true },
    );
    expect(deleted.status).toBe("ok");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    const trash = (deleted.data as { results: Array<{ trashPath: string }> }).results[0]?.trashPath;
    expect(readFileSync(join(root, trash ?? ""), "utf8")).toBe("a");
    expect(await files.execute({ ops: [{ op: "backup", list: true }] }, ctx)).toMatchObject({
      status: "ok",
    });
  });

  test("internal and external symlink paths reject; prune keeps 20 recent backups and removes old entries", async () => {
    const { root, ctx, tools, db, backups } = setup();
    const write = tools.get("write");
    if (!write) throw new Error();
    const out = mkdtempSync(join(tmpdir(), "m2b-outside-"));
    dirs.push(out);
    symlinkSync(out, join(root, "outside"));
    expect(await write.execute({ path: "outside/x.txt", content: "x" }, ctx)).toMatchObject({
      status: "error",
      error: { code: "OUT_OF_WORKSPACE" },
    });
    expect(await write.execute({ path: ".excelmanus/x.txt", content: "x" }, ctx)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND" },
    });
    writeFileSync(join(root, "a.txt"), "backup");
    for (let i = 0; i < 22; i++) ctx.backups.backup("a.txt");
    writeFileSync(join(root, "old.txt"), "old");
    const old = ctx.backups.backup("old.txt");
    db.prepare("UPDATE backups SET created_at=? WHERE id=?").run(
      "2000-01-01T00:00:00.000Z",
      old.id,
    );
    backups.pruneBackups("ws", root);
    expect(
      db.prepare("SELECT COUNT(*) n FROM backups WHERE original_path='a.txt'").get(),
    ).toMatchObject({ n: 20 });
    expect(
      db.prepare("SELECT COUNT(*) n FROM backups WHERE original_path='old.txt'").get(),
    ).toMatchObject({ n: 0 });
    expect(existsSync(join(root, old.backupPath))).toBe(false);
    const unsafe = mkdtempSync(join(tmpdir(), "m2b-internal-"));
    dirs.push(unsafe);
    mkdirSync(join(unsafe, "safe"));
    symlinkSync(out, join(unsafe, ".excelmanus"));
    const unsafeCtx = {
      ...ctx,
      workspaceRoot: unsafe,
      backups: backups.bind({
        workspaceId: "other",
        workspaceRoot: unsafe,
        sessionId: "s",
        agentId: "main",
      }),
    };
    expect(await write.execute({ path: "safe/x.txt", content: "x" }, unsafeCtx)).toMatchObject({
      status: "error",
      error: { code: "OUT_OF_WORKSPACE" },
    });
    expect(existsSync(join(out, "tmp"))).toBe(false);
  });
});
