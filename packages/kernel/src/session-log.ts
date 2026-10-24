// SessionLog：会话日志唯一事实源（03 §3.1 硬性）。
// append：同一事务内分配 seq、写 session_log、调用全部已注册 Projection.apply；
// 事务提交后才经 SyncBus 推送（先持久化，再发布，04 §2）。
// rebuild：清表后按序重放，投影必须可重建（CI 有"重建 = 增量"测试）。

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@excelmanus/core";
import {
  createHistoryWindowBoundary,
  HISTORY_WINDOW_MAX_RECORDS,
  HISTORY_WINDOW_PAGE_SIZE,
  type LogRecord,
  parseRecordData,
} from "@excelmanus/protocol";
import type { SyncBus } from "./bus.ts";

export interface NewRecord {
  type: string;
  data: unknown;
}

/** 物化投影：从日志记录增量维护，可清表重建。 */
export interface Projection {
  readonly name: string;
  /** 本投影写入的表（重建时清空）。 */
  readonly tables: readonly string[];
  apply(db: DatabaseSync, rec: LogRecord): void;
  /** 清空投影表；sessionId 为空时全清。 */
  clear(db: DatabaseSync, sessionId?: string): void;
}

interface LogRow {
  session_id: string;
  seq: number;
  agent_id: string | null;
  type: string;
  data: string;
  created_at: string;
}

function rowToRecord(row: LogRow): LogRecord {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    agentId: row.agent_id,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/** 写入前脱敏（10 §4）：对记录数据中的每个字符串值（含对象键）调用 redact。 */
function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, redact);
    return out;
  }
  return value;
}

export class SessionLog {
  private readonly db: DatabaseSync;
  private readonly bus?: SyncBus;
  private readonly projections: Projection[] = [];
  private readonly redact?: (text: string) => string;
  /** 本进程内已删除的会话（id 不复用）。 */
  private readonly deleted = new Set<string>();

  constructor(
    db: DatabaseSync,
    opts: {
      projections?: Projection[];
      bus?: SyncBus;
      /** 会话日志写入前过滤密钥（10 §4 硬性）：由装配层注入按已登记凭据精确替换的函数。 */
      redact?: (text: string) => string;
    } = {},
  ) {
    this.db = db;
    this.bus = opts.bus;
    this.redact = opts.redact;
    for (const p of opts.projections ?? []) this.register(p);
  }

  register(projection: Projection): void {
    this.projections.push(projection);
  }

  get dbHandle(): DatabaseSync {
    return this.db;
  }

  /**
   * 删除会话（10 §6）：同一事务删除其会话日志并调用全部投影的 clear(sessionId)，
   * `extra` 在同事务清理非投影的会话数据（租约等）。之后该会话的 append 一律
   * 拒绝写入（返回空），迟到的 actor 收尾不能把会话"写回来"。
   */
  deleteSession(sessionId: string, extra?: (db: DatabaseSync) => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM session_log WHERE session_id = ?").run(sessionId);
      for (const p of this.projections) p.clear(this.db, sessionId);
      extra?.(this.db);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.deleted.add(sessionId);
  }

  isDeleted(sessionId: string): boolean {
    return this.deleted.has(sessionId);
  }

  /** 追加记录：事务内写日志 + 更新全部投影，提交后发布。已删除会话拒绝写入。 */
  append(sessionId: string, agentId: string | null, records: NewRecord[]): LogRecord[] {
    if (records.length === 0 || this.deleted.has(sessionId)) return [];
    const redact = this.redact;
    const created = records.map((r) => {
      const data = parseRecordData(r.type, r.data) as Record<string, unknown>;
      return {
        type: r.type,
        data: redact ? (redactDeep(data, redact) as Record<string, unknown>) : data,
      };
    });
    const createdAt = nowIso();
    const out: LogRecord[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const head = (
        this.db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM session_log WHERE session_id = ?")
          .get(sessionId) as { m: number }
      ).m;
      const insert = this.db.prepare(
        "INSERT INTO session_log (session_id, seq, agent_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      created.forEach((r, i) => {
        const rec: LogRecord = {
          seq: head + i + 1,
          sessionId,
          agentId,
          type: r.type,
          data: r.data,
          createdAt,
        };
        insert.run(sessionId, rec.seq, agentId, r.type, JSON.stringify(rec.data), createdAt);
        for (const p of this.projections) p.apply(this.db, rec);
        out.push(rec);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (this.bus) {
      for (const rec of out) this.bus.publish({ kind: "rec", rec });
    }
    return out;
  }

  headSeq(sessionId: string): number {
    return (
      this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM session_log WHERE session_id = ?")
        .get(sessionId) as { m: number }
    ).m;
  }

  /** seq > after 的记录（升序），供同步通道续传。 */
  readAfter(sessionId: string, after: number, limit: number): LogRecord[] {
    const rows = this.db
      .prepare(
        "SELECT session_id, seq, agent_id, type, data, created_at FROM session_log WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sessionId, after, limit) as unknown as LogRow[];
    return rows.map(rowToRecord);
  }

  /** 向前分页（11 §4）：seq < before（为空=最新）的最近 limit 条，升序返回。 */
  readBefore(sessionId: string, before: number | undefined, limit: number): LogRecord[] {
    const rows = (before === undefined
      ? this.db
          .prepare(
            "SELECT session_id, seq, agent_id, type, data, created_at FROM session_log WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
          )
          .all(sessionId, limit)
      : this.db
          .prepare(
            "SELECT session_id, seq, agent_id, type, data, created_at FROM session_log WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
          )
          .all(sessionId, before, limit)) as unknown as LogRow[];
    return rows.reverse().map(rowToRecord);
  }

  /** Caller holds a short read snapshot; inspect bounded metadata before materializing JSON. */
  readHistoryWindow(
    sessionId: string,
    headSeq: number,
    byteBudget: number,
  ):
    | { kind: "complete"; items: LogRecord[]; hasMore: boolean; before?: number }
    | { kind: "overflow"; reason: "records" | "bytes" } {
    const metadata = this.db
      .prepare(`
      SELECT seq,
        CASE WHEN agent_id = 'main' THEN 'main' ELSE NULL END AS agentId,
        CASE WHEN type IN ('user.message','turn.started','model.output','step.started') THEN type ELSE '' END AS type,
        length(CAST(data AS BLOB)) + 6 * (length(CAST(session_id AS BLOB)) +
          coalesce(length(CAST(agent_id AS BLOB)),0) + length(CAST(type AS BLOB)) +
          length(CAST(created_at AS BLOB))) AS bytes
      FROM session_log WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?
    `)
      .all(sessionId, headSeq, HISTORY_WINDOW_MAX_RECORDS + 1) as unknown as {
      seq: number;
      agentId: string | null;
      type: string;
      bytes: number;
    }[];
    if (metadata.length === 0) return { kind: "complete", items: [], hasMore: false };
    const boundary = createHistoryWindowBoundary();
    let selected: { seq: number; bytes: number }[] = [];
    let hasMore = false;
    let found = false;
    for (
      let offset = 0;
      offset < Math.min(metadata.length, HISTORY_WINDOW_MAX_RECORDS);
      offset += HISTORY_WINDOW_PAGE_SIZE
    ) {
      const page = metadata
        .slice(offset, Math.min(offset + HISTORY_WINDOW_PAGE_SIZE, HISTORY_WINDOW_MAX_RECORDS))
        .reverse();
      // A partial logical page that does not reach session start must never invent a boundary.
      if (page.length < HISTORY_WINDOW_PAGE_SIZE && page[0]?.seq !== 1) break;
      const result = boundary.push(page);
      selected = [...(result ? page.slice(result.startIndex) : page), ...selected];
      if (result) {
        hasMore = result.hasMore;
        found = true;
        break;
      }
    }
    if (!found) return { kind: "overflow", reason: "records" };
    if (selected.reduce((sum, row) => sum + row.bytes + 192, 0) > byteBudget)
      return { kind: "overflow", reason: "bytes" };
    const statement = this.db.prepare(
      "SELECT session_id,seq,agent_id,type,data,created_at FROM session_log WHERE session_id=? AND seq=?",
    );
    const items: LogRecord[] = [];
    let bytes = 2;
    for (const meta of selected) {
      const row = statement.get(sessionId, meta.seq) as unknown as LogRow;
      const record = rowToRecord(row);
      bytes += Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
      if (bytes > byteBudget) return { kind: "overflow", reason: "bytes" };
      items.push(record);
    }
    return {
      kind: "complete",
      items,
      hasMore,
      ...(hasMore && items[0] ? { before: items[0].seq } : {}),
    };
  }

  /** 删除投影表后从日志按序重放（sessionId 为空时重建全部会话）。 */
  rebuild(sessionId?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of this.projections) p.clear(this.db, sessionId);
      const rows = (sessionId === undefined
        ? this.db
            .prepare(
              "SELECT session_id, seq, agent_id, type, data, created_at FROM session_log ORDER BY session_id, seq",
            )
            .all()
        : this.db
            .prepare(
              "SELECT session_id, seq, agent_id, type, data, created_at FROM session_log WHERE session_id = ? ORDER BY seq",
            )
            .all(sessionId)) as unknown as LogRow[];
      for (const row of rows) {
        const rec = rowToRecord(row);
        for (const p of this.projections) p.apply(this.db, rec);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
