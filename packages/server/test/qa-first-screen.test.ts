import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { qaFirstScreenRoutes } from "../src/qa-first-screen.ts";

let app: Hono;
let dir: string | undefined;
afterEach(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function fixture() {
  dir = mkdtempSync(join(tmpdir(), "excelmanus-qa-metrics-"));
  const sessionId = "ses_qa_test";
  app = new Hono().route(
    "/api/v1/qa",
    qaFirstScreenRoutes({ dataDir: dir, sessionExists: (id) => id === sessionId }),
  );
  return { dir, sessionId };
}
function report(sessionId: string) {
  return {
    runId: randomUUID(),
    sessionId,
    observations: [{ name: "fcp", startTime: 123, duration: 0 }],
  };
}
async function post(body: unknown) {
  return app.request("http://localhost/api/v1/qa/first-screen-metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("QA metric collection remains disabled and writes no measurement files", async () => {
  const f = await fixture();
  expect((await post(report(f.sessionId))).status).toBe(404);
  expect(existsSync(join(f.dir, "qa-first-screen"))).toBe(false);
});
test("QA metric collection requires exactly the configured existing session; logs no session identity", async () => {
  const f = await fixture();
  vi.stubEnv("EXCELMANUS_QA_METRICS", "1");
  vi.stubEnv("EXCELMANUS_QA_METRICS_UNTIL", new Date(Date.now() + 60_000).toISOString());
  vi.stubEnv("EXCELMANUS_QA_SESSION_ID", f.sessionId);
  expect((await post(report("ses_wrong"))).status).toBe(403);
  const body = report(f.sessionId);
  expect((await post(body)).status).toBe(200);
  const files = readdirSync(join(f.dir, "qa-first-screen"));
  expect(files).toHaveLength(1);
  const log = readFileSync(join(f.dir, "qa-first-screen", files[0] as string), "utf8");
  expect(log).not.toContain(f.sessionId);
  expect(JSON.parse(log)).toMatchObject({ runId: body.runId, observations: body.observations });
  expect((await post(body)).status).toBe(409);
});
test("QA metrics rejects unknown fields, excessive observations, and invalid numeric times", async () => {
  const f = await fixture();
  vi.stubEnv("EXCELMANUS_QA_METRICS", "1");
  vi.stubEnv("EXCELMANUS_QA_METRICS_UNTIL", new Date(Date.now() + 60_000).toISOString());
  vi.stubEnv("EXCELMANUS_QA_SESSION_ID", f.sessionId);
  const base = report(f.sessionId);
  for (const body of [
    { ...base, url: "https://example.invalid/?secret=private" },
    { ...base, observations: [{ name: "fcp", startTime: -1, duration: 0 }] },
    { ...base, observations: [{ name: "fcp", startTime: 123, duration: 0, element: "private" }] },
    {
      ...base,
      observations: Array.from({ length: 201 }, () => ({
        name: "resource",
        startTime: 1,
        duration: 1,
        route: "bootstrap",
      })),
    },
    {
      ...base,
      observations: Array.from({ length: 51 }, () => ({
        name: "longtask",
        startTime: 1,
        duration: 1,
      })),
    },
  ])
    expect((await post(body)).status).toBe(400);
  expect((await post({ ...base, padding: "x".repeat(32768) })).status).toBe(413);
  expect(existsSync(join(f.dir, "qa-first-screen"))).toBe(false);
});

test("QA metrics requires an explicit unexpired short test window", async () => {
  const f = await fixture();
  vi.stubEnv("EXCELMANUS_QA_METRICS", "1");
  vi.stubEnv("EXCELMANUS_QA_SESSION_ID", f.sessionId);
  for (const until of [
    "",
    "invalid",
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + 25 * 3600_000).toISOString(),
  ]) {
    vi.stubEnv("EXCELMANUS_QA_METRICS_UNTIL", until);
    expect((await post(report(f.sessionId))).status).toBe(404);
  }
  expect(existsSync(join(f.dir, "qa-first-screen"))).toBe(false);
});
test("QA measurements stop at 30 runs and never persist excess data", async () => {
  const f = await fixture();
  vi.stubEnv("EXCELMANUS_QA_METRICS", "1");
  vi.stubEnv("EXCELMANUS_QA_SESSION_ID", f.sessionId);
  vi.stubEnv("EXCELMANUS_QA_METRICS_UNTIL", new Date(Date.now() + 60_000).toISOString());
  for (let i = 0; i < 30; i++) expect((await post(report(f.sessionId))).status).toBe(200);
  expect((await post(report(f.sessionId))).status).toBe(429);
  expect(readdirSync(join(f.dir, "qa-first-screen"))).toHaveLength(30);
});

test("rebuilding disabled QA routes purges expired owned reports and restores expiry timers", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const now = Date.now();
  const logDir = join(f.dir, "qa-first-screen");
  mkdirSync(logDir);
  const expiredId = randomUUID();
  const pendingId = randomUUID();
  const expired = join(logDir, `${expiredId}.json`);
  const pending = join(logDir, `${pendingId}.json`);
  writeFileSync(
    expired,
    JSON.stringify({
      runId: expiredId,
      recordedAt: new Date(now - 25 * 3600_000).toISOString(),
      observations: [],
    }),
  );
  writeFileSync(
    pending,
    JSON.stringify({
      runId: pendingId,
      recordedAt: new Date(now - 24 * 3600_000 + 1000).toISOString(),
      observations: [],
    }),
  );
  writeFileSync(join(logDir, "unrelated.txt"), "do not remove");
  vi.stubEnv("EXCELMANUS_QA_METRICS", "0");
  qaFirstScreenRoutes({ dataDir: f.dir, sessionExists: () => false });
  expect(existsSync(expired)).toBe(false);
  expect(existsSync(pending)).toBe(true);
  vi.advanceTimersByTime(1001);
  expect(existsSync(pending)).toBe(false);
  expect(readFileSync(join(logDir, "unrelated.txt"), "utf8")).toBe("do not remove");
});
test("production app registers QA routes behind the existing device authentication middleware", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const authentication = source.indexOf("const browserSessionRoute =");
  const rejection = source.indexOf('return fail(c, 401, "unauthorized"', authentication);
  const qaRegistration = source.indexOf('"/api/v1/qa",');
  expect(authentication).toBeGreaterThan(0);
  expect(rejection).toBeGreaterThan(authentication);
  expect(qaRegistration).toBeGreaterThan(rejection);
  expect(source.slice(authentication, rejection)).toContain('c.req.path.startsWith("/api/")');
  expect(source.slice(authentication, rejection)).not.toContain("/qa");
});
