import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { kernelProjections, SessionLog } from "@excelmanus/kernel";
import { createApiClient, type ServerMessage } from "@excelmanus/protocol";
import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type RunningServer, startServer } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "excelmanus-workspace-session-"));
let server: RunningServer | undefined;
let socket: WebSocket | undefined;
afterAll(async () => {
  socket?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

test("真实工作区绑定、空白落点复用、显式新建、分页与重启/投影重建", async () => {
  const dataDir = join(root, "data");
  server = await startServer({ dataDir, log: () => {} });
  let api = createApiClient(server.url, server.token);
  const defaultWorkspace = (await api.listWorkspaces()).items.find(
    (workspace) => workspace.isDefault,
  );
  expect(defaultWorkspace?.path).toBe(join(dataDir, "workspace"));
  const defaultId = defaultWorkspace?.id as string;
  const events: ServerMessage[] = [];
  socket = new WebSocket(
    `${server.url.replace("http:", "ws:")}/api/v1/sync?ticket=${(await api.createTicket()).ticket}`,
  );
  socket.on("message", (data) => events.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket?.once("open", resolve);
    socket?.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "sub", topic: "app" }));
  await expect.poll(() => events.some((event) => event.type === "sub.ok")).toBe(true);

  const landings = await Promise.all(
    Array.from({ length: 3 }, () => api.createSession({ reuseBlank: true })),
  );
  const landingId = landings[0]?.session.id as string;
  expect(new Set(landings.map((landing) => landing.session.id)).size).toBe(1);
  expect(landings.every((landing) => landing.session.workspaceId === defaultId)).toBe(true);
  await expect
    .poll(() =>
      events.some(
        (event) =>
          event.type === "app.event" &&
          event.data.type === "session.created" &&
          event.data.sessionId === landingId,
      ),
    )
    .toBe(true);
  expect((await api.getSessionLog(landingId)).items.map((record) => record.type)).toEqual([
    "session.created",
    "agent.spawned",
  ]);
  const explicit = await api.createSession({});
  expect(explicit.session.id).not.toBe(landingId);
  expect(explicit.session.workspaceId).toBe(defaultId);
  await api.updateSession(landingId, { title: "保留的会话" });
  await api.updateSession(explicit.session.id, { title: "另一条保留会话" });
  const newLanding = await api.createSession({ reuseBlank: true });
  expect([landingId, explicit.session.id]).not.toContain(newLanding.session.id);
  await expect(api.createSession({ workspaceId: "missing" })).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    api.createSession({ reuseBlank: true, title: "不能覆盖已有空白会话" }),
  ).rejects.toMatchObject({ status: 400 });

  const folder = join(root, "reports");
  mkdirSync(folder);
  writeFileSync(join(folder, "only-reports.csv"), "a,b\n1,2\n");
  writeFileSync(join(defaultWorkspace?.path as string, "only-default.csv"), "a\n1\n");
  const { workspace } = await api.addWorkspace(folder, "报表工作区");
  const bound = await api.createSession({ workspaceId: workspace.id, reuseBlank: true });
  expect((await api.getSession(bound.session.id)).session.workspaceId).toBe(workspace.id);
  expect((await api.listFiles(workspace.id)).items.map((file) => file.name)).toEqual([
    "only-reports.csv",
  ]);
  expect((await api.listFiles(defaultId)).items.map((file) => file.name)).toEqual([
    "only-default.csv",
  ]);
  // 超过旧前端默认的 50 条，跨工作区与搜索必须在分页前过滤。
  for (let i = 0; i < 55; i++)
    await api.createSession({ workspaceId: workspace.id, title: `报表-${i}` });
  const first = await api.listSessions({ workspaceId: workspace.id, limit: 50 });
  const second = await api.listSessions({
    workspaceId: workspace.id,
    limit: 50,
    cursor: first.nextCursor,
  });
  expect(first.items.length).toBe(50);
  expect(second.items.length).toBe(6);
  expect(new Set([...first.items, ...second.items].map((session) => session.id)).size).toBe(56);
  expect((await api.listSessions({ workspaceId: defaultId, q: "保留" })).items.length).toBe(2);
  await expect(api.removeWorkspace(workspace.id)).rejects.toMatchObject({ status: 409 });

  socket.close();
  await server.close();
  server = undefined;
  const db = new DatabaseSync(join(dataDir, "excelmanus.db"));
  const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();
  new SessionLog(db, { projections: kernelProjections() }).rebuild();
  expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
  db.close();
  server = await startServer({ dataDir, log: () => {} });
  api = createApiClient(server.url, server.token);
  expect((await api.createSession({ reuseBlank: true })).session.id).toBe(newLanding.session.id);
  expect(
    (await api.createSession({ workspaceId: workspace.id, reuseBlank: true })).session.id,
  ).toBe(bound.session.id);
  await api.deleteSession(bound.session.id);
  expect(
    (await api.createSession({ workspaceId: workspace.id, reuseBlank: true })).session.workspaceId,
  ).toBe(workspace.id);
  expect((await api.listFiles(workspace.id)).items[0]?.name).toBe("only-reports.csv");
}, 30_000);
