import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterEach, describe, expect, test, vi } from "vitest";
import { mutationTools } from "../src/mutations.ts";
import { FILES_TOOLS } from "../src/tools.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.clearAllMocks();
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "files-access-facts-"));
  const db = openDb(join(root, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('w','test',?,?)").run(
    root,
    new Date().toISOString(),
  );
  fs.mkdirSync(join(root, "allowed"));
  fs.mkdirSync(join(root, "sibling"));
  fs.writeFileSync(join(root, "allowed/report.txt"), "hello");
  fs.writeFileSync(join(root, "sibling/report.txt"), "secret");
  const backups = new BackupService(db);
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
    toolCallId: "call",
  });
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    turnId: "t",
    toolCallId: "call",
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
  const tools = new Map(
    [...FILES_TOOLS, ...mutationTools(backups)].map((tool) => [tool.name, tool]),
  );
  const facts = () =>
    (
      db.prepare("SELECT data FROM session_log WHERE type='access.fact' ORDER BY seq").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data) as AccessFact);
  const execute = (name: string, args: unknown) =>
    runWithToolAccess(access, () => tools.get(name)!.execute(args, ctx));
  return { root, db, backups, log, access, ctx, tools, facts, execute };
}
const seen = () =>
  [fs.lstatSync, fs.statSync, fs.readdirSync, fs.readFileSync].flatMap((fn) =>
    vi.mocked(fn).mock.calls.map((call) => String(call[0])),
  );

describe("actual scoped file host access", () => {
  test.each([
    { path: ".", glob: "allowed/*.txt" },
    { glob: "allowed/*.txt" },
    { path: "allowed/../sibling" },
    { path: "sibling" },
  ])("find rejects outside start %j before target filesystem access", async (args) => {
    const f = fixture();
    vi.clearAllMocks();
    expect(await f.execute("find", args)).toMatchObject({ status: "error" });
    expect(seen()).toEqual([]);
    expect(f.facts().some((fact) => fact.outcome === "rejected-before-access")).toBe(true);
  });
  test("contains records bytes of the no-match file separately from directory and metadata", async () => {
    const f = fixture();
    expect(await f.execute("find", { path: "allowed", contains: "absent" })).toMatchObject({
      status: "ok",
      data: { entries: [] },
    });
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "directory-enumeration",
          path: "allowed",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          kind: "file-metadata",
          path: "allowed/report.txt",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/report.txt",
          purpose: "contains",
          outcome: "succeeded",
        }),
      ]),
    );
    expect(
      f
        .facts()
        .filter((fact) => fact.outcome === "succeeded")
        .some((fact) => fact.path.startsWith("sibling")),
    ).toBe(false);
  });
  test("intentMeta hash is blocked before touching same-basename sibling and allowed hash is recorded", () => {
    const f = fixture();
    vi.clearAllMocks();
    expect(() =>
      runWithToolAccess(f.access, () =>
        f.tools.get("files")!.intentMeta!(
          { ops: [{ op: "copy", path: "sibling/report.txt", to: "allowed/copy.txt" }] },
          f.ctx,
        ),
      ),
    ).toThrow();
    expect(seen()).toEqual([]);
    runWithToolAccess(f.access, () =>
      f.tools.get("files")!.intentMeta!(
        { ops: [{ op: "copy", path: "allowed/report.txt", to: "allowed/copy.txt" }] },
        f.ctx,
      ),
    );
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/report.txt",
          purpose: "hash",
          outcome: "succeeded",
        }),
      ]),
    );
  });
  test("copy and rollback preserve actual facts outside the metadata transaction", async () => {
    const f = fixture();
    const failing = mutationTools(
      f.backups,
      () => {},
      () => {
        throw new Error("metadata commit failed");
      },
    ).find((tool) => tool.name === "files")!;
    const result = await runWithToolAccess(f.access, () =>
      failing.execute(
        { ops: [{ op: "copy", path: "allowed/report.txt", to: "allowed/copied.txt" }] },
        f.ctx,
      ),
    );
    expect(result.status).toBe("error");
    expect(fs.existsSync(join(f.root, "allowed/copied.txt"))).toBe(false);
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/report.txt",
          purpose: "copy",
          outcome: "succeeded",
        }),
      ]),
    );
    expect(
      f.db.prepare("SELECT data FROM session_log WHERE type='access.batch'").all(),
    ).toHaveLength(2);
  });
  test("pending unrelated recovery blocks without reading its target", async () => {
    const f = fixture();
    f.backups.beginFileBatch("w", f.root, [{ path: "sibling/report.txt", after: null }]);
    vi.clearAllMocks();
    expect(
      await f.execute("files", {
        ops: [{ op: "copy", path: "allowed/report.txt", to: "allowed/copy.txt" }],
      }),
    ).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
    expect(seen()).toEqual([]);
  });
  test("fact flush failure after commit reports the committed result without undoing committed files", async () => {
    const f = fixture();
    const append = f.log.append.bind(f.log);
    vi.spyOn(f.log, "append").mockImplementation((sessionId, agentId, records) => {
      if (
        records.some(
          (record) =>
            record.type === "access.batch" &&
            (record.data as { status?: string }).status === "closed",
        )
      )
        throw new Error("fact persistence unavailable after commit");
      return append(sessionId, agentId, records);
    });
    const result = await f.execute("files", {
      ops: [{ op: "copy", path: "allowed/report.txt", to: "allowed/committed.txt" }],
    });
    expect(result).toMatchObject({
      status: "uncertain",
      data: {
        results: [{ path: "allowed/report.txt", to: "allowed/committed.txt" }],
        accessFactsRecorded: false,
      },
    });
    expect(fs.readFileSync(join(f.root, "allowed/committed.txt"), "utf8")).toBe("hello");
    expect(f.db.prepare("SELECT id FROM file_batches").all()).toHaveLength(0);
    expect(
      f.db
        .prepare(
          "SELECT id FROM backups WHERE original_path='allowed/committed.txt' AND kind='created'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      f.db
        .prepare(
          "SELECT json_extract(data,'$.status') AS status FROM session_log WHERE type='access.batch'",
        )
        .all(),
    ).toEqual([{ status: "started" }]);
    expect(f.access.auditFailed).toBe(true);
  });
  test("scoped path hashing rejects symlinks instead of following them", async () => {
    const f = fixture();
    fs.symlinkSync(join(f.root, "sibling/report.txt"), join(f.root, "allowed/link.txt"));
    vi.clearAllMocks();
    expect(await f.execute("read", { path: "allowed/link.txt" })).toMatchObject({
      status: "error",
    });
    expect(seen().some((path) => path.includes("sibling"))).toBe(false);
  });
  test("recursive copy records actual descendant reads and refuses a nested symlink", async () => {
    const f = fixture();
    fs.mkdirSync(join(f.root, "allowed/tree/nested"), { recursive: true });
    fs.writeFileSync(join(f.root, "allowed/tree/nested/a.txt"), "nested");
    expect(
      await f.execute("files", {
        ops: [{ op: "copy", path: "allowed/tree", to: "allowed/tree-copy" }],
      }),
    ).toMatchObject({ status: "ok" });
    expect(fs.readFileSync(join(f.root, "allowed/tree-copy/nested/a.txt"), "utf8")).toBe("nested");
    expect(f.facts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "directory-enumeration",
          path: "allowed/tree/nested",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          kind: "file-bytes",
          path: "allowed/tree/nested/a.txt",
          purpose: "copy",
          outcome: "succeeded",
        }),
      ]),
    );
    fs.symlinkSync(
      join(f.root, "sibling/report.txt"),
      join(f.root, "allowed/tree/nested/link.txt"),
    );
    vi.clearAllMocks();
    expect(
      await f.execute("files", {
        ops: [{ op: "copy", path: "allowed/tree", to: "allowed/tree-denied" }],
      }),
    ).toMatchObject({ status: "error" });
    expect(seen().some((path) => path.includes("sibling"))).toBe(false);
    expect(fs.existsSync(join(f.root, "allowed/tree-denied"))).toBe(false);
  });
});
