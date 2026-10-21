import { existsSync, linkSync, mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb, pathVersion } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION, DOC_PATH_MOVES_MIGRATION, DOC_OPS_MIGRATION, DOC_OPS_REVERTS_MIGRATION, DOCUMENTS_MIGRATION, DocumentService } from "../src/service.ts";

test.each(["intent", "linked", "unlinked"])("移动中断在 %s 阶段后重开保留文档身份和数据", async (stage) => {
  const root = mkdtempSync(join(tmpdir(), "doc-move-"));
  const db = openDb(join(root, "db.sqlite"), [DOCUMENTS_MIGRATION, DOC_OPS_MIGRATION, BACKUPS_MIGRATION, CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION, DOC_PATH_MOVES_MIGRATION, DOC_OPS_REVERTS_MIGRATION]);
  let svc = new DocumentService(db);
  try {
    writeFileSync(join(root, "before.csv"), "name,count\napple,2\n");
    const { meta } = await svc.open("ws", root, "before.csv");
    const before = await svc.snapshot(meta.id, root);
    await svc.close();
    const row = db.prepare("SELECT checkpoint_hash FROM documents WHERE id=?").get(meta.id)!;
    db.prepare("INSERT INTO doc_moves VALUES (?,?,?,?)").run(meta.id, "before.csv", "folder/after.csv", String(row.checkpoint_hash));
    mkdirSync(join(root, "folder"));
    if (stage !== "intent") linkSync(join(root, "before.csv"), join(root, "folder/after.csv"));
    if (stage === "unlinked") unlinkSync(join(root, "before.csv"));
    svc = new DocumentService(db);
    const after = await svc.snapshot(meta.id, root);
    expect(after.meta.id).toBe(meta.id);
    expect(after.meta.path).toBe(stage === "intent" ? "before.csv" : "folder/after.csv");
    expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
    expect(existsSync(join(root, after.meta.path))).toBe(true);
    expect(existsSync(join(root, "before.csv"))).toBe(stage === "intent");
    expect(db.prepare("SELECT * FROM doc_moves").all()).toHaveLength(0);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("整夹移动保留多个活文档、普通文件及打开文档的身份", async () => {
  const root = mkdtempSync(join(tmpdir(), "doc-folder-"));
  const db = openDb(join(root, "db.sqlite"), [DOCUMENTS_MIGRATION, DOC_OPS_MIGRATION, BACKUPS_MIGRATION, CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION, DOC_PATH_MOVES_MIGRATION, DOC_OPS_REVERTS_MIGRATION]);
  const svc = new DocumentService(db);
  try {
    mkdirSync(join(root, "source/sub"), { recursive: true });
    writeFileSync(join(root, "source/a.csv"), "name,count\napple,2\n");
    writeFileSync(join(root, "source/sub/b.csv"), "name,count\npear,3\n");
    writeFileSync(join(root, "source/note.txt"), "keep me");
    const a = await svc.open("ws", root, "source/a.csv");
    const b = await svc.open("ws", root, "source/sub/b.csv");
    expect(await svc.submit(b.meta.id, root, { baseRev: 0, source: { kind: "agent", id: "test/main" }, sessionId: "test", ops: [{ op: "cells.set", range: "B2", values: [[9]] }] })).toMatchObject({ ok: true });
    expect(await svc.moveFile("ws", root, "source", "target/moved")).not.toBeNull();
    expect(existsSync(join(root, "source"))).toBe(false);
    expect(existsSync(join(root, "target/moved/note.txt"))).toBe(true);
    expect((await svc.snapshot(a.meta.id, root)).meta.path).toBe("target/moved/a.csv");
    const after = await svc.snapshot(b.meta.id, root);
    expect(after.meta.path).toBe("target/moved/sub/b.csv");
    expect(after.meta.rev).toBe(1);
    expect(after.snapshot.sheets.s0?.cellData?.[1]?.[1]?.v).toBe(9);
    expect(db.prepare("SELECT original_path FROM backups WHERE kind='backup'").all()).toContainEqual({ original_path: "target/moved/sub/b.csv" });
    expect((await svc.open("ws", root, "target/moved/a.csv")).meta.id).toBe(a.meta.id);
  } finally { await svc.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});


test.each([false, true])("整夹移动意图在文件系统移动=%s 后重启恢复", async (renamed) => {
  const root = mkdtempSync(join(tmpdir(), "doc-folder-recover-"));
  const db = openDb(join(root, "db.sqlite"), [DOCUMENTS_MIGRATION, DOC_OPS_MIGRATION, BACKUPS_MIGRATION, CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION, DOC_PATH_MOVES_MIGRATION, DOC_OPS_REVERTS_MIGRATION]);
  let svc = new DocumentService(db);
  try {
    mkdirSync(join(root, "资料📁"));
    writeFileSync(join(root, "资料📁/a.csv"), "v\n2\n");
    const { meta } = await svc.open("ws", root, "资料📁/a.csv");
    await svc.close();
    db.prepare("INSERT INTO doc_path_moves VALUES (?,?,?,?,?)").run("test", "ws", "资料📁", "已移动", pathVersion(join(root, "资料📁")));
    if (renamed) renameSync(join(root, "资料📁"), join(root, "已移动"));
    svc = new DocumentService(db);
    expect((await svc.snapshot(meta.id, root)).meta.path).toBe(renamed ? "已移动/a.csv" : "资料📁/a.csv");
    expect(db.prepare("SELECT * FROM doc_path_moves").all()).toHaveLength(0);
  } finally { await svc.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
