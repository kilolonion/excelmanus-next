// SessionLog：会话日志唯一事实源（03 §3.1 硬性）。
// append：同一事务内分配 seq、写 session_log、调用全部已注册 Projection.apply；
// 事务提交后才经 SyncBus 推送（先持久化，再发布，04 §2）。
// rebuild：清表后按序重放，投影必须可重建（CI 有"重建 = 增量"测试）。

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@excelmanus/core";
import { type LogRecord, parseRecordData } from "@excelmanus/protocol";
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

export class SessionLog {
  private readonly db: DatabaseSync;
  private readonly bus?: SyncBus;
  private readonly projections: Projection[] = [];

  constructor(db: DatabaseSync, opts: { projections?: Projection[]; bus?: SyncBus } = {}) {
    this.db = db;
    this.bus = opts.bus;
    for (const p of opts.projections ?? []) this.register(p);
  }

  register(projection: Projection): void {
    this.projections.push(projection);
  }

  get dbHandle(): DatabaseSync {
    return this.db;
  }

  /** 追加记录：事务内写日志 + 更新全部投影，提交后发布。 */
  append(sessionId: string, agentId: string | null, records: NewRecord[]): LogRecord[] {
    if (records.length === 0) return [];
    const created = records.map((r) => ({
      type: r.type,
      data: parseRecordData(r.type, r.data) as Record<string, unknown>,
    }));
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
