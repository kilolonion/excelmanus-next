import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES_TOOLS } from "@excelmanus/files";
import {
  BACKUPS_MIGRATION,
  BackupService,
  bindToolAccess,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  runWithToolAccess,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import type { AccessFact } from "@excelmanus/protocol";
import { SandboxPool } from "@excelmanus/sandbox";
import { workbookModule } from "@excelmanus/workbook";
import { afterEach, expect, test } from "vitest";
import { runScriptTool } from "../src/script.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "script-access-facts-"));
  const db = openDb(join(root, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('w','test',?,?)").run(
    root,
    new Date().toISOString(),
  );
  db.exec("CREATE TABLE documents (id TEXT, workspace_id TEXT, path TEXT)");
  mkdirSync(join(root, "allowed"));
  mkdirSync(join(root, "sibling"));
  writeFileSync(join(root, "allowed/report.txt"), "original");
  writeFileSync(join(root, "sibling/report.txt"), "secret");
  const log = new SessionLog(db);
  log.append("s", "main", [
    {
      type: "turn.started",
      data: {
        turnId: "t",
        accessBinding: {
          originAgentId: "main",
          originTurnId: "t",
          sourceDispatchIds: ["d"],
          ruleVersion: 1,
          decision: { kind: "restricted", root: "allowed" },
          accessDeliveryRequired: true,
        },
      },
    },
  ]);
  const access = bindToolAccess({
    db,
    log,
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    turnId: "t",
    toolCallId: "script",
  });
  const backups = new BackupService(db);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    turnId: "t",
    toolCallId: "script",
    role: "main",
    signal: AbortSignal.timeout(30000),
    reads: createReadTable(),
    backups: backups.bind({
      workspaceId: "w",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const sandbox = new SandboxPool({ size: 1 });
  const tool = runScriptTool({
    sandbox,
    tools: new Map(FILES_TOOLS.map((item) => [item.name, item])),
    db,
  });
  cleanups.push(async () => {
    await sandbox.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const facts = () =>
    (
      db.prepare("SELECT data FROM session_log WHERE type='access.fact' ORDER BY seq").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data) as AccessFact);
  const run = (code: string, override: Partial<ToolContext> = {}) =>
    runWithToolAccess(access, () => tool.execute({ code }, { ...ctx, ...override }));
  return { root, db, access, ctx, facts, run, sandbox, tool };
}

test("SDK host callbacks preserve the carrier across the QuickJS worker boundary", async () => {
  const f = fixture();
  const result = await f.run(
    `const result = []; for (const op of [() => files.find({}), () => files.readText({path:'sibling/report.txt'}), () => files.writeText({path:'sibling/report.txt', content:'wrong'})]) { try { await op(); result.push('allowed'); } catch (e) { result.push(e.code); } } return result;`,
  );
  expect(result).toMatchObject({
    status: "ok",
    data: { value: ["INVALID_ARGUMENT", "INVALID_ARGUMENT", "INVALID_ARGUMENT"] },
  });
  expect(readFileSync(join(f.root, "sibling/report.txt"), "utf8")).toBe("secret");
  expect(
    f
      .facts()
      .filter((fact) => fact.outcome === "succeeded")
      .some((fact) => fact.path.startsWith("sibling")),
  ).toBe(false);
}, 30000);

test("successful SDK bytes read remains recorded when the script subsequently fails", async () => {
  const f = fixture();
  expect(
    await f.run(
      `await files.readText({path:'allowed/report.txt'}); throw new Error('after read');`,
    ),
  ).toMatchObject({ status: "error", error: { code: "SANDBOX_ERROR" } });
  expect(f.facts()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "file-bytes",
        path: "allowed/report.txt",
        purpose: "script-read-text",
        outcome: "succeeded",
        sdkCallIndex: 1,
      }),
    ]),
  );
}, 30000);

test("writeText sight and preview reads are facts even when publication is denied", async () => {
  const f = fixture();
  expect(
    await f.run(`await files.writeText({path:'allowed/report.txt',content:'changed'});`, {
      requestApproval: async () => ({ decision: "denied" }),
    }),
  ).toMatchObject({ status: "error", error: { code: "APPROVAL_DENIED" } });
  expect(readFileSync(join(f.root, "allowed/report.txt"), "utf8")).toBe("original");
  for (const purpose of ["script-sight", "script-preview"])
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/report.txt",
          purpose,
          outcome: "succeeded",
        }),
      ]),
    );
}, 30000);

test("published text rollback reads are retained after a later target conflicts", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "allowed/second.txt"), "second original");
  const result = await f.run(
    `await files.writeText({path:'allowed/report.txt',content:'first changed'}); await files.writeText({path:'allowed/second.txt',content:'second changed'});`,
    {
      requestApproval: async () => {
        writeFileSync(join(f.root, "allowed/second.txt"), "external edit");
        return { decision: "approved" };
      },
    },
  );
  expect(result).toMatchObject({
    status: "error",
    error: { code: "VERSION_CONFLICT" },
    data: { rolledBack: ["allowed/report.txt"] },
  });
  expect(readFileSync(join(f.root, "allowed/report.txt"), "utf8")).toBe("original");
  expect(readFileSync(join(f.root, "allowed/second.txt"), "utf8")).toBe("external edit");
  for (const purpose of [
    "script-publish-hash",
    "script-rollback-copy",
    "script-rollback-hash",
    "publish-verify",
  ])
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/report.txt",
          purpose,
          outcome: "succeeded",
        }),
      ]),
    );
  expect(f.facts().some((fact) => fact.path.includes(".excelmanus"))).toBe(false);
}, 30000);

test("a later scope narrowing is rechecked before publication and cannot publish stale SDK targets", async () => {
  const f = fixture();
  mkdirSync(join(f.root, "allowed/sub"));
  const result = await f.run(
    `await files.writeText({path:'allowed/report.txt',content:'changed'});`,
    {
      requestApproval: async () => {
        const log = new SessionLog(f.db);
        log.append("s", "main", [
          {
            type: "turn.access.updated",
            data: {
              turnId: "t",
              accessBinding: {
                ...f.access.binding(),
                decision: { kind: "restricted", root: "allowed/sub" },
              },
            },
          },
        ]);
        return { decision: "approved" };
      },
    },
  );
  expect(result).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
  expect(readFileSync(join(f.root, "allowed/report.txt"), "utf8")).toBe("original");
  expect(
    f
      .facts()
      .some(
        (fact) =>
          fact.kind === "file-write" &&
          fact.path === "allowed/report.txt" &&
          fact.outcome === "succeeded",
      ),
  ).toBe(false);
}, 30000);

test("SDK wb.read and wb.edit use the same carrier for cached docId-only access", async () => {
  const f = fixture();
  f.db.exec("DROP TABLE documents");
  const module = workbookModule(f.db);
  for (const migration of module.migrations ?? []) f.db.exec(migration.sql);
  const documents = module.service;
  cleanups.unshift(async () => documents.close());
  const allowed = await documents.create("w", f.root, "allowed/book.xlsx", "s", "main");
  const denied = await documents.create("w", f.root, "sibling/book.xlsx", "s", "main");
  const tool = runScriptTool({
    sandbox: f.sandbox,
    documents,
    tools: new Map((module.tools ?? []).map((item) => [item.name, item])),
    db: f.db,
  });
  const result = await runWithToolAccess(f.access, () =>
    tool.execute(
      {
        code: `await wb.read({docId:${JSON.stringify(allowed.meta.id)},mode:'overview'}); const errors=[]; for (const call of [() => wb.read({docId:${JSON.stringify(denied.meta.id)},mode:'overview'}), () => wb.edit({docId:${JSON.stringify(denied.meta.id)},ops:[{op:'cells.set',range:'A1',values:[[9]]}]})]) { try { await call(); errors.push('allowed'); } catch (e) { errors.push(e.code); } } return errors;`,
      },
      f.ctx,
    ),
  );
  expect(result).toMatchObject({
    status: "ok",
    data: { value: ["INVALID_ARGUMENT", "INVALID_ARGUMENT"] },
  });
  expect(f.facts()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "document-snapshot",
        path: "allowed/book.xlsx",
        outcome: "succeeded",
      }),
    ]),
  );
  expect(
    f.facts().some((fact) => fact.path === "sibling/book.xlsx" && fact.outcome === "succeeded"),
  ).toBe(false);
}, 30000);

test("finite files: SDK source edit and recalc are rejected before actor revision, output remains writable", async () => {
  const f = fixture();
  f.db.exec("DROP TABLE documents");
  const module = workbookModule(f.db);
  for (const migration of module.migrations ?? []) f.db.exec(migration.sql);
  const documents = module.service;
  cleanups.unshift(async () => documents.close());
  const source = await documents.create("w", f.root, "allowed/source.xlsx", "s", "main");
  const output = await documents.create("w", f.root, "allowed/output.xlsx", "s", "main");
  const before = readFileSync(join(f.root, "allowed/source.xlsx"));
  const snapshot = await documents.snapshot(source.meta.id, f.root);
  const count = () =>
    f.db.prepare("SELECT COUNT(*) AS n FROM doc_ops WHERE doc_id=?").get(source.meta.id);
  const beforeOps = count();
  const log = new SessionLog(f.db);
  log.append("s", "main", [
    {
      type: "user.message",
      data: {
        dispatchId: "finite-sdk",
        clientMessageId: "finite-sdk",
        text: "把 allowed/source.xlsx 另存为 allowed/output.xlsx，只处理这两个文件，不访问或修改其他文件。",
        mode: "steer",
        accessInputOrigin: "user",
      },
    },
  ]);
  const kernel = await import("@excelmanus/kernel");
  const binding = kernel.createTurnAccessBinding(f.db, {
    sessionId: "s",
    agentId: "main",
    turnId: "finite-sdk",
    dispatchIds: ["finite-sdk"],
  });
  log.append("s", "main", [
    { type: "turn.started", data: { turnId: "finite-sdk", accessBinding: binding } },
  ]);
  const access = bindToolAccess({
    db: f.db,
    log,
    workspaceRoot: f.root,
    sessionId: "s",
    agentId: "main",
    turnId: "finite-sdk",
    toolCallId: "sdk-finite",
  });
  const tool = runScriptTool({
    sandbox: f.sandbox,
    documents,
    tools: new Map((module.tools ?? []).map((t) => [t.name, t])),
    db: f.db,
  });
  const run = (code: string) =>
    runWithToolAccess(access, () =>
      tool.execute(
        { code },
        {
          ...f.ctx,
          turnId: "finite-sdk",
          toolCallId: "sdk-finite",
          requestApproval: async () => ({ decision: "approved" }),
        },
      ),
    );
  for (const [ops, dryRun] of [
    [[{ op: "cells.set", range: "A1", values: [[99]] }], false],
    [[{ op: "recalculate" }], false],
    [[{ op: "cells.set", range: "A1", values: [[99]] }], true],
  ] as const) {
    expect
      .soft(
        await run(
          `await wb.edit({docId:${JSON.stringify(source.meta.id)},ops:${JSON.stringify(ops)},dryRun:${dryRun}});`,
        ),
      )
      .toMatchObject({ status: "error" });
    expect.soft(readFileSync(join(f.root, "allowed/source.xlsx"))).toEqual(before);
    expect.soft(await documents.snapshot(source.meta.id, f.root)).toEqual(snapshot);
    expect.soft(count()).toEqual(beforeOps);
  }
  expect(
    await run(
      `await wb.read({docId:${JSON.stringify(source.meta.id)},mode:'overview'}); await wb.edit({docId:${JSON.stringify(output.meta.id)},ops:[{op:'cells.set',range:'A1',values:[[7]]}]});`,
    ),
  ).toMatchObject({ status: "ok" });
  expect(binding.decision.kind).toBe("files");
}, 30000);
