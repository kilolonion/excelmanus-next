// 每轮变更摘要（04 §11 第 1 条、03 §6.2、05 §4.3）：运行时按本轮工具调用产生的
// 文档修订从文档日志生成，写 change.summary（不发给模型），子代理报告复用同一份。
// 文档日志属于 workbook 模块：kernel 只定义取摘要的接口，由 server 装配实现。

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./db.ts";
import type { Projection } from "./session-log.ts";

/** 一个文档在本轮的修订区间摘要。 */
export interface DocChangeSummary {
  docId: string;
  path: string;
  /** 本轮第一个修订之前的修订号。 */
  fromRev: number;
  toRev: number;
  /** 本轮实际提交的修订号（升序）；区间内可能夹有他人修订，只有这些属于本轮。 */
  revs: number[];
  /** 工作表名 → 改动的单元格数（区域并集去重；整行/整列/整表写入不计入，见 structural）。 */
  cellsBySheet: Record<string, number>;
  ranges: string[];
  /** 结构变化（插入/删除行列、增删改名工作表、移动区域）。 */
  structural: string[];
  /** 新增对象（新工作表等）。 */
  added: string[];
  backupPath?: string;
}

export interface ChangeSummarySource {
  /** 按工具调用 id 汇总其提交的全部文档修订；没有修订返回空数组。 */
  summarize(input: {
    sessionId: string;
    workspaceRoot: string;
    toolCallIds: string[];
  }): Promise<DocChangeSummary[]>;
}

export const CHANGE_SUMMARIES_MIGRATION: Migration = {
  id: "kernel/005-change-summaries",
  sql: `
  CREATE TABLE change_summaries (
    session_id TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    agent_id TEXT,
    turn_id TEXT,
    summary TEXT NOT NULL CHECK (json_valid(summary)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, turn_seq)
  ) WITHOUT ROWID;
`,
};

export const changeSummariesProjection: Projection = {
  name: "change_summaries",
  tables: ["change_summaries"],
  apply(db: DatabaseSync, rec) {
    if (rec.type !== "change.summary") return;
    const changes = rec.data.changes as { turnId?: unknown } | undefined;
    db.prepare(
      "INSERT INTO change_summaries (session_id, turn_seq, agent_id, turn_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      rec.sessionId,
      rec.seq,
      rec.agentId,
      typeof changes?.turnId === "string" ? changes.turnId : null,
      JSON.stringify(rec.data),
      rec.createdAt,
    );
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM change_summaries");
    else db.prepare("DELETE FROM change_summaries WHERE session_id = ?").run(sessionId);
  },
};

/** 报告与界面共用的一行文字。 */
export function describeDocChange(c: DocChangeSummary): string {
  const sheets = Object.entries(c.cellsBySheet).map(([s, n]) => `${s} ${n} 格`);
  // 只列本轮实际修订；连续时写成区间，夹有他人修订时逐个列出。
  const revs = c.revs.length > 0 ? c.revs : [c.toRev];
  const first = revs[0] as number;
  const last = revs[revs.length - 1] as number;
  const revText =
    revs.length === 1
      ? `rev${first}`
      : last - first + 1 === revs.length
        ? `rev${first}–rev${last}`
        : revs.map((r) => `rev${r}`).join("、");
  const parts = [
    `${c.path}（修订 ${revText}）`,
    ...(sheets.length > 0 ? [`单元格：${sheets.join("、")}`] : []),
    ...(c.structural.length > 0 ? [`结构：${c.structural.join("、")}`] : []),
    ...(c.added.length > 0 ? [`新增：${c.added.join("、")}`] : []),
    ...(c.backupPath ? [`备份：${c.backupPath}`] : []),
  ];
  return parts.join("；");
}
