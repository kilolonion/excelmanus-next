import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionLog } from "@excelmanus/kernel";
import {
  createHistoryWindowBoundary,
  createOpenApiDocument,
  SessionHistoryWindowResponse,
} from "@excelmanus/protocol";
import { expect, test } from "vitest";

function fixture(count: number, user = 2) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE session_log(session_id TEXT,seq INTEGER,agent_id TEXT,type TEXT,data TEXT,created_at TEXT,PRIMARY KEY(session_id,seq)) WITHOUT ROWID",
  );
  const stmt = db.prepare(
    "INSERT INTO session_log VALUES('s',?,'main',?,?,'2026-10-21T00:00:00Z')",
  );
  for (let seq = 1; seq <= count; seq++)
    stmt.run(
      seq,
      seq === user ? "user.message" : seq === user + 1 ? "turn.started" : "step.started",
      "{}",
    );
  return { db, log: new SessionLog(db) };
}
test("history boundary preserves cross-page barriers and pending user semantics", () => {
  const boundary = createHistoryWindowBoundary();
  expect(boundary.push([{ seq: 101, agentId: "main", type: "turn.started" }])).toBeNull();
  expect(boundary.push([{ seq: 100, agentId: "main", type: "user.message" }])).toEqual({
    startIndex: 0,
    hasMore: true,
  });
});
test("bounded history handles long complete windows and rejects truncated logical pages", () => {
  for (const count of [0, 1, 99, 100, 101, 1070, 2048, 2049]) {
    const { db, log } = fixture(count);
    const result = log.readHistoryWindow("s", count, 2 * 1024 * 1024);
    expect(result.kind).toBe(count > 2048 ? "overflow" : "complete");
    if (result.kind === "complete") expect(result.items).toHaveLength(count === 101 ? 100 : count);
    db.close();
  }
  const { db, log } = fixture(2050, 20);
  expect(log.readHistoryWindow("s", 2050, 2 * 1024 * 1024)).toMatchObject({
    kind: "overflow",
    reason: "records",
  });
  db.close();
});
test("oversized UTF8 data is rejected before JSON decoding", () => {
  const { db, log } = fixture(2);
  db.prepare("UPDATE session_log SET data=? WHERE seq=2").run("坏".repeat(800000));
  expect(log.readHistoryWindow("s", 2, 2 * 1024 * 1024)).toMatchObject({
    kind: "overflow",
    reason: "bytes",
  });
  db.close();
});
test("history stays within captured head and uses a scoped primary key range", () => {
  const { db, log } = fixture(1070);
  const result = log.readHistoryWindow("s", 100, 2 * 1024 * 1024);
  expect(result.kind).toBe("complete");
  if (result.kind === "complete") expect(result.items.at(-1)?.seq).toBe(100);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT seq FROM session_log WHERE session_id=? AND seq<=? ORDER BY seq DESC LIMIT 2049",
    )
    .all("s", 1070);
  expect(JSON.stringify(plan)).toContain("PRIMARY KEY");
  expect(JSON.stringify(plan)).not.toContain("SCAN session_log");
  db.close();
});
test("boundary excludes unrelated agent starts and respects intervening barriers", () => {
  const boundary = createHistoryWindowBoundary();
  expect(
    boundary.push([
      { seq: 104, agentId: "main", type: "step.started" },
      { seq: 105, agentId: "child", type: "turn.started" },
    ]),
  ).toBeNull();
  expect(boundary.push([{ seq: 103, agentId: "main", type: "user.message" }])).toBeNull();
  expect(boundary.push([{ seq: 1, agentId: null, type: "session.created" }])).toEqual({
    startIndex: 0,
    hasMore: false,
  });
});
test("production OpenAPI registers the history window response", () => {
  expect(createOpenApiDocument("test").paths).toHaveProperty("/sessions/{id}/history-window");
  expect(
    SessionHistoryWindowResponse.safeParse({ kind: "overflow", headSeq: 1, reason: "bytes" })
      .success,
  ).toBe(true);
});
// The original 5s failure remains recorded. This 30s harness budget includes cold module
// transformation and fixture setup; it is not a product startup-performance threshold.
test("real startServer serves authorized same-snapshot history and bounds metadata", async () => {
  const deadline = AbortSignal.timeout(28_000);
  const diagnostic = (
    stage: string,
    durationMs: number,
    status?: number,
    responseBytes?: number,
  ) => {
    console.log(
      JSON.stringify({
        stage,
        durationMs: Math.round(durationMs * 10) / 10,
        ...(status === undefined ? {} : { status }),
        ...(responseBytes === undefined ? {} : { responseBytes }),
      }),
    );
  };
  const timed = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    diagnostic(`${stage}.start`, 0);
    try {
      return await run();
    } finally {
      diagnostic(`${stage}.end`, performance.now() - start);
    }
  };
  const writeFixture = (stage: string, run: () => void) => {
    deadline.throwIfAborted();
    const start = performance.now();
    try {
      run();
    } finally {
      diagnostic(`fixture.${stage}`, performance.now() - start);
    }
  };
  const request = async (stage: string, url: string, init?: RequestInit) => {
    deadline.throwIfAborted();
    const start = performance.now();
    diagnostic(`http.${stage}.start`, 0);
    let status: number | undefined;
    let responseBytes: number | undefined;
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]),
      });
      status = response.status;
      const text = await response.text();
      responseBytes = Buffer.byteLength(text, "utf8");
      return { status: response.status, responseBytes, body: JSON.parse(text) as unknown };
    } catch {
      throw new Error(`History-window diagnostic request failed: ${stage}`);
    } finally {
      diagnostic(`http.${stage}.end`, performance.now() - start, status, responseBytes);
    }
  };
  let dir: string | undefined;
  let server: Awaited<ReturnType<typeof import("../src/index.ts").startServer>> | undefined;
  let db: DatabaseSync | undefined;
  try {
    const { startServer } = await timed("dynamic-import", () => import("../src/index.ts"));
    deadline.throwIfAborted(); // A late import must not create fixture resources after timeout.
    writeFixture("directory", () => {
      dir = mkdtempSync(join(tmpdir(), "excelmanus-window-"));
    });
    const dataDir = dir;
    if (!dataDir) throw new Error("Fixture directory not created");
    server = await timed("start-server", () => startServer({ dataDir, log: () => {} }));
    deadline.throwIfAborted();
    db = new DatabaseSync(join(dataDir, "excelmanus.db"));
    const fixtureDb = db;
    const headers = { authorization: `Bearer ${server.token}` };
    const create = await request("create-session", `${server.url}/api/v1/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(create.status).toBe(201);
    const { session } = create.body as { session: { id: string } };
    const endpoint = `${server.url}/api/v1/sessions/${session.id}/history-window`;
    expect((await request("unauthorized", endpoint)).status).toBe(401);
    expect(
      (
        await request("origin-rejected", endpoint, {
          headers: { ...headers, origin: "https://invalid.example" },
        })
      ).status,
    ).toBe(403);
    const response = await request("complete", endpoint, { headers });
    expect(response.status).toBe(200);
    const body = SessionHistoryWindowResponse.parse(response.body);
    expect(body.kind).toBe("complete");
    expect(response.responseBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    if (body.kind === "complete") {
      expect(body.detail.headSeq).toBe(body.headSeq);
      const legacyDetail = await request(
        "legacy-detail",
        `${server.url}/api/v1/sessions/${session.id}`,
        { headers },
      );
      expect(legacyDetail.status).toBe(200);
      expect(body.detail).toEqual(legacyDetail.body);
    }
    writeFixture("large-title", () =>
      fixtureDb
        .prepare("UPDATE sessions SET title=? WHERE id=?")
        .run("大".repeat(100000), session.id),
    );
    expect((await request("large-title", endpoint, { headers })).body).toMatchObject({
      kind: "overflow",
      reason: "metadata",
    });
    writeFixture("large-agent", () => {
      fixtureDb.prepare("UPDATE sessions SET title=NULL WHERE id=?").run(session.id);
      fixtureDb
        .prepare("UPDATE agents SET name=? WHERE session_id=?")
        .run("大".repeat(100000), session.id);
    });
    expect((await request("large-agent", endpoint, { headers })).body).toMatchObject({
      kind: "overflow",
      reason: "metadata",
    });
    const pending = fixtureDb.prepare(
      "INSERT INTO pending_interactions(id,session_id,agent_id,kind,spec,status,created_at,updated_at) VALUES(?,?,'main','question','{}','pending','now','now')",
    );
    writeFixture("large-pending", () => {
      fixtureDb.prepare("UPDATE agents SET name=NULL WHERE session_id=?").run(session.id);
      pending.run("large-field", session.id);
      fixtureDb
        .prepare("UPDATE pending_interactions SET tool_call_id=? WHERE id='large-field'")
        .run("大".repeat(100000));
    });
    expect((await request("large-pending", endpoint, { headers })).body).toMatchObject({
      kind: "overflow",
      reason: "metadata",
    });
    writeFixture("many-pending", () => {
      fixtureDb.prepare("DELETE FROM pending_interactions WHERE session_id=?").run(session.id);
      for (let i = 0; i < 129; i++) pending.run(`pending-${i}`, session.id);
    });
    expect((await request("many-pending", endpoint, { headers })).body).toMatchObject({
      kind: "overflow",
      reason: "metadata",
    });
    writeFixture("clear-pending", () =>
      fixtureDb.prepare("DELETE FROM pending_interactions WHERE session_id=?").run(session.id),
    );
    expect(
      (
        await request("missing-session", `${server.url}/api/v1/sessions/absent/history-window`, {
          headers,
        })
      ).status,
    ).toBe(404);
    writeFixture("many-agents", () => {
      const agent = fixtureDb.prepare(
        "INSERT INTO agents(id,session_id,role,status,created_at,updated_at) VALUES(?,?,'main','idle','now','now')",
      );
      for (let i = 0; i < 129; i++) agent.run(`extra-${i}`, session.id);
    });
    expect((await request("many-agents", endpoint, { headers })).body).toMatchObject({
      kind: "overflow",
      reason: "metadata",
    });
  } finally {
    await timed("cleanup", async () => {
      try {
        db?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          if (dir) rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
}, 30_000);
