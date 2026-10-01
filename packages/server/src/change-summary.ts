// 变更摘要数据源（04 §11 第 1 条）：按工具调用 id 从 workbook 文档日志（doc_ops）
// 汇总修订区间。kernel 只定义接口，装配层组合 workbook 实现（模块互不依赖）。

import type { DatabaseSync } from "node:sqlite";
import { MAX_C, MAX_R, type RangeRef, rangeRefToA1, type StructuralOp } from "@excelmanus/core";
import type { ChangeSummarySource, DocChangeSummary } from "@excelmanus/kernel";
import type { DocumentService } from "@excelmanus/workbook";

const STRUCTURAL_LABELS: Record<StructuralOp["kind"], string> = {
  insertRows: "插入行",
  deleteRows: "删除行",
  insertCols: "插入列",
  deleteCols: "删除列",
  insertSheet: "新增工作表",
  removeSheet: "删除工作表",
  renameSheet: "重命名工作表",
  moveRange: "移动区域",
};

interface OpRow {
  doc_id: string;
  rev: number;
  base_rev: number;
  write_set: string;
}

/** 区域并集的单元格数（同一轮重复写同一区域只计一次）：按列边界切条，条内合并行区间。 */
export function unionArea(rects: RangeRef[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r.c0, r.c1 + 1]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    const spans = rects
      .filter((r) => r.c0 <= x0 && r.c1 + 1 >= x1)
      .map((r) => [r.r0, r.r1 + 1] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -1;
    for (const [s, e] of spans) {
      if (e <= end) continue;
      covered += e - Math.max(s, end);
      end = e;
    }
    total += covered * (x1 - x0);
  }
  return total;
}

export function workbookChangeSummary(db: DatabaseSync, svc: DocumentService): ChangeSummarySource {
  return {
    async summarize({ sessionId, workspaceRoot, toolCallIds }) {
      if (toolCallIds.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT doc_id, rev, base_rev, write_set FROM doc_ops
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
        try {
          const { snapshot } = await svc.snapshot(docId, workspaceRoot);
          for (const [id, s] of Object.entries(snapshot.sheets ?? {})) {
            names.set(id, (s as { name?: string }).name ?? id);
          }
        } catch {}
        const nameOf = (id: string) => names.get(id) ?? id;
        const rectsBySheet = new Map<string, RangeRef[]>();
        const ranges: string[] = [];
        const structural: string[] = [];
        const added: string[] = [];
        for (const op of ops) {
          const ws = JSON.parse(op.write_set) as {
            ranges?: RangeRef[];
            structural?: StructuralOp[];
          };
          for (const r of ws.ranges ?? []) {
            // 整行/整列/整表区域属于结构变化，不计入单元格数
            if (r.sheetId === "*" || r.r1 >= MAX_R || r.c1 >= MAX_C) continue;
            const name = nameOf(r.sheetId);
            rectsBySheet.set(name, [...(rectsBySheet.get(name) ?? []), r]);
            const a1 = rangeRefToA1(r, name);
            if (!ranges.includes(a1)) ranges.push(a1);
          }
          for (const s of ws.structural ?? []) {
            const where =
              s.count > 0
                ? `${nameOf(s.sheetId)} 第 ${s.index + 1} 起 ${s.count} 个`
                : nameOf(s.sheetId);
            structural.push(`${STRUCTURAL_LABELS[s.kind] ?? s.kind}（${where}）`);
            if (s.kind === "insertSheet") added.push(`工作表 ${nameOf(s.sheetId)}`);
          }
        }
        const backup = db
          .prepare(
            "SELECT backup_path FROM backups WHERE workspace_id = ? AND session_id = ? AND original_path = ? AND kind = 'backup' ORDER BY created_at DESC LIMIT 1",
          )
          .get(doc.workspace_id, sessionId, doc.path) as { backup_path: string } | undefined;
        const cellsBySheet: Record<string, number> = {};
        for (const [name, rects] of rectsBySheet) cellsBySheet[name] = unionArea(rects);
        const first = ops[0] as OpRow;
        const last = ops[ops.length - 1] as OpRow;
        out.push({
          docId,
          path: doc.path,
          fromRev: first.rev - 1,
          toRev: last.rev,
          revs: ops.map((o) => o.rev),
          cellsBySheet,
          ranges,
          structural,
          added,
          ...(backup ? { backupPath: backup.backup_path } : {}),
        });
      }
      return out;
    },
  };
}
