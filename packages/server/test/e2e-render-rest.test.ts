import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("渲染 REST 拒绝跨工作区和旧修订，无渲染端明确报错", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-render-rest-"));
  const server = await startServer({ dataDir, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    const ws = (await api.listWorkspaces()).items.find((item) => item.isDefault)!;
    copyFileSync(
      new URL("../../../samples/sales.xlsx", import.meta.url),
      join(ws.path, "sales.xlsx"),
    );
    const { document } = await api.openDoc(ws.id, { path: "sales.xlsx" });
    const render = (workspace: string, body: unknown) =>
      fetch(`${server.url}/api/v1/workspaces/${workspace}/docs/${document.id}/render`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await render("wrong-workspace", {})).status).toBe(404);
    expect((await render(ws.id, { rev: 999 })).status).toBe(409);
    const response = await render(ws.id, { range: "A1:D5" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "bad_gateway" } });
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);
