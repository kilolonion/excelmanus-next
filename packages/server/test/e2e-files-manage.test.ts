import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApiClient } from "@excelmanus/protocol";
import { afterAll, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("文件管理经真实 HTTP 复用备份和路径守卫，删除须明确确认且可恢复", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-manage-"));
  dirs.push(dataDir);
  const server = await startServer({ dataDir, log: () => {} });
  servers.push(server);
  const api = createApiClient(server.url, server.token);
  const { items: workspaces } = await api.listWorkspaces();
  const workspace = workspaces.find((item) => item.isDefault)!;
  const root = workspace.path;
  const manage = (body: unknown) =>
    fetch(`${server.url}/api/v1/workspaces/${workspace.id}/files/manage`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await manage({ ops: [{ op: "mkdir", path: "reports" }] })).status).toBe(200);
  expect(existsSync(join(root, "reports"))).toBe(true);
  const upload = await api.uploadFile(workspace.id, {
    name: "uploaded.txt",
    data: new Blob(["uploaded"]),
    path: "reports",
  });
  expect(upload.path).toBe("reports/uploaded.txt");
  expect(readFileSync(join(root, upload.path), "utf8")).toBe("uploaded");
  writeFileSync(join(root, "source.txt"), "original");
  expect(
    (await manage({ ops: [{ op: "move", path: "source.txt", to: "reports/renamed.txt" }] })).status,
  ).toBe(200);
  expect(readFileSync(join(root, "reports/renamed.txt"), "utf8")).toBe("original");
  expect(
    (await api.listBackups(workspace.id, "backups")).items.some(
      (b) => b.originalPath === "source.txt",
    ),
  ).toBe(true);
  expect((await manage({ ops: [{ op: "mkdir", path: "../outside" }] })).status).toBe(403);
  expect((await manage({ ops: [{ op: "mkdir", path: ".excelmanus/hidden" }] })).status).toBe(404);
  expect((await manage({ ops: [{ op: "delete", path: "reports/renamed.txt" }] })).status).toBe(403);
  expect(existsSync(join(root, "reports/renamed.txt"))).toBe(true);
  expect(
    (await manage({ confirmed: true, ops: [{ op: "delete", path: "reports/renamed.txt" }] }))
      .status,
  ).toBe(200);
  expect(existsSync(join(root, "reports/renamed.txt"))).toBe(false);
  const trash = (await api.listBackups(workspace.id, "trash")).items;
  expect(trash).toHaveLength(1);
  await api.restoreBackup(workspace.id, "trash", trash[0]!.id);
  expect(readFileSync(join(root, "reports/renamed.txt"), "utf8")).toBe("original");
  expect((await manage({ ops: [{ op: "mkdir", path: "reports" }] })).status).toBe(409);
  expect(
    (
      await manage({
        ops: [
          { op: "mkdir", path: "should-not-exist" },
          { op: "move", path: "missing", to: "new" },
        ],
      })
    ).status,
  ).toBe(404);
  expect(existsSync(join(root, "should-not-exist"))).toBe(false);
  const sample = (await api.listSamples()).items.find((name) => name.endsWith(".xlsx"));
  expect(sample).toBeDefined();
  const { path: livePath } = await api.addSample(workspace.id, sample!);
  const { document: liveDoc } = await api.openDoc(workspace.id, { path: livePath });
  const before = readFileSync(join(root, livePath));
  expect(
    (await manage({ ops: [{ op: "move", path: livePath, to: "renamed.xlsx" }], confirmed: true }))
      .status,
  ).toBe(200);
  expect(existsSync(join(root, livePath))).toBe(false);
  expect(readFileSync(join(root, "renamed.xlsx"))).toEqual(before);
  expect((await api.getDocSnapshot(workspace.id, liveDoc.id)).document.path).toBe("renamed.xlsx");
  expect(
    (await manage({ ops: [{ op: "delete", path: "renamed.xlsx" }], confirmed: true })).status,
  ).toBe(409);
  expect(readFileSync(join(root, "renamed.xlsx"))).toEqual(before);
  expect(
    (await manage({ ops: [{ op: "move", path: "renamed.xlsx", to: "reports/live.xlsx" }] })).status,
  ).toBe(200);
  expect((await manage({ ops: [{ op: "move", path: "reports", to: "archive" }] })).status).toBe(
    200,
  );
  expect((await api.getDocSnapshot(workspace.id, liveDoc.id)).document.path).toBe(
    "archive/live.xlsx",
  );
  expect(readFileSync(join(root, "archive/live.xlsx"))).toEqual(before);
  expect(existsSync(join(root, "archive/uploaded.txt"))).toBe(true);
  expect(
    (await manage({ ops: [{ op: "move", path: "archive", to: "archive/inside" }] })).status,
  ).toBe(400);
  expect(existsSync(join(root, "archive/live.xlsx"))).toBe(true);
}, 30000);

test("含活文档的混合文件批次：后段 SQLite 失败时整批回滚，成功时一起提交", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-batch-"));
  dirs.push(dataDir);
  const server = await startServer({ dataDir, log: () => {} });
  servers.push(server);
  const api = createApiClient(server.url, server.token);
  const workspace = (await api.listWorkspaces()).items.find((w) => w.isDefault)!;
  const root = workspace.path;
  writeFileSync(join(root, "a.csv"), "name,n\nA,2\n");
  writeFileSync(join(root, "note.txt"), "note");
  writeFileSync(join(root, "trash.txt"), "recover");
  const { document } = await api.openDoc(workspace.id, { path: "a.csv" });
  const db = new DatabaseSync(join(dataDir, "excelmanus.db"));
  try {
    db.exec(
      "CREATE TRIGGER reject_batch BEFORE UPDATE OF path ON documents WHEN NEW.path <> OLD.path BEGIN SELECT RAISE(ABORT, 'test late metadata failure'); END",
    );
    const body = {
      confirmed: true,
      ops: [
        { op: "move", path: "a.csv", to: "renamed/a.csv" },
        { op: "copy", path: "note.txt", to: "copied.txt" },
        { op: "mkdir", path: "made" },
        { op: "delete", path: "trash.txt" },
      ],
    };
    const request = () =>
      fetch(`${server.url}/api/v1/workspaces/${workspace.id}/files/manage`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await request()).status).toBe(500);
    expect(existsSync(join(root, "a.csv"))).toBe(true);
    expect(existsSync(join(root, "renamed"))).toBe(false);
    expect(existsSync(join(root, "copied.txt"))).toBe(false);
    expect(existsSync(join(root, "made"))).toBe(false);
    expect(readFileSync(join(root, "trash.txt"), "utf8")).toBe("recover");
    expect((await api.getDocSnapshot(workspace.id, document.id)).document.path).toBe("a.csv");
    db.exec("DROP TRIGGER reject_batch");
    expect((await request()).status).toBe(200);
    expect(existsSync(join(root, "a.csv"))).toBe(false);
    expect((await api.getDocSnapshot(workspace.id, document.id)).document.path).toBe(
      "renamed/a.csv",
    );
    expect(readFileSync(join(root, "copied.txt"), "utf8")).toBe("note");
    expect(existsSync(join(root, "made"))).toBe(true);
    expect(existsSync(join(root, "trash.txt"))).toBe(false);
    expect(db.prepare("SELECT * FROM file_batches").all()).toHaveLength(0);
  } finally {
    db.close();
  }
}, 30000);
