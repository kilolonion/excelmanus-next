import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await api.openDoc(workspace.id, { path: livePath });
  const before = readFileSync(join(root, livePath));
  for (const op of [
    { op: "move", path: livePath, to: "renamed.xlsx" },
    { op: "delete", path: livePath },
  ]) {
    expect((await manage({ ops: [op], confirmed: true })).status).toBe(409);
    expect(readFileSync(join(root, livePath))).toEqual(before);
  }
}, 30000);
