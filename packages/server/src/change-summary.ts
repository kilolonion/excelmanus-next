// 变更摘要数据源（04 §11 第 1 条）：按工具调用 id 从 workbook 文档日志（doc_ops）
// 汇总修订区间。kernel 只定义接口，装配层组合 workbook 实现（模块互不依赖）。

import type { DatabaseSync } from "node:sqlite";
import type { RangeRef, StructuralOp } from "@excelmanus/core";
import type { ChangeSummarySource, DocChangeSummary } from "@excelmanus/kernel";
import { type DocumentService, summarizeWriteSet } from "@excelmanus/workbook";

interface OpRow {
  doc_id: string;
  rev: number;
  base_rev: number;
  write_set: string;
  inverse: string;
}

export function workbookChangeSummary(db: DatabaseSync, svc: DocumentService): ChangeSummarySource {
  return {
    async summarize({ sessionId, workspaceRoot, toolCallIds }) {
      if (toolCallIds.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT doc_id, rev, base_rev, write_set, inverse FROM doc_ops
           WHERE session_id = ? AND tool_call_id IN (${toolCallIds.map(() => "?").join(",")})
           ORDER BY doc_id, rev`,
        )
        .all(sessionId, ...toolCallIds) as unknown as OpRow[];
      const byDoc = new Map<string, OpRow[]>();
      for (const r of rows) byDoc.set(r.doc_id, [...(byDoc.get(r.doc_id) ?? []), r]);
      const out: DocChangeSummary[] = [];
      for (const [docId, ops] of byDoc) {
        const doc = db
          .prepare("SELECT path, workspace_id FROM documents WHERE id = ?")
          .get(docId) as { path: string; workspace_id: string } | undefined;
        if (!doc) continue;
        // 工作表名取当前快照；文档打不开时退回 sheetId（摘要不应让收尾失败）。
        const names = new Map<string, string>();
        // 删除工作表的前像仍含表名，不能把已删除表显示为内部 id。
        for (const op of ops) {
          const inverse = JSON.parse(op.inverse) as {
            snapshot?: { sheets?: Record<string, { name?: string }> };
          };
          for (const [id, s] of Object.entries(inverse.snapshot?.sheets ?? {}))
            names.set(id, s.name ?? id);
        }
        try {
          const { snapshot } = await svc.snapshot(docId, workspaceRoot);
          for (const [id, s] of Object.entries(snapshot.sheets ?? {})) {
            names.set(id, (s as { name?: string }).name ?? id);
          }
        } catch {}
        const writeSet: { ranges: RangeRef[]; structural: StructuralOp[] } = {
          ranges: [],
          structural: [],
        };
        for (const op of ops) {
          const ws = JSON.parse(op.write_set) as {
            ranges?: RangeRef[];
            structural?: StructuralOp[];
          };
          writeSet.ranges.push(...(ws.ranges ?? []));
          writeSet.structural.push(...(ws.structural ?? []));
        }
        const backup = db
          .prepare(
            "SELECT backup_path FROM backups WHERE workspace_id = ? AND session_id = ? AND original_path = ? AND kind = 'backup' ORDER BY created_at DESC LIMIT 1",
          )
          .get(doc.workspace_id, sessionId, doc.path) as { backup_path: string } | undefined;
        const first = ops[0] as OpRow;
        const last = ops[ops.length - 1] as OpRow;
        out.push({
          docId,
          path: doc.path,
          fromRev: first.rev - 1,
          toRev: last.rev,
          revs: ops.map((o) => o.rev),
          ...summarizeWriteSet(writeSet, names),
          ...(backup ? { backupPath: backup.backup_path } : {}),
        });
      }
      return out;
    },
  };
}
