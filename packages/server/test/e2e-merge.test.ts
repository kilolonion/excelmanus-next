import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("真实 HTTP 对比选择合并、重试冲突和撤销", async () => {
  const dir = mkdtempSync(join(tmpdir(), "http-merge-"));
  const server = await startServer({ dataDir: dir, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    const ws = (await api.listWorkspaces()).items.find((w) => w.isDefault)!;
    writeFileSync(join(ws.path, "left.csv"), "name,amount\nA,2\n");
    writeFileSync(join(ws.path, "right.csv"), "name,amount\nB,9\n");
    const diff = await api.compareDocs(ws.id, {
      left: { path: "left.csv" },
      right: { path: "right.csv" },
    });
    const input = {
      sourceDocId: diff.right.docId,
      targetDocId: diff.left.docId,
      sourceRev: diff.right.rev,
      targetRev: diff.left.rev,
      cells: [{ sheet: diff.sheets[0]!.name, cell: "B2" }],
    };
    const done = await api.mergeDocs(ws.id, input);
    expect(done.rev).toBe(diff.left.rev + 1);
    const after = await api.compareDocs(ws.id, {
      left: { docId: diff.left.docId },
      right: { docId: diff.right.docId },
    });
    expect(after.sheets[0]!.cells.map((c) => c.cell)).toEqual(["A2"]);
    const repeat = await fetch(`${server.url}/api/v1/workspaces/${ws.id}/docs/merge`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(repeat.status).toBe(409);
    await api.undoDocRevision(ws.id, done.docId, done.rev);
    const restored = await api.compareDocs(ws.id, {
      left: { docId: diff.left.docId },
      right: { docId: diff.right.docId },
    });
    expect(restored.sheets[0]!.cells.map((c) => c.cell)).toEqual(["A2", "B2"]);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
