import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { startServer } from "../src/index.ts";

test("OpenAPI 从协议 DTO 提供请求/响应 schema，受设备鉴权保护", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-api-docs-"));
  const server = await startServer({ dataDir, log: () => {} });
  try {
    expect((await fetch(`${server.url}/api/docs`)).status).toBe(401);
    const response = await fetch(`${server.url}/api/docs`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    const spec = await response.json();
    expect(spec).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/sessions": {
          post: {
            requestBody: { content: { "application/json": { schema: expect.any(Object) } } },
          },
          get: {
            responses: {
              "200": { content: { "application/json": { schema: expect.any(Object) } } },
            },
          },
        },
        "/workspaces/{id}/files/manage": { post: expect.any(Object) },
        "/sessions/{id}/agents/{agentId}/messages": { post: expect.any(Object) },
      },
      components: {
        schemas: {
          CreateSessionBody: { properties: { workspaceId: { type: "string" } } },
          HealthResponse: { properties: { ok: { const: true } } },
        },
      },
    });
    expect(JSON.stringify(spec)).not.toContain(server.token);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

test("历史日志分页拒绝非数字、零和负数，避免数据库错误", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-log-query-"));
  const server = await startServer({ dataDir, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    const { session } = await api.createSession({});
    for (const query of ["limit=bad", "limit=0", "limit=-1", "before=-1"]) {
      const response = await fetch(`${server.url}/api/v1/sessions/${session.id}/log?${query}`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(response.status, query).toBe(400);
    }
    expect((await api.getSessionLog(session.id, { limit: 1000 })).items.length).toBeGreaterThan(0);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);
