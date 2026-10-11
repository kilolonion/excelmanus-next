import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@excelmanus/core";
import {
  DiagnosticExportBody,
  DiagnosticLogEvent,
  DiagnosticQuery,
  type DiagnosticTrace,
  protocolVersion,
} from "@excelmanus/protocol";
import { Hono } from "hono";
import type { FailFn } from "./app.ts";

/** 日志只允许排障元数据；不从请求/模型/文件对象枚举字段。 */
const FIELD_NAMES = new Set([
  "requestId",
  "sessionId",
  "agentId",
  "toolCallId",
  "turnId",
  "stepId",
  "method",
  "route",
  "status",
  "port",
  "count",
  "durationMs",
  "code",
]);
export function appendDiagnosticLog(
  dataDir: string,
  event: string,
  fields: Record<string, string | number | boolean>,
  redact: (text: string) => string,
): void {
  const at = nowIso();
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => FIELD_NAMES.has(key))
      .map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value).slice(0, 256) : value,
      ]),
  );
  appendFileSync(
    join(dir, `${at.slice(0, 10)}.jsonl`),
    `${JSON.stringify({ t: at, event: redact(event), ...safe })}\n`,
    { mode: 0o600 },
  );
}

export function diagnosticRoutes(db: DatabaseSync, fail: FailFn, dataDir: string): Hono {
  const app = new Hono();
  const traces = (sessionId: string | undefined, limit: number) => {
    // Only select named metadata/numeric fields, never prompt/tool argument/result bodies.
    const items = db
      .prepare(
        `SELECT session_id AS sessionId, seq, agent_id AS agentId, type, created_at AS createdAt,
        json_extract(data, '$.turnId') AS rawTurnId,
        json_extract(data, '$.stepId') AS rawStepId,
        json_extract(data, '$.usage.inputTokens') AS rawInputTokens,
        json_extract(data, '$.usage.outputTokens') AS rawOutputTokens
        FROM session_log ${sessionId ? "WHERE session_id = ?" : ""} ORDER BY created_at DESC, seq DESC LIMIT ?`,
      )
      .all(...(sessionId ? [sessionId, limit + 1] : [limit + 1])) as unknown as (DiagnosticTrace & {
      rawTurnId: unknown;
      rawStepId: unknown;
      rawInputTokens: unknown;
      rawOutputTokens: unknown;
    })[];
    const starts = new Map<string, number>();
    const safeItems = items
      .slice(0, limit)
      .reverse()
      .map((row) => {
        const { rawTurnId, rawStepId, rawInputTokens, rawOutputTokens, ...item } = row;
        if (typeof rawTurnId === "string" && /^trn_[A-Za-z0-9_-]{1,64}$/.test(rawTurnId))
          item.turnId = rawTurnId;
        if (typeof rawStepId === "string" && /^stp_[A-Za-z0-9_-]{1,64}$/.test(rawStepId))
          item.stepId = rawStepId;
        // usage.updated is the canonical token event; avoid counting turn.completed twice.
        if (item.type === "usage.updated") {
          if (
            typeof rawInputTokens === "number" &&
            Number.isFinite(rawInputTokens) &&
            rawInputTokens >= 0
          )
            item.inputTokens = rawInputTokens;
          if (
            typeof rawOutputTokens === "number" &&
            Number.isFinite(rawOutputTokens) &&
            rawOutputTokens >= 0
          )
            item.outputTokens = rawOutputTokens;
        }
        const key = `${item.sessionId}/${item.agentId}/${item.stepId}`;
        if (item.type === "step.started" && item.stepId)
          starts.set(key, Date.parse(item.createdAt));
        if (item.type === "model.output" && item.stepId && starts.has(key)) {
          const duration = Date.parse(item.createdAt) - (starts.get(key) ?? 0);
          if (Number.isFinite(duration) && duration >= 0) item.durationMs = duration;
        }
        return item;
      })
      .reverse();
    return { items: safeItems, truncated: items.length > limit };
  };
  app.get("/diagnostics/traces", (c) => {
    const parsed = DiagnosticQuery.safeParse(c.req.query());
    if (!parsed.success) return fail(c, 400, "bad_request", "诊断查询参数无效");
    return c.json(traces(parsed.data.sessionId, parsed.data.limit));
  });
  app.post("/diagnostics/export", async (c) => {
    const parsed = DiagnosticExportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "诊断导出参数无效");
    c.header("Content-Disposition", 'attachment; filename="excelmanus-diagnostics.json"');
    return c.json({
      protocolVersion,
      generatedAt: nowIso(),
      nodeVersion: process.version,
      platform: process.platform,
      traces: traces(parsed.data.sessionId, 2000),
      ...recentLogs(dataDir),
    });
  });
  return app;
}

/** Read bounded tails from regular daily log files; never traverse symlinks or export raw lines. */
function recentLogs(dataDir: string) {
  const logs: ReturnType<typeof DiagnosticLogEvent.parse>[] = [];
  let truncated = false;
  try {
    const dir = join(dataDir, "logs");
    const files = readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();
    truncated = files.length > 2;
    for (const name of files.slice(0, 2)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, "r");
      let read = 0;
      try {
        read = readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        closeSync(fd);
      }
      const lines = buffer.subarray(0, read).toString("utf8").split("\n");
      if (length < stat.size) {
        lines.shift();
        truncated = true;
      }
      for (const line of lines.reverse()) {
        if (!line) continue;
        if (logs.length >= 2000) {
          truncated = true;
          break;
        }
        try {
          const parsed = DiagnosticLogEvent.safeParse(JSON.parse(line));
          if (parsed.success) logs.push(parsed.data);
        } catch {
          /* Ignore partial line from a concurrent append. */
        }
      }
    }
  } catch {
    /* Diagnostics are still available if the optional log directory is unreadable. */
  }
  return { logs, logsTruncated: truncated };
}
