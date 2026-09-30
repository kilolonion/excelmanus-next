// DocumentService（07 §3）：活文档 actor 的 M1 只读版——主线程进程内实现。
// open 登记 documents 表（rev 从 0 起），导入产物是 IWorkbookData 快照；
// 快照对外一律深拷贝返回（ADR 0003 快照定影）。无 doc_ops 写入路径。

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import { PathSafetyError, resolveWorkspacePath } from "@excelmanus/kernel";
import type { DocKind } from "@excelmanus/protocol";
import type { IWorkbookData } from "@univerjs/core";
import { importCsv } from "./csv.ts";
import { type ImportedWorkbook, importXlsx } from "./xlsx.ts";

export interface DocumentMeta {
  id: string;
  workspaceId: string;
  path: string;
  kind: DocKind;
  rev: number;
  createdAt: string;
}

export class DocNotFoundError extends Error {
  constructor(docId: string) {
    super(`文档不存在：${docId}`);
    this.name = "DocNotFoundError";
  }
}

export class UnsupportedDocError extends Error {
  constructor(path: string) {
    super(`不支持的文档类型（仅支持 .xlsx/.csv）：${path}`);
    this.name = "UnsupportedDocError";
  }
}

interface DocEntry {
  meta: DocumentMeta;
  snapshot: IWorkbookData;
  imported: ImportedWorkbook;
}

export interface OpenedDoc {
  meta: DocumentMeta;
  imported: ImportedWorkbook;
}

export const DOCUMENTS_MIGRATION = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  UNIQUE (workspace_id, path)
);
`;

export class DocumentService {
  private readonly docs = new Map<string, DocEntry>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // 上次进程内已登记过的文档恢复为「可引用」状态：重启后重新 open 会复用 docId。
  }

  /** 打开（或复开）工作区内文档：解析 → 登记/复用 documents 行 → {docId, rev}。 */
  open(workspaceId: string, workspaceRoot: string, relPath: string): OpenedDoc {
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new PathSafetyError("NOT_FOUND", `路径不存在：${relPath}`);
    }
    if (!st.isFile()) throw new PathSafetyError("NOT_FOUND", `不是文件：${relPath}`);
    const ext = extname(rel).toLowerCase();
    const kind: DocKind =
      ext === ".xlsx" || ext === ".xlsm"
        ? "xlsx"
        : ext === ".csv" || ext === ".tsv"
          ? "csv"
          : (() => {
              throw new UnsupportedDocError(relPath);
            })();
    const bytes = readFileSync(abs);
    const imported = kind === "xlsx" ? importXlsx(bytes, rel) : importCsv(bytes, rel);

    const existing = this.db
      .prepare("SELECT * FROM documents WHERE workspace_id = ? AND path = ?")
      .get(workspaceId, rel) as
      | {
          id: string;
          workspace_id: string;
          path: string;
          kind: string;
          rev: number;
          created_at: string;
          last_opened_at: string;
        }
      | undefined;
    const now = nowIso();
    let meta: DocumentMeta;
    if (existing) {
      this.db
        .prepare("UPDATE documents SET last_opened_at = ?, kind = ? WHERE id = ?")
        .run(now, kind, existing.id);
      meta = {
        id: existing.id,
        workspaceId: existing.workspace_id,
        path: existing.path,
        kind: kind as DocKind,
        rev: existing.rev,
        createdAt: existing.created_at,
      };
    } else {
      const id = newId("doc");
      this.db
        .prepare(
          "INSERT INTO documents (id, workspace_id, path, kind, rev, created_at, last_opened_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
        )
        .run(id, workspaceId, rel, kind, now, now);
      meta = { id, workspaceId, path: rel, kind, rev: 0, createdAt: now };
    }
    this.docs.set(meta.id, { meta, snapshot: imported.snapshot, imported });
    return { meta, imported };
  }

  /** 拿条目；未在内存时按 documents 行从工作区重新导入（进程重启后）。 */
  entry(docId: string, workspaceRoot: string): DocEntry {
    const hit = this.docs.get(docId);
    if (hit) return hit;
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as
      | { workspace_id: string; path: string }
      | undefined;
    if (!row) throw new DocNotFoundError(docId);
    const opened = this.open(row.workspace_id, workspaceRoot, row.path);
    const entry = this.docs.get(opened.meta.id);
    if (!entry) throw new DocNotFoundError(docId);
    return entry;
  }

  /** 深拷贝快照（07 §3：调用方拿到的永远是副本）。 */
  snapshot(docId: string, workspaceRoot: string): { meta: DocumentMeta; snapshot: IWorkbookData } {
    const e = this.entry(docId, workspaceRoot);
    return { meta: e.meta, snapshot: structuredClone(e.snapshot) };
  }

  meta(docId: string): DocumentMeta | undefined {
    return this.docs.get(docId)?.meta;
  }
}
