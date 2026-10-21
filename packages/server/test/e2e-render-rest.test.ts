import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("渲染 REST 拒绝跨工作区和旧修订，无界面客户端也可渲染", async () => {
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
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      png: string;
      limitations: string[];
      size: { width: number; height: number };
    };
    expect(JSON.stringify(result)).toContain("png");
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

test("REST screenshot hydrates imported media and renders all four coverage categories", async () => {
  const { writeFileSync } = await import("node:fs");
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const { renderCoverageWorkbook } = await import("./fixtures/render-coverage.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-render-rich-"));
  const server = await startServer({ dataDir, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token),
      ws = (await api.listWorkspaces()).items.find((x) => x.isDefault)!;
    writeFileSync(join(ws.path, "coverage.xlsx"), await renderCoverageWorkbook());
    const { document } = await api.openDoc(ws.id, { path: "coverage.xlsx" });
    const response = await fetch(
      `${server.url}/api/v1/workspaces/${ws.id}/docs/${document.id}/render`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ range: "A1:L20" }),
      },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      png: string;
      limitations: string[];
      size: { width: number; height: number };
    };
    expect(result.limitations.join(" ")).not.toContain("无可读取");
    const png = Buffer.from(result.png, "base64"),
      image = await loadImage(png),
      canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let magenta = 0,
      red = 0,
      green = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 240 && data[i + 1]! < 15 && data[i + 2]! > 240) magenta++;
      if (data[i]! > 240 && data[i + 1]! < 15 && data[i + 2]! < 15) red++;
      if (data[i]! < 60 && data[i + 1]! > 90 && data[i + 2]! < 150) green++;
    }
    if (process.env.QA_RENDER_PATH) {
      writeFileSync(process.env.QA_RENDER_PATH, png);
      console.log({ size: result.size, limitations: result.limitations, magenta, red, green });
    }
    expect(magenta).toBeGreaterThan(1000);
    expect(red).toBeGreaterThan(1000);
    expect(green).toBeGreaterThan(1000);
    if (process.env.QA_RENDER_PATH) writeFileSync(process.env.QA_RENDER_PATH, png);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);
