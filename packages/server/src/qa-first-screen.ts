import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { QaFirstScreenMetricsBody } from "@excelmanus/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS = 30;
const RUN_FILE = /^[0-9a-f-]{36}\.json$/i;

/** Temporary, opt-in QA metadata only. Mounted after the existing API authentication. */
export function qaFirstScreenRoutes(deps: {
  dataDir: string;
  sessionExists: (id: string) => boolean;
}): Hono {
  const app = new Hono();
  const dir = join(deps.dataDir, "qa-first-screen");
  const scheduled = new Set<string>();
  const restoreExpiry = () => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((name) => RUN_FILE.test(name))) {
      const path = join(dir, name);
      if (!lstatSync(path).isFile()) continue;
      try {
        const stored = JSON.parse(readFileSync(path, "utf8")) as {
          runId?: string;
          recordedAt?: string;
        };
        const recordedAt = Date.parse(stored.recordedAt ?? "");
        if (`${stored.runId}.json` !== name || !Number.isFinite(recordedAt)) continue;
        const remaining = recordedAt + RETENTION_MS - Date.now();
        if (remaining <= 0) {
          unlinkSync(path);
          continue;
        }
        if (scheduled.has(name)) continue;
        scheduled.add(name);
        const expiry = setTimeout(
          () => {
            scheduled.delete(name);
            restoreExpiry();
          },
          Math.min(remaining, RETENTION_MS),
        );
        expiry.unref();
      } catch {
        // Do not remove unrelated/malformed files or fail application startup.
      }
    }
  };
  // Expiry is independent of the collection gate: a disabled or restarted run must still expire.
  restoreExpiry();
  app.use("*", async (c, next) => {
    const until = Date.parse(process.env.EXCELMANUS_QA_METRICS_UNTIL ?? "");
    const remaining = until - Date.now();
    if (
      process.env.EXCELMANUS_QA_METRICS !== "1" ||
      !process.env.EXCELMANUS_QA_SESSION_ID ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > RETENTION_MS
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  });
  app.post(
    "/first-screen-metrics",
    bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      const body = QaFirstScreenMetricsBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid_metrics" }, 400);
      if (
        body.data.sessionId !== process.env.EXCELMANUS_QA_SESSION_ID ||
        !deps.sessionExists(body.data.sessionId)
      )
        return c.json({ error: "qa_session_required" }, 403);

      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      restoreExpiry();
      const files = readdirSync(dir).filter((name) => RUN_FILE.test(name));
      const name = `${body.data.runId}.json`;
      if (files.includes(name)) return c.json({ error: "duplicate_run" }, 409);
      if (files.length >= MAX_RUNS) return c.json({ error: "qa_run_limit" }, 429);
      const path = join(dir, name);
      // sessionId is used solely for the gate, never persisted. No arbitrary fields survive parsing.
      writeFileSync(
        path,
        `${JSON.stringify({
          recordedAt: new Date(now).toISOString(),
          runId: body.data.runId,
          observations: body.data.observations,
        })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      restoreExpiry();
      return c.json({ ok: true });
    },
  );
  return app;
}
