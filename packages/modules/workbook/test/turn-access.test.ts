import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  runWithToolAccess,
  SessionLog,
  type ToolAccessContext,
  type ToolContext,
} from "@excelmanus/kernel";
import { unzipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import { workbookExportTool } from "../src/export.ts";
import { workbookRenderTool } from "../src/render.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOC_PATH_MOVES_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";

const io = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; path: string }> }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      io.calls.push({ kind: "read", path: String(args[0]) });
      return fs.readFileSync(...args);
    },
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      io.calls.push({ kind: "stat", path: String(args[0]) });
      return fs.statSync(...args);
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      io.calls.push({ kind: "lstat", path: String(args[0]) });
      return fs.lstatSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      io.calls.push({ kind: "list", path: String(args[0]) });
      return fs.readdirSync(...args);
    },
  };
});
const fixture = Buffer.from(
  readFileSync(new URL("./fixtures/pivot-slicer.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
function setup() {
  const root = mkdtempSync(join(tmpdir(), "workbook-access-"));
  mkdirSync(join(root, "allowed"));
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "allowed/book.xlsx"), fixture);
  writeFileSync(join(root, "other/book.xlsx"), fixture);
  symlinkSync(join(root, "other"), join(root, "allowed/link"), "dir");
  const db = openDb(join(root, "test.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_PATH_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('w','w',?,1,0,'2026-10-21T00:00:00.000Z')",
  ).run(root);
  const svc = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: root,
    agentId: "main",
    sessionId: "s",
    toolCallId: "read",
    role: "main",
    signal: AbortSignal.timeout(60000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
    }),
  };
  return {
    root,
    db,
    svc,
    ctx,
    read: workbookTools(svc).find((t) => t.name === "workbook_read")!,
    analyze: workbookTools(svc).find((t) => t.name === "workbook_analyze")!,
    async close() {
      await svc.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function access(t: ReturnType<typeof setup>, origin = "origin"): ToolAccessContext {
  return {
    db: t.db,
    log: new SessionLog(t.db),
    workspaceRoot: t.root,
    sessionId: "s",
    agentId: "main",
    turnId: origin,
    toolCallId: "call",
    originAgentId: "main",
    originTurnId: origin,
    auditFailed: false,
    binding: () => ({
      originAgentId: "main",
      originTurnId: origin,
      sourceDispatchIds: [],
      ruleVersion: 1,
      decision: { kind: "restricted", root: "allowed" },
      accessDeliveryRequired: true,
    }),
  };
}
async function restricted<T>(t: ReturnType<typeof setup>, run: () => T | Promise<T>): Promise<T> {
  return runWithToolAccess(access(t), run);
}
const forbiddenIo = (root: string) =>
  io.calls.filter((c) => c.path === join(root, "other") || c.path.startsWith(join(root, "other/")));

test("outside path, traversal and same-basename alias reject before forbidden metadata or bytes", async () => {
  const t = setup();
  try {
    for (const path of [
      "other/book.xlsx",
      "allowed/../other/book.xlsx",
      "allowed/link/book.xlsx",
    ]) {
      io.calls = [];
      const result = await restricted(t, () => t.read.execute({ path, mode: "overview" }, t.ctx));
      expect(result.status).toBe("error");
      expect(forbiddenIo(t.root)).toEqual([]);
    }
  } finally {
    await t.close();
  }
});

test("cached docId and misleading allowed path cannot bypass the directory root", async () => {
  const t = setup();
  try {
    const outside = await t.svc.open("w", t.root, "other/book.xlsx");
    for (const extra of [{}, { path: "allowed/book.xlsx" }]) {
      io.calls = [];
      const result = await restricted(t, () =>
        t.read.execute({ docId: outside.meta.id, mode: "range", range: "A1:E2", ...extra }, t.ctx),
      );
      expect(result.status).toBe("error");
      expect(forbiddenIo(t.root)).toEqual([]);
    }
    io.calls = [];
    await expect(restricted(t, () => t.svc.snapshot(outside.meta.id, t.root))).rejects.toThrow();
    expect(forbiddenIo(t.root)).toEqual([]);
  } finally {
    await t.close();
  }
});

test("analyze right and SQL sources cannot read an outside workbook", async () => {
  const t = setup();
  try {
    for (const args of [
      { mode: "diff", right: { path: "other/book.xlsx", range: "A1:E10" } },
      {
        mode: "sql",
        sql: "SELECT * FROM other",
        sources: [{ name: "other", path: "other/book.xlsx", range: "A1:E10" }],
      },
    ]) {
      io.calls = [];
      const result = await restricted(t, () =>
        t.analyze.execute({ path: "allowed/book.xlsx", range: "A1:E10", ...args }, t.ctx),
      );
      expect(result.status).toBe("error");
      expect(forbiddenIo(t.root)).toEqual([]);
    }
  } finally {
    await t.close();
  }
});

test("export source, destination and render docId are checked before source actor reads", async () => {
  const t = setup();
  try {
    const outside = await t.svc.open("w", t.root, "other/book.xlsx");
    const exp = workbookExportTool(t.svc);
    for (const args of [
      { docId: outside.meta.id, to: "allowed/out.xlsx", mode: "convert" },
      { path: "allowed/book.xlsx", to: "other/out.xlsx", mode: "convert" },
    ]) {
      io.calls = [];
      const result = await restricted(t, () => exp.execute(args, t.ctx));
      expect(result.status).toBe("error");
      expect(forbiddenIo(t.root)).toEqual([]);
      expect(io.calls.filter((c) => c.kind === "read" && c.path.endsWith("book.xlsx"))).toEqual([]);
    }
    const render = vi.fn(async () => "png");
    io.calls = [];
    await expect(
      restricted(t, () =>
        workbookRenderTool(t.svc, render).execute({ docId: outside.meta.id }, t.ctx),
      ),
    ).rejects.toThrow();
    expect(render).not.toHaveBeenCalled();
    expect(forbiddenIo(t.root)).toEqual([]);
  } finally {
    await t.close();
  }
});

test("edit image source guard runs before bytes and before workbook mutation", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.root, "other/image.png"), Buffer.from([137, 80, 78, 71]));
    const opened = await t.svc.open("w", t.root, "allowed/book.xlsx");
    io.calls = [];
    const result = await restricted(t, () =>
      workbookEditTool(t.svc).execute(
        {
          docId: opened.meta.id,
          ops: [
            {
              op: "image.add",
              sheet: "Sheet1",
              path: "other/image.png",
              anchor: "N1",
              width: 10,
              height: 10,
            },
          ],
        },
        t.ctx,
      ),
    );
    expect(result.status).toBe("error");
    expect(forbiddenIo(t.root)).toEqual([]);
    expect(t.svc.headRev(opened.meta.id)).toBe(0);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM doc_ops").get()).toEqual({ n: 0 });
  } finally {
    await t.close();
  }
});

test("pending workspace-wide recovery blocks a restricted open without probing unrelated paths", async () => {
  const t = setup();
  try {
    const outside = await t.svc.open("w", t.root, "other/book.xlsx");
    t.db
      .prepare("INSERT INTO doc_moves (doc_id,from_path,to_path,hash) VALUES (?,?,?,?)")
      .run(
        outside.meta.id,
        "other/book.xlsx",
        "other/moved.xlsx",
        createHash("sha256").update(fixture).digest("hex"),
      );
    io.calls = [];
    const result = await restricted(t, () =>
      t.read.execute({ path: "allowed/book.xlsx", mode: "overview" }, t.ctx),
    );
    expect(result.status).toBe("error");
    expect(forbiddenIo(t.root)).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM doc_moves").get()).toEqual({ n: 1 });
    t.db.exec("DELETE FROM doc_moves");
  } finally {
    await t.close();
  }
});

const facts = (t: ReturnType<typeof setup>) =>
  t.db
    .prepare("SELECT data FROM session_log WHERE type='access.fact' ORDER BY seq")
    .all()
    .map(
      (row) =>
        JSON.parse(String(row.data)) as {
          kind: string;
          path: string;
          outcome: string;
          originTurnId: string;
          purpose?: string;
        },
    );
test("allowed reads succeed with separate disk bytes, actor snapshot and cached package facts", async () => {
  const t = setup();
  try {
    const result = await restricted(t, () =>
      t.read.execute({ path: "allowed/book.xlsx", mode: "objects" }, t.ctx),
    );
    expect(result.status).toBe("ok");
    const seen = facts(t).filter((f) => f.outcome === "succeeded");
    expect(seen.some((f) => f.kind === "file-bytes" && f.path === "allowed/book.xlsx")).toBe(true);
    expect(seen.some((f) => f.kind === "document-snapshot" && f.path === "allowed/book.xlsx")).toBe(
      true,
    );
    expect(
      seen.some((f) => f.kind === "package-cache-parse" && f.purpose !== "decode-opened-bytes"),
    ).toBe(true);
    expect(seen.some((f) => f.kind === "external-target-fetch")).toBe(false);
    const doc = (result.data as { docId: string }).docId;
    const before = facts(t).length;
    io.calls = [];
    await restricted(t, () => t.svc.snapshot(doc, t.root));
    expect(
      facts(t)
        .slice(before)
        .some((f) => f.kind === "document-snapshot"),
    ).toBe(true);
    expect(
      facts(t)
        .slice(before)
        .some((f) => f.kind === "file-bytes"),
    ).toBe(false);
    expect(io.calls.filter((c) => c.kind === "read" && c.path.endsWith("book.xlsx"))).toEqual([]);
  } finally {
    await t.close();
  }
});

async function plain(t: ReturnType<typeof setup>) {
  t.svc.createEmpty(t.root, "allowed/plain.xlsx");
  return (await t.svc.open("w", t.root, "allowed/plain.xlsx")).meta.id;
}
function submit(t: ReturnType<typeof setup>, docId: string, value: number) {
  return t.svc.submit(docId, t.root, {
    baseRev: t.svc.headRev(docId),
    source: { kind: "agent", id: "main" },
    sessionId: "s",
    ops: [{ op: "cells.set", range: "A1", values: [[value]] }],
  });
}
type InternalService = {
  doCheckpoint(entry: unknown): Promise<void>;
  schedule(entry: unknown, delay: number): void;
};

test("scoped submission waits for saved revision and an empty automatic timer does no later I/O", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      a = access(t, "a"),
      b = access(t, "b");
    const result = await runWithToolAccess(a, () => submit(t, id, 7));
    expect(result.ok).toBe(true);
    const entry = await t.svc.entry(id, t.root);
    expect(entry.checkpointRev).toBe(entry.meta.rev);
    expect(
      facts(t).some(
        (f) => f.kind === "file-write" && f.outcome === "succeeded" && f.originTurnId === "a",
      ),
    ).toBe(true);
    const before = facts(t).length;
    runWithToolAccess(b, () => (t.svc as unknown as InternalService).schedule(entry, 0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(facts(t).slice(before)).toEqual([]);
    // Explicit checkpoints still inspect the source, even at an unchanged revision.
    await runWithToolAccess(b, () => t.svc.checkpoint(id, t.root));
    expect(
      facts(t)
        .slice(before)
        .some((f) => f.kind === "file-bytes" && f.originTurnId === "b"),
    ).toBe(true);
  } finally {
    await t.close();
  }
});

test("failed save retains its origin across timer replacement and the next origin flushes it first", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      a = access(t, "a"),
      b = access(t, "b");
    const internals = t.svc as unknown as InternalService;
    vi.spyOn(internals, "doCheckpoint").mockRejectedValueOnce(new Error("test save failure"));
    const first = await runWithToolAccess(a, () => submit(t, id, 7));
    expect(first.ok).toBe(false);
    expect(t.svc.headRev(id)).toBe(1);
    const entry = await t.svc.entry(id, t.root);
    runWithToolAccess(b, () => internals.schedule(entry, 60_000));
    const second = await runWithToolAccess(b, () => submit(t, id, 8));
    expect(second.ok).toBe(true);
    expect(t.svc.headRev(id)).toBe(2);
    expect(entry.checkpointRev).toBe(2);
    const writes = facts(t).filter(
      (f) =>
        f.kind === "file-write" &&
        f.outcome === "succeeded" &&
        f.path === "allowed/plain.xlsx" &&
        f.purpose === "publish",
    );
    expect(writes.map((f) => f.originTurnId)).toEqual(["a", "b"]);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});

test("scope narrowing of a failed pending origin prevents both another task and unscoped UI from overwriting it", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      a = access(t, "a"),
      b = access(t, "b"),
      binding = a.binding();
    a.binding = () => binding;
    vi.spyOn(t.svc as unknown as InternalService, "doCheckpoint").mockRejectedValueOnce(
      new Error("test save failure"),
    );
    expect((await runWithToolAccess(a, () => submit(t, id, 7))).ok).toBe(false);
    binding.decision = { kind: "restricted", root: "other" };
    expect((await runWithToolAccess(b, () => submit(t, id, 8))).ok).toBe(false);
    expect((await submit(t, id, 9)).ok).toBe(false);
    expect(t.svc.headRev(id)).toBe(1);
    binding.decision = { kind: "restricted", root: "allowed" };
    await t.svc.checkpoint(id, t.root);
    expect((await t.svc.entry(id, t.root)).checkpointRev).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});

test("restricted restart cannot borrow the new task to save an unknown pending origin; unscoped saves remain asynchronous", async () => {
  const t = setup();
  const restarted = new DocumentService(t.db);
  try {
    const id = await plain(t);
    expect((await submit(t, id, 7)).ok).toBe(true);
    expect((await t.svc.entry(id, t.root)).checkpointRev).toBe(0);
    io.calls = [];
    await expect(
      restricted(t, () => restarted.open("w", t.root, "allowed/plain.xlsx")),
    ).rejects.toThrow("归属");
    expect(io.calls.filter((c) => c.kind === "read" && c.path.endsWith("plain.xlsx"))).toEqual([]);
    await t.svc.checkpoint(id, t.root);
    expect((await t.svc.entry(id, t.root)).checkpointRev).toBe(1);
  } finally {
    await restarted.close();
    await t.close();
  }
});

test("workspace watcher does not inherit the first restricted reader origin", async () => {
  const t = setup();
  try {
    expect(
      (
        await restricted(t, () =>
          t.read.execute({ path: "allowed/book.xlsx", mode: "overview" }, t.ctx),
        )
      ).status,
    ).toBe("ok");
    await t.svc.open("w", t.root, "other/book.xlsx");
    const before = facts(t).length;
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(facts(t).slice(before)).toEqual([]);
  } finally {
    await t.close();
  }
});

test("restart without any runtime context cannot wash a scoped pending write into an independent save", async () => {
  const t = setup(),
    restarted = new DocumentService(t.db);
  let original: Buffer | undefined;
  try {
    const id = await plain(t);
    original = readFileSync(join(t.root, "allowed/plain.xlsx"));
    vi.spyOn(t.svc as unknown as InternalService, "doCheckpoint").mockRejectedValueOnce(
      new Error("test save failure"),
    );
    expect((await restricted(t, () => submit(t, id, 7))).ok).toBe(false);
    io.calls = [];
    await expect(restarted.open("w", t.root, "allowed/plain.xlsx")).rejects.toThrow("归属");
    expect(io.calls.filter((c) => c.kind === "read" && c.path.endsWith("plain.xlsx"))).toEqual([]);
    expect(t.svc.headRev(id)).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await restarted.close();
    if (original) writeFileSync(join(t.root, "allowed/plain.xlsx"), original);
    await t.close();
  }
});

test("completed scoped engine authorization rejects late publication but new edits and explicit recalc reauthorize", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      a = access(t, "a"),
      b = access(t, "b");
    const first = await runWithToolAccess(a, () =>
      t.svc.submit(id, t.root, {
        baseRev: 0,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [{ op: "cells.set", range: "A1:B1", values: [[7, "=A1*2"]] }],
      }),
    );
    expect(first).toMatchObject({ ok: true, calc: "computed" });
    const entry = await t.svc.entry(id, t.root),
      sid = entry.live.save().sheetOrder[0]!;
    expect(entry.checkpointRev).toBe(entry.meta.rev);
    expect(entry.persistEngineResults).toBe(false);
    const before = entry.meta.rev,
      beforeFacts = facts(t).length;
    vi.spyOn(entry.live.capture, "takeEngineResults").mockReturnValueOnce([
      {
        id: "sheet.mutation.set-range-values",
        params: { unitId: entry.live.unitId, subUnitId: sid, cellValue: { 0: { 1: { v: 14 } } } },
      },
    ]);
    entry.live.capture.onEngineResults?.();
    await entry.tail;
    expect(entry.meta.rev).toBe(before);
    expect(facts(t).slice(beforeFacts)).toEqual([]);
    expect((await runWithToolAccess(b, () => submit(t, id, 8))).ok).toBe(true);
    expect(entry.checkpointSnapshot.sheets[sid]?.cellData?.[0]?.[1]?.v).toBe(16);
    const beforeRecalc = entry.meta.rev;
    expect(await runWithToolAccess(b, () => t.svc.recalculate(id, t.root))).toMatchObject({
      calc: "computed",
    });
    expect(entry.meta.rev).toBeGreaterThan(beforeRecalc);
    expect(entry.checkpointRev).toBe(entry.meta.rev);
    expect(entry.checkpointSnapshot.sheets[sid]?.cellData?.[0]?.[1]?.v).toBe(16);
    expect(entry.persistEngineResults).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});

test("unbounded runtime keeps asynchronous checkpoint and existing engine authorization", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      ctx = access(t, "unbounded");
    const binding = ctx.binding();
    binding.decision = { kind: "unbounded" };
    binding.accessDeliveryRequired = false;
    ctx.binding = () => binding;
    expect((await runWithToolAccess(ctx, () => submit(t, id, 7))).ok).toBe(true);
    const entry = await t.svc.entry(id, t.root);
    expect(entry.checkpointRev).toBe(0);
    expect(entry.persistEngineResults).toBe(true);
    await runWithToolAccess(ctx, () => t.svc.checkpoint(id, t.root));
    expect(entry.checkpointRev).toBe(entry.meta.rev);
    expect(entry.persistEngineResults).toBe(true);
  } finally {
    await t.close();
  }
});

test("pending calculation retains its write origin until the derived revision is actually saved", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      a = access(t, "a"),
      b = access(t, "b"),
      entry = await t.svc.entry(id, t.root);
    vi.spyOn(entry.live.boot, "waitCalc").mockResolvedValueOnce(false);
    const first = await runWithToolAccess(a, () =>
      t.svc.submit(id, t.root, {
        baseRev: 0,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [{ op: "cells.set", range: "A1:B1", values: [[7, "=A1*2"]] }],
      }),
    );
    expect(first).toMatchObject({ ok: true, calc: "pending" });
    expect(entry.writeAccess).toBe(a);
    expect(entry.persistEngineResults).toBe(true);
    expect((await runWithToolAccess(a, () => t.svc.sourceStatus(id, t.root))).pendingWrite).toBe(
      true,
    );
    vi.restoreAllMocks();
    await entry.live.boot.waitCalc(5000);
    await entry.tail;
    expect(entry.pendingWriteAccess).toBe(a);
    await runWithToolAccess(b, () => t.svc.checkpoint(id, t.root));
    expect(entry.checkpointRev).toBe(entry.meta.rev);
    expect(entry.writeAccess).toBeUndefined();
    expect(
      facts(t)
        .filter(
          (f) => f.kind === "file-write" && f.purpose === "publish" && f.outcome === "succeeded",
        )
        .every((f) => f.originTurnId === "a"),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});

test("persisted inverse provenance survives independent reopen; only trusted original-origin resume can save, undo and redo", async () => {
  const t = setup(),
    root = mkdtempSync(join(tmpdir(), "workbook-origin-reopen-"));
  let resumed: DocumentService | undefined, db: ReturnType<typeof openDb> | undefined;
  try {
    const id = await plain(t),
      original = readFileSync(join(t.root, "allowed/plain.xlsx"));
    vi.spyOn(t.svc as unknown as InternalService, "doCheckpoint").mockRejectedValueOnce(
      new Error("test save failure"),
    );
    expect((await runWithToolAccess(access(t, "original"), () => submit(t, id, 7))).ok).toBe(false);
    const inverse = JSON.parse(
      String(t.db.prepare("SELECT inverse FROM doc_ops WHERE doc_id=? AND rev=1").get(id)?.inverse),
    );
    expect(inverse._hostAccessOrigin).toEqual({
      version: 1,
      sessionId: "s",
      originAgentId: "main",
      originTurnId: "original",
    });
    expect(inverse.mutations).toBeInstanceOf(Array);
    mkdirSync(join(root, "allowed"));
    writeFileSync(join(root, "allowed/plain.xlsx"), original);
    t.db.exec(`VACUUM INTO '${join(root, "db.sqlite").replaceAll("'", "''")}'`);
    db = openDb(join(root, "db.sqlite"), [
      ...KERNEL_MIGRATIONS,
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_PATH_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    db.prepare("UPDATE workspaces SET path=? WHERE id='w'").run(root);
    resumed = new DocumentService(db);
    const service = resumed,
      actualDb = db;
    const originalCtx = {
      ...access(t, "original"),
      workspaceRoot: root,
      db: actualDb,
      log: new SessionLog(actualDb),
      turnId: "new-resume-turn",
      toolCallId: "resume",
    };
    const wrongCtx = {
      ...access(t, "unrelated"),
      workspaceRoot: root,
      db: actualDb,
      log: new SessionLog(actualDb),
    };
    await expect(service.open("w", root, "allowed/plain.xlsx")).rejects.toThrow("从原任务继续");
    await expect(service.open("w", root, "./allowed/plain.xlsx")).rejects.toThrow("从原任务继续");
    await expect(
      runWithToolAccess(wrongCtx, () => service.open("w", root, "allowed/plain.xlsx")),
    ).rejects.toThrow("从原任务继续");
    const reopened = await runWithToolAccess(originalCtx, () =>
      service.open("w", root, "allowed/plain.xlsx"),
    );
    expect(reopened.meta.rev).toBe(1);
    expect(reopened.meta.checkpointRev).toBe(1);
    const entry = await service.entry(id, root),
      sid = entry.live.save().sheetOrder[0]!;
    expect(entry.checkpointSnapshot.sheets[sid]?.cellData?.[0]?.[0]?.v).toBe(7);
    const undo = await runWithToolAccess(originalCtx, () =>
      service.revert(id, root, 1, { kind: "agent", id: "main" }, "s", "undo"),
    );
    expect(undo.ok).toBe(true);
    expect(entry.checkpointSnapshot.sheets[sid]?.cellData?.[0]?.[0]?.v ?? null).toBeNull();
    const redo = await runWithToolAccess(originalCtx, () =>
      service.revert(id, root, 2, { kind: "agent", id: "main" }, "s", "redo"),
    );
    expect(redo.ok).toBe(true);
    expect(entry.meta.rev).toBe(3);
    expect(entry.checkpointSnapshot.sheets[sid]?.cellData?.[0]?.[0]?.v).toBe(7);
  } finally {
    vi.restoreAllMocks();
    if (resumed) await resumed.close();
    db?.close();
    await t.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped external-link reads distinguish the companion's independent read, then a saved local edit preserves external bytes", async () => {
  const t = setup();
  try {
    const source = Buffer.from(
      readFileSync(new URL("./fixtures/external-links.xlsx.base64", import.meta.url), "utf8"),
      "base64",
    );
    const companion = Buffer.from(
      readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
      "base64",
    );
    writeFileSync(join(t.root, "allowed/links.xlsx"), source);
    writeFileSync(join(t.root, "allowed/book1.xlsx"), companion);
    writeFileSync(join(t.root, "allowed/edited.xlsx"), source);
    expect(
      (
        await restricted(t, () =>
          t.read.execute({ path: "allowed/links.xlsx", mode: "objects" }, t.ctx),
        )
      ).status,
    ).toBe("ok");
    expect(facts(t).some((f) => f.kind === "file-bytes" && f.path === "allowed/book1.xlsx")).toBe(
      false,
    );
    expect(
      (
        await restricted(t, () =>
          t.read.execute({ path: "allowed/book1.xlsx", mode: "range", range: "A1:B2" }, t.ctx),
        )
      ).status,
    ).toBe("ok");
    expect(
      facts(t).some(
        (f) =>
          f.kind === "file-bytes" && f.path === "allowed/book1.xlsx" && f.outcome === "succeeded",
      ),
    ).toBe(true);
    const edit = await restricted(t, () =>
      workbookEditTool(t.svc).execute(
        {
          path: "allowed/edited.xlsx",
          ops: [{ op: "cells.set", range: "Sheet1!A1", values: [[77]] }],
        },
        t.ctx,
      ),
    );
    expect(edit.status, JSON.stringify(edit.error)).toBe("ok");
    const before = unzipSync(source),
      after = unzipSync(readFileSync(join(t.root, "allowed/edited.xlsx")));
    for (const part of Object.keys(before).filter(
      (p) => p.startsWith("xl/externalLinks/") || p === "xl/_rels/workbook.xml.rels",
    ))
      expect(after[part]).toEqual(before[part]);
    const b2 = (xml: Uint8Array | undefined) =>
      Buffer.from(xml ?? [])
        .toString()
        .match(/<c\b[^>]*r="B2"[^>]*>[\s\S]*?<\/c>/)?.[0];
    expect(b2(after["xl/worksheets/sheet1.xml"])).toBe(b2(before["xl/worksheets/sheet1.xml"]));
    expect(readFileSync(join(t.root, "allowed/links.xlsx"))).toEqual(source);
    expect(readFileSync(join(t.root, "allowed/book1.xlsx"))).toEqual(companion);
    expect(facts(t).some((f) => f.kind === "external-target-fetch")).toBe(false);
  } finally {
    await t.close();
  }
});

test("snapshot-style inverse keeps host provenance outside executable undo and redo data", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      ctx = access(t, "snapshot");
    const apply = (ops: Parameters<DocumentService["submit"]>[2]["ops"]) =>
      runWithToolAccess(ctx, () =>
        t.svc.submit(id, t.root, {
          baseRev: t.svc.headRev(id),
          source: { kind: "agent", id: "main" },
          sessionId: "s",
          ops,
        }),
      );
    expect((await apply([{ op: "sheet.add", name: "Extra" }])).ok).toBe(true);
    expect((await apply([{ op: "sheet.delete", sheet: "Extra" }])).ok).toBe(true);
    const inverse = JSON.parse(
      String(t.db.prepare("SELECT inverse FROM doc_ops WHERE doc_id=? AND rev=2").get(id)?.inverse),
    );
    expect(inverse).toMatchObject({
      needsSnapshot: true,
      _hostAccessOrigin: { version: 1, originTurnId: "snapshot" },
    });
    expect(inverse.snapshot).toBeDefined();
    expect(
      (
        await runWithToolAccess(ctx, () =>
          t.svc.revert(id, t.root, 2, { kind: "agent", id: "main" }, "s"),
        )
      ).ok,
    ).toBe(true);
    expect(
      Object.values((await t.svc.snapshot(id, t.root)).snapshot.sheets).some(
        (s) => s.name === "Extra",
      ),
    ).toBe(true);
    expect(
      (
        await runWithToolAccess(ctx, () =>
          t.svc.revert(id, t.root, 3, { kind: "agent", id: "main" }, "s"),
        )
      ).ok,
    ).toBe(true);
    expect(
      Object.values((await t.svc.snapshot(id, t.root)).snapshot.sheets).some(
        (s) => s.name === "Extra",
      ),
    ).toBe(false);
  } finally {
    await t.close();
  }
});

test("origin-wide pending state includes an unselected child-written actor without I/O or changing calculation", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      origin = access(t, "a"),
      child = { ...origin, agentId: "child", turnId: "child-turn" },
      entry = await t.svc.entry(id, t.root);
    const callback = entry.live.capture.onEngineResults;
    entry.live.capture.onEngineResults = undefined;
    vi.spyOn(entry.live.boot, "waitCalc").mockResolvedValue(false);
    try {
      expect(
        await runWithToolAccess(child, () =>
          t.svc.submit(id, t.root, {
            baseRev: 0,
            source: { kind: "agent", id: "child" },
            sessionId: "s",
            ops: [{ op: "cells.set", range: "A1:B1", values: [[7, "=A1*2"]] }],
          }),
        ),
      ).toMatchObject({ ok: true, calc: "pending" });
      const saved = await t.svc.open("w", t.root, "allowed/book.xlsx");
      expect(saved.meta.calcPending).not.toBe(true);
      expect(entry.checkpointRev).toBe(entry.meta.rev);
      const revision = entry.meta.rev,
        factCount = facts(t).length,
        waits = vi.mocked(entry.live.boot.waitCalc).mock.calls.length,
        checkpoint = vi.spyOn(t.svc as unknown as InternalService, "doCheckpoint");
      io.calls = [];
      expect(t.svc.hasPendingWritesForOrigin("w", origin)).toBe(true);
      expect(t.svc.hasPendingWritesForOrigin("w", access(t, "b"))).toBe(false);
      expect(t.svc.hasPendingWritesForOrigin("other-workspace", origin)).toBe(false);
      expect(t.svc.hasPendingWritesForOrigin("w", { ...origin, sessionId: "other" })).toBe(false);
      expect(t.svc.hasPendingWritesForOrigin("w", { ...origin, originAgentId: "other" })).toBe(
        false,
      );
      // A new service has no actor and must find the saved pending-calculation marker in SQLite.
      expect(new DocumentService(t.db).hasPendingWritesForOrigin("w", origin)).toBe(true);
      expect(io.calls).toEqual([]);
      expect(facts(t)).toHaveLength(factCount);
      expect(checkpoint).not.toHaveBeenCalled();
      expect(vi.mocked(entry.live.boot.waitCalc).mock.calls).toHaveLength(waits);
      expect(entry.meta.rev).toBe(revision);
      expect(entry.meta.calcPending).toBe(true);
      expect(entry.writeAccess).toBe(child);
    } finally {
      vi.restoreAllMocks();
      entry.live.capture.onEngineResults = callback;
    }
    await runWithToolAccess(origin, () => t.svc.recalculate(id, t.root));
    io.calls = [];
    expect(t.svc.hasPendingWritesForOrigin("w", origin)).toBe(false);
    expect(new DocumentService(t.db).hasPendingWritesForOrigin("w", origin)).toBe(false);
    expect(io.calls).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});

test("origin-wide pending state finds durable unsaved revisions without opening their actor", async () => {
  const t = setup();
  try {
    const id = await plain(t),
      origin = access(t, "a");
    vi.spyOn(t.svc as unknown as InternalService, "doCheckpoint").mockRejectedValueOnce(
      new Error("test save failure"),
    );
    expect((await runWithToolAccess(origin, () => submit(t, id, 7))).ok).toBe(false);
    const unloaded = new DocumentService(t.db),
      factCount = facts(t).length;
    io.calls = [];
    expect(t.svc.hasPendingWritesForOrigin("w", origin)).toBe(true);
    expect(unloaded.hasPendingWritesForOrigin("w", origin)).toBe(true);
    expect(unloaded.hasPendingWritesForOrigin("w", access(t, "b"))).toBe(false);
    expect(unloaded.hasPendingWritesForOrigin("other-workspace", origin)).toBe(false);
    expect(unloaded.hasPendingWritesForOrigin("w", { ...origin, sessionId: "other" })).toBe(false);
    expect(unloaded.hasPendingWritesForOrigin("w", { ...origin, originAgentId: "other" })).toBe(
      false,
    );
    expect(io.calls).toEqual([]);
    expect(facts(t)).toHaveLength(factCount);
    vi.restoreAllMocks();
    await runWithToolAccess(origin, () => t.svc.checkpoint(id, t.root));
    io.calls = [];
    expect(t.svc.hasPendingWritesForOrigin("w", origin)).toBe(false);
    expect(unloaded.hasPendingWritesForOrigin("w", origin)).toBe(false);
    expect(io.calls).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await t.close();
  }
});
