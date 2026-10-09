// 本机浏览器登录链路：真实 HTTP + SQLite；验证令牌不需要出现在 URL 或前端请求头中。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@excelmanus/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("browser authentication", () => {
  test("establishes and clears an HttpOnly session without exposing a token URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-auth-"));
    dirs.push(dataDir);
    const server = await startServer({ dataDir, log: () => {} });
    servers.push(server);
    const origin = server.url;
    const endpoint = `${server.url}/api/v1`;

    const rejected = await fetch(`${endpoint}/bootstrap`, { headers: { origin } });
    expect(rejected.status).toBe(401);

    const noOrigin = await fetch(`${endpoint}/auth/session`, { method: "POST" });
    expect(noOrigin.status).toBe(403);

    const login = await fetch(`${endpoint}/auth/session`, {
      method: "POST",
      headers: { origin },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toMatch(
      /^excelmanus_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/,
    );
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const boot = await fetch(`${endpoint}/bootstrap`, {
      headers: { cookie: cookie as string, origin },
    });
    expect(boot.status).toBe(200);
    expect((await boot.json()) as { shape: string }).toHaveProperty("shape", "local-web");

    const ticket = await fetch(`${endpoint}/sync/ticket`, {
      method: "POST",
      headers: { cookie: cookie as string, origin },
    });
    expect(ticket.status).toBe(200);
    expect((await ticket.json()) as { ticket: string }).toHaveProperty("ticket");

    // Node 没有浏览器 Cookie jar：仅补上已登录 Cookie，仍请求真实后端。
    const browserFetch: typeof fetch = (input, init) => {
      expect(init?.credentials).toBe("include");
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      headers.set("cookie", cookie as string);
      headers.set("origin", origin);
      return fetch(input, { ...init, headers });
    };
    const api = createApiClient(server.url, null, browserFetch);
    const { items } = await api.listWorkspaces();
    const workspace = items.find((w) => w.isDefault);
    expect(workspace).toBeDefined();
    const file = await api.uploadFile(workspace?.id as string, {
      name: "browser.csv",
      data: new Blob(["a,b\n1,2\n"]),
    });
    expect(await (await api.downloadFile(workspace?.id as string, file.path)).text()).toBe(
      "a,b\n1,2\n",
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const image = await api.uploadAttachment({ name: "pixel.png", data: new Blob([png]) });
    expect(Buffer.from(await (await api.getAttachment(image.sha256)).arrayBuffer())).toEqual(png);

    const logout = await fetch(`${endpoint}/auth/logout`, {
      method: "POST",
      headers: { cookie: cookie as string, origin },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
