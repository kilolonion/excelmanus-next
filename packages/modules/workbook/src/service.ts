// DocumentService（07 §3）：活文档 actor——每个打开的文档持有一个 Univer 无头
// 实例（主线程，ADR 0003），提交串行处理，修订号严格递增，doc_ops 追加写日志。
// 快照定影：createWorkbook 前深拷贝；对外 snapshot() 一律返回 getSnapshot 深拷贝。
// 冲突检测：baseRev 之后的写集 ∩（变换后的读集 ∪ 写集），结构操作按 03 §6.1 变换。

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  indexToCol,
  MAX_C,
  MAX_R,
  newId,
  nowIso,
  type RangeRef,
  rangeIntersection,
  rangeRefToA1,
  type StructuralOp,
  transformRange,
} from "@excelmanus/core";
import {
  atomicWrite,
  BackupService,
  FileOperationError,
  type Migration,
  PathSafetyError,
  resolveWorkspacePath,
  sha256,
} from "@excelmanus/kernel";
import type { DocKind, FileIntentMeta, ToolResult } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { assertWritable, exportXlsx, minimalXlsx, verifyXlsx } from "./checkpoint.ts";
import { exportCsv, importCsv } from "./csv.ts";
import {
  type Booted,
  bootUniver,
  createBook,
  type DocMutation,
  ENGINE_VERSION,
  MutationCapture,
} from "./engine.ts";
import { makeInverse, type Snap, snapshotRestoreMutations } from "./inverse.ts";
import {
  type ChangeOp,
  type CompiledOps,
  compileOps,
  OpCompileError,
  transformChangeOp,
  transformMutation,
} from "./ops.ts";
import { fixupMutationForTransport, reconcileFilterResource } from "./transport.ts";
import { deriveWriteSetAll } from "./writeset.ts";
import { type ImportedWorkbook, importXlsx } from "./xlsx.ts";

const MAX_SUBMIT_CELLS = 200_000;
const MAX_PREVIEW_CELLS = 2000;
const MAX_CONFLICT_CELLS = 50;

export interface DocumentMeta {
  id: string;
  workspaceId: string;
  path: string;
  kind: DocKind;
  rev: number;
  createdAt: string;
  checkpointRev?: number;
  checkpointError?: string;
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

export const DOCUMENTS_MIGRATION: Migration = {
  id: "workbook/documents",
  sql: `
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
`,
};

/** M2a：修订跟踪 + 追加型文档操作日志（不改已有迁移）。 */
export const DOC_OPS_MIGRATION: Migration = {
  id: "workbook/doc-ops",
  sql: `
ALTER TABLE documents ADD COLUMN head_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN checkpoint_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN engine_version TEXT NOT NULL DEFAULT '${ENGINE_VERSION}';
UPDATE documents SET head_rev = rev;
CREATE TABLE doc_ops (
  doc_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  base_rev INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  session_id TEXT,
  tool_call_id TEXT,
  write_set TEXT NOT NULL,
  mutations TEXT NOT NULL,
  inverse TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, rev)
);
CREATE INDEX doc_ops_tool_call ON doc_ops(tool_call_id);
`,
};

export const CHECKPOINT_MIGRATION: Migration = {
  id: "workbook/doc-checkpoints",
  sql: `
ALTER TABLE documents ADD COLUMN checkpoint_hash TEXT;
ALTER TABLE documents ADD COLUMN checkpoint_snapshot TEXT;
CREATE TABLE doc_checkpoints (
  doc_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL
);
`,
};

export interface DocWriteSet {
  ranges: RangeRef[];
  structural: StructuralOp[];
}

export type SubmitSourceKind = "user" | "agent" | "script" | "engine" | "external";

export interface SubmitSource {
  kind: SubmitSourceKind;
  id: string;
}

export interface SubmitBatch {
  baseRev: number;
  /** 提交者依据读过的区域；省略时用户来源用其写集（= 读集即写集）。 */
  readSet?: RangeRef[];
  source: SubmitSource;
  sessionId?: string;
  toolCallId?: string;
  /** agent 来源：ChangeOp 编译执行。 */
  ops?: ChangeOp[];
  /** user 来源：工作台 mutation 复现（经传输修补）。 */
  mutations?: DocMutation[];
  dryRun?: boolean;
  /** 用户提交的传输修补需要发送方快照（可选）。 */
  senderSnapshot?: unknown;
}

export interface ConflictDetail {
  rev: number;
  source: string;
  /** A1 记法（最多 50）。 */
  cells: string[];
}

export interface PreviewRegion {
  range: string;
  values: unknown[][];
}

export interface SubmitOk {
  ok: true;
  docId: string;
  rev: number;
  dryRun: boolean;
  writeSet: DocWriteSet;
  mutations: DocMutation[];
  formulas: string[];
  preview?: PreviewRegion[];
  backupPath?: string;
}

export interface SubmitFail {
  ok: false;
  code:
    | "VERSION_CONFLICT"
    | "LIMIT_EXCEEDED"
    | "DOC_NOT_FOUND"
    | "BAD_OPERATION"
    | "UNSUPPORTED_FEATURE"
    | "INTERNAL";
  message: string;
  conflicts?: ConflictDetail[];
}

export type SubmitResult = SubmitOk | SubmitFail;

export interface DocOpRecord {
  rev: number;
  baseRev: number;
  sourceKind: string;
  sourceId: string | null;
  sessionId: string | null;
  toolCallId: string | null;
  writeSet: DocWriteSet;
  mutations: DocMutation[];
  createdAt: string;
}

interface LiveDoc {
  boot: Booted;
  capture: MutationCapture;
  unitId: string;
  save(): IWorkbookData;
}

interface DocEntry {
  meta: DocumentMeta;
  imported: ImportedWorkbook;
  live: LiveDoc;
  /** 文档 actor 串行队列：所有提交/读快照经它排队。 */
  tail: Promise<unknown>;
  workspaceRoot: string;
  checkpointSnapshot: IWorkbookData;
  checkpointHash: string;
  checkpointRev: number;
  timer?: ReturnType<typeof setTimeout>;
  paused?: boolean;
}

interface DocRow {
  id: string;
  workspace_id: string;
  path: string;
  kind: string;
  rev: number;
  head_rev: number;
  checkpoint_rev: number;
  engine_version: string;
  checkpoint_hash: string | null;
  checkpoint_snapshot: string | null;
  created_at: string;
  last_opened_at: string;
}

const docMutationId = /^[\w-]+\.mutation\.[\w-]+$/;

function normalizeMutations(raw: unknown): DocMutation[] {
  if (!Array.isArray(raw)) throw new OpCompileError("mutations 必须是数组");
  return raw.map((m) => {
    const o = m as { id?: unknown; params?: unknown };
    if (!o || typeof o.id !== "string" || !docMutationId.test(o.id)) {
      throw new OpCompileError(`非法 mutation id：${String(o?.id)}`);
    }
    try {
      return {
        id: o.id,
        params: o.params === undefined ? {} : JSON.parse(JSON.stringify(o.params)),
      };
    } catch {
      throw new OpCompileError("mutation params 不可序列化");
    }
  });
}

export class DocumentService {
  private readonly docs = new Map<string, Promise<DocEntry>>();
  private readonly metas = new Map<string, DocumentMeta>();
  private readonly db: DatabaseSync;
  /** 新修订提交后回调（server 订阅做 doc.op 广播）。 */
  onRevision:
    | ((docId: string, rev: number, source: string, mutations: DocMutation[]) => void)
    | undefined;

  private readonly backups: BackupService;
  private watchTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  onCheckpoint: ((docId: string, rev: number, error?: string) => void) | undefined;

  constructor(db: DatabaseSync, backups = new BackupService(db)) {
    this.db = db;
    this.backups = backups;
  }

  // ---------- 打开 / 恢复 ----------

  /** 打开（或复开）工作区内文档：导入 → 建 Univer 实例 → 重放 doc_ops → {docId, rev}。 */
  async open(workspaceId: string, workspaceRoot: string, relPath: string): Promise<OpenedDoc> {
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
      .get(workspaceId, rel) as DocRow | undefined;
    const cached = existing ? await this.docs.get(existing.id) : undefined;
    if (cached) {
      await this.enqueue(cached, () => this.checkExternal(cached));
      return { meta: cached.meta, imported: cached.imported };
    }
    const now = nowIso();
    let docId: string;
    let headRev: number;
    let checkpointRev: number;
    if (existing) {
      docId = existing.id;
      headRev = existing.head_rev;
      checkpointRev = existing.checkpoint_rev;
      this.db
        .prepare("UPDATE documents SET last_opened_at = ?, kind = ? WHERE id = ?")
        .run(now, kind, docId);
    } else {
      docId = newId("doc");
      headRev = 0;
      checkpointRev = 0;
      this.db
        .prepare(
          "INSERT INTO documents (id, workspace_id, path, kind, rev, head_rev, checkpoint_rev, engine_version, created_at, last_opened_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)",
        )
        .run(docId, workspaceId, rel, kind, ENGINE_VERSION, now, now);
    }
    const hash = sha256(bytes);
    const pending = this.db.prepare("SELECT * FROM doc_checkpoints WHERE doc_id=?").get(docId) as
      | { rev: number; hash: string; snapshot: string }
      | undefined;
    let savedSnapshot = existing?.checkpoint_snapshot;
    let savedHash = existing?.checkpoint_hash;
    if (pending?.hash === hash) {
      checkpointRev = pending.rev;
      savedSnapshot = pending.snapshot;
      savedHash = hash;
      this.db
        .prepare(
          "UPDATE documents SET checkpoint_rev=?, checkpoint_hash=?, checkpoint_snapshot=? WHERE id=?",
        )
        .run(checkpointRev, hash, savedSnapshot, docId);
      this.db.prepare("DELETE FROM doc_checkpoints WHERE doc_id=?").run(docId);
    }
    if (savedHash && savedHash !== hash && headRev > checkpointRev)
      throw new FileOperationError("VERSION_CONFLICT", "外部文件与未写回日志冲突，已暂停写回");
    if (savedHash === hash && savedSnapshot) {
      const snap = JSON.parse(savedSnapshot) as IWorkbookData;
      this.remapPreservation(imported, snap);
      imported.snapshot = snap;
    }
    this.db
      .prepare("UPDATE documents SET checkpoint_hash=COALESCE(checkpoint_hash,?) WHERE id=?")
      .run(hash, docId);
    const entry = await this.materialize(
      docId,
      workspaceId,
      rel,
      kind,
      imported,
      checkpointRev,
      headRev,
      existing?.created_at ?? now,
      workspaceRoot,
      hash,
    );
    if (savedHash && savedHash !== hash && headRev === checkpointRev)
      await this.enqueue(entry, () => this.reloadExternal(entry, bytes));
    if (headRev > checkpointRev && !entry.paused) {
      try {
        await this.enqueue(entry, () => this.doCheckpoint(entry));
      } catch {
        this.schedule(entry, 5000);
      }
    }
    return { meta: entry.meta, imported: entry.imported };
  }

  /** 建活实例：快照定影（深拷贝）→ createWorkbook → 重放 checkpoint 之后的 doc_ops。 */
  private async materialize(
    docId: string,
    workspaceId: string,
    path: string,
    kind: DocKind,
    imported: ImportedWorkbook,
    checkpointRev: number,
    headRev: number,
    createdAt: string,
    workspaceRoot: string,
    hash: string,
  ): Promise<DocEntry> {
    const pending = this.docs.get(docId);
    if (pending) return pending;
    const task = (async (): Promise<DocEntry> => {
      const boot = bootUniver();
      const snapshot = JSON.parse(JSON.stringify(imported.snapshot)) as IWorkbookData;
      const book = createBook(boot, snapshot);
      const capture = new MutationCapture(boot);
      const checkpointSnapshot = structuredClone(book.workbook.save());
      const ops = this.opsAfter(docId, checkpointRev);
      for (const op of ops) {
        for (const m of op.mutations) {
          const params = JSON.parse(JSON.stringify(m.params ?? {})) as object;
          try {
            if (!(await boot.executeCommand(m.id, params, { fromCollab: true })))
              throw new Error("回放失败");
          } catch {
            await boot.dispose();
            throw new FileOperationError(
              "INTERNAL",
              `文档日志回放失败（rev ${op.rev}），未写回文件`,
            );
          }
        }
      }
      const entry: DocEntry = {
        meta: { id: docId, workspaceId, path, kind, rev: headRev, createdAt },
        imported,
        live: { boot, capture, unitId: book.unitId, save: book.workbook.save },
        tail: Promise.resolve(),
        workspaceRoot,
        checkpointSnapshot,
        checkpointHash: hash,
        checkpointRev,
      };
      entry.meta.checkpointRev = checkpointRev;
      this.metas.set(docId, entry.meta);
      if (!this.watchTimer) {
        this.watchTimer = setInterval(() => {
          for (const task of this.docs.values())
            void task.then((e) => this.enqueue(e, () => this.checkExternal(e))).catch(() => {});
        }, 1000);
        this.watchTimer.unref();
      }
      return entry;
    })();
    this.docs.set(docId, task);
    task.catch(() => {
      this.docs.delete(docId);
    });
    return task;
  }

  /** 拿活文档；未在内存时按 documents 行从工作区重新导入并重放。 */
  async entry(docId: string, workspaceRoot: string): Promise<DocEntry> {
    const hit = await this.docs.get(docId);
    if (hit) {
      if (
        resolveWorkspacePath(workspaceRoot, ".").abs !==
        resolveWorkspacePath(hit.workspaceRoot, ".").abs
      )
        throw new PathSafetyError("OUT_OF_WORKSPACE", "文档不属于当前工作区");
      return hit;
    }
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as
      | DocRow
      | undefined;
    if (!row) throw new DocNotFoundError(docId);
    const opened = await this.open(row.workspace_id, workspaceRoot, row.path);
    return this.entry(opened.meta.id, workspaceRoot);
  }

  /** 每文档串行化：submit/snapshot 统一排队。 */
  private enqueue<T>(entry: DocEntry, fn: () => Promise<T> | T): Promise<T> {
    const run = entry.tail.then(fn);
    entry.tail = run.catch(() => {});
    return run;
  }

  /** 深拷贝快照（07 §3：调用方拿到的永远是副本）。 */
  snapshot(
    docId: string,
    workspaceRoot: string,
  ): Promise<{ meta: DocumentMeta; snapshot: IWorkbookData }> {
    return this.entry(docId, workspaceRoot).then((e) =>
      this.enqueue(e, async () => {
        await this.checkExternal(e);
        return { meta: { ...e.meta }, snapshot: structuredClone(e.live.save()) };
      }),
    );
  }

  /** 进程内已知的 docId（WS 订阅校验用；也看库）。 */
  hasDoc(docId: string): boolean {
    if (this.docs.has(docId) || this.metas.has(docId)) return true;
    return this.db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId) !== undefined;
  }

  headRev(docId: string): number {
    const row = this.db.prepare("SELECT head_rev FROM documents WHERE id = ?").get(docId) as
      | { head_rev: number }
      | undefined;
    if (!row) throw new DocNotFoundError(docId);
    return row.head_rev;
  }

  /** rev > after 的持久化操作（WS 续传）。 */
  opsAfter(docId: string, after: number): DocOpRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM doc_ops WHERE doc_id = ? AND rev > ? ORDER BY rev")
      .all(docId, after) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      rev: Number(r.rev),
      baseRev: Number(r.base_rev),
      sourceKind: String(r.source_kind),
      sourceId: (r.source_id as string | null) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      toolCallId: (r.tool_call_id as string | null) ?? null,
      writeSet: JSON.parse(String(r.write_set)) as DocWriteSet,
      mutations: JSON.parse(String(r.mutations)) as DocMutation[],
      createdAt: String(r.created_at),
    }));
  }

  recoverFiles(meta: FileIntentMeta | undefined): ToolResult {
    return this.backups.recover(meta);
  }

  /** 04 §8.2 恢复钩子：该 tool_call_id 是否已提交成修订。 */
  committedByToolCall(toolCallId: string): { docId: string; rev: number } | undefined {
    const row = this.db
      .prepare("SELECT doc_id, rev FROM doc_ops WHERE tool_call_id = ? ORDER BY rev LIMIT 1")
      .get(toolCallId) as { doc_id: string; rev: number } | undefined;
    return row ? { docId: row.doc_id, rev: row.rev } : undefined;
  }

  /** 该 tool_call_id 提交过的全部修订（run_script 发布失败回滚按逆序回放）。 */
  committedByToolCallAll(toolCallId: string): Array<{ docId: string; rev: number }> {
    const rows = this.db
      .prepare("SELECT doc_id, rev FROM doc_ops WHERE tool_call_id = ? ORDER BY rev")
      .all(toolCallId) as Array<{ doc_id: string; rev: number }>;
    return rows.map((r) => ({ docId: r.doc_id, rev: r.rev }));
  }

  /**
   * 回退一个已提交修订（03 §6.3 批次回退）：该 rev 的 inverse 作为新修订提交，
   * 与普通写入走同一条路径（doc_ops 记录 + 广播 + script 来源自动备份）。
   * mutations 型直接回放；needsSnapshot 型用落库的 preSnap 经
   * snapshotRestoreMutations 重建还原 mutation。baseRev 取当前 head —
   * 回退是有意的整体撤销，不与 baseRev 之后的并发修订做冲突检查。
   */
  async revert(
    docId: string,
    workspaceRoot: string,
    rev: number,
    source: SubmitSource,
    sessionId?: string,
    toolCallId?: string,
  ): Promise<SubmitResult> {
    const row = this.db
      .prepare("SELECT inverse FROM doc_ops WHERE doc_id = ? AND rev = ?")
      .get(docId, rev) as { inverse: string } | undefined;
    if (!row) return { ok: false, code: "DOC_NOT_FOUND", message: "修订不存在" };
    let inv: { mutations?: DocMutation[]; snapshot?: unknown };
    try {
      inv = JSON.parse(row.inverse) as typeof inv;
    } catch {
      return { ok: false, code: "INTERNAL", message: "inverse 记录损坏" };
    }
    const entry = await this.entry(docId, workspaceRoot);
    return this.enqueue(entry, () => {
      const mutations =
        inv.mutations ??
        (inv.snapshot !== undefined
          ? snapshotRestoreMutations(
              inv.snapshot as Snap,
              entry.live.save() as Snap,
              entry.live.unitId,
            )
          : undefined);
      if (mutations === undefined) {
        return { ok: false, code: "UNSUPPORTED_FEATURE", message: "该修订没有可回放的逆操作" };
      }
      return this.doSubmit(entry, {
        baseRev: entry.meta.rev,
        readSet: [],
        source,
        sessionId,
        toolCallId,
        mutations,
      });
    });
  }

  meta(docId: string): DocumentMeta | undefined {
    return this.metas.get(docId);
  }

  // ---------- 提交 ----------

  /**
   * 统一写入路径（07 §3.3）：冲突检查（变换坐标）→ 编译/修补 → 同步窗口执行 →
   * 前像逆操作 → dryRun 回滚 或 事务写 doc_ops + head_rev → 广播。
   */
  submit(docId: string, workspaceRoot: string, batch: SubmitBatch): Promise<SubmitResult> {
    return this.entry(docId, workspaceRoot)
      .then((e) => this.enqueue(e, () => this.doSubmit(e, batch)))
      .catch((e): SubmitFail => {
        if (e instanceof DocNotFoundError) {
          return { ok: false, code: "DOC_NOT_FOUND", message: e.message };
        }
        return {
          ok: false,
          code: e instanceof FileOperationError ? (e.code as SubmitFail["code"]) : "BAD_OPERATION",
          message: e instanceof FileOperationError ? e.message : "文档操作失败",
        };
      });
  }

  private async doSubmit(entry: DocEntry, batch: SubmitBatch): Promise<SubmitResult> {
    await this.checkExternal(entry);
    if (entry.paused)
      return {
        ok: false,
        code: "VERSION_CONFLICT",
        message: "文件被外部修改且有未写回修订，已暂停写入",
      };
    const { live, meta } = entry;
    const head = meta.rev;
    if (!Number.isInteger(batch.baseRev) || batch.baseRev < 0 || batch.baseRev > head)
      return { ok: false, code: "VERSION_CONFLICT", message: "baseRev 不在当前修订范围" };

    // ---- 0. baseRev 之后的结构操作先把本次写入坐标平移到当前快照 ----
    const history = this.opsAfter(meta.id, batch.baseRev).filter((r) => r.rev <= head);
    const structurals = history.flatMap((h) => h.writeSet.structural);
    let opsIn = batch.ops;
    let mutIn = batch.mutations;
    if (structurals.length > 0) {
      const snap = live.save();
      const sheets = (snap.sheets ?? {}) as Record<string, IWorksheetData>;
      const sheetIdOf = (nameOrId: string | undefined): string | undefined => {
        if (nameOrId === undefined) return snap.sheetOrder?.[0];
        if (sheets[nameOrId]) return nameOrId;
        for (const [id, s] of Object.entries(sheets)) {
          if (s.name === nameOrId) return id;
        }
        return undefined;
      };
      if (batch.ops !== undefined) {
        const mapped: ChangeOp[] = [];
        for (const op of batch.ops) {
          const t = transformChangeOp(op, structurals, sheetIdOf);
          if (t === "deleted") {
            return {
              ok: false,
              code: "VERSION_CONFLICT",
              message: "目标行/列/工作表已被 baseRev 之后的结构修订删除",
              conflicts: [
                {
                  rev: history[history.length - 1]?.rev ?? head,
                  source: "",
                  cells: [],
                },
              ],
            };
          }
          mapped.push(t);
        }
        opsIn = mapped;
      } else {
        const mappedMuts: DocMutation[] = [];
        for (const m of normalizeMutations(batch.mutations ?? [])) {
          const t = transformMutation(m, structurals);
          if (t === "deleted" || t === "ambiguous") {
            return {
              ok: false,
              code: "VERSION_CONFLICT",
              message:
                t === "deleted"
                  ? "目标区域已被 baseRev 之后的结构修订删除"
                  : "目标坐标无法确定性平移，请重读后再写",
              conflicts: [
                {
                  rev: history[history.length - 1]?.rev ?? head,
                  source: "",
                  cells: [],
                },
              ],
            };
          }
          mappedMuts.push(t);
        }
        mutIn = mappedMuts;
      }
    }

    // ---- 1. 编译/归一化，得写集与结构操作（坐标已平移） ----
    let compiled: CompiledOps | undefined;
    let mutations: DocMutation[];
    try {
      if (opsIn !== undefined) {
        const snap = live.save();
        compiled = compileOps({ unitId: live.unitId, snapshot: snap }, opsIn);
        mutations = [];
      } else {
        const raw = normalizeMutations(mutIn ?? []);
        mutations = raw.map((m) =>
          fixupMutationForTransport(
            m,
            batch.senderSnapshot as { styles?: Record<string, unknown> } | undefined,
          ),
        );
      }
    } catch (e) {
      return {
        ok: false,
        code: "BAD_OPERATION",
        message: e instanceof Error ? e.message : String(e),
      };
    }

    const writeSet: DocWriteSet =
      compiled !== undefined
        ? { ranges: [...compiled.ranges], structural: [...compiled.structural] }
        : deriveWriteSetAll(mutations);
    /** 读集默认：用户 mutation 提交 = 其写集本身；ops 提交未显式给读集则只按写集判冲突。 */
    const readSet = batch.readSet ?? (batch.mutations !== undefined ? writeSet.ranges : []);

    // ---- 2. 冲突检查（读集变换；写集已在编译前平移；同源修订不算冲突） ----
    const conflict = this.checkConflicts(entry, history, batch, readSet, writeSet);
    if (conflict) return conflict;

    // ---- 3. 20 万格上限（无界区域不计入） ----
    const boundedCells = writeSet.ranges
      .filter((r) => r.r1 < MAX_R && r.c1 < MAX_C)
      .reduce((s, r) => s + (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1), 0);
    if (boundedCells > MAX_SUBMIT_CELLS) {
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        message: `单次提交最多 ${MAX_SUBMIT_CELLS} 格，本次约 ${boundedCells} 格`,
      };
    }

    assertWritable(entry.imported, writeSet.ranges, opsIn, mutations, live.save());
    let backupPath: string | undefined;
    if (!batch.dryRun && (batch.source.kind === "agent" || batch.source.kind === "script")) {
      const bound = this.backups.bind({
        workspaceId: meta.workspaceId,
        workspaceRoot: entry.workspaceRoot,
        sessionId: batch.sessionId ?? batch.source.id,
        agentId: batch.source.id,
      });
      if (bound.needsBackup(meta.path) && meta.rev > entry.checkpointRev)
        await this.doCheckpoint(entry);
      backupPath = bound.ensureBackup(meta.path)?.backupPath;
    }

    // ---- 4. dryRun 且含需快照回滚的操作：不应用，只回写集 ----
    const declaredNeedsSnapshot =
      compiled?.needsSnapshot === true ||
      mutations.some(
        (m) => m.id === "sheet.mutation.remove-sheet" || m.id === "sheet.mutation.move-range",
      );
    if (batch.dryRun && declaredNeedsSnapshot) {
      return {
        ok: true,
        docId: meta.id,
        rev: head,
        dryRun: true,
        writeSet,
        mutations: [],
        formulas: [],
        preview: [],
      };
    }

    // ---- 5. 应用（同步命令窗口内捕获 mutation） ----
    const preSnap = structuredClone(live.save());
    const emitted: DocMutation[] = [];
    let execError: string | undefined;
    const execInWindow = async (id: string, params: unknown, fromCollab: boolean) => {
      live.capture.begin();
      const ok = await live.boot.executeCommand(
        id,
        params,
        fromCollab ? { fromCollab: true } : undefined,
      );
      emitted.push(...live.capture.end());
      return ok;
    };
    try {
      if (compiled !== undefined) {
        for (const cmd of compiled.commands) {
          if (!(await execInWindow(cmd.id, cmd.params, false))) {
            execError = `命令未生效：${cmd.id}`;
          }
        }
      } else {
        for (const m of mutations) {
          if (!(await execInWindow(m.id, m.params, true))) {
            execError = `mutation 未生效：${m.id}`;
          }
        }
        // R-filter-reconcile：有发送方快照时对账筛选资源
        if (batch.senderSnapshot !== undefined) {
          const extra = reconcileFilterResource(
            batch.senderSnapshot as never,
            preSnap as never,
            live.unitId,
          );
          for (const m of extra) {
            if (!(await execInWindow(m.id, m.params, true))) {
              execError = `mutation 未生效：${m.id}`;
            }
          }
        }
      }
    } catch {
      // 命令抛错：交出给下面统一回滚
      execError ??= "命令执行失败";
    }
    if (execError !== undefined) {
      await this.restore(entry, preSnap);
      return { ok: false, code: "BAD_OPERATION", message: execError };
    }

    const postSnap = live.save();
    try {
      if (entry.imported.csv) {
        for (const [id, sheet] of Object.entries(postSnap.sheets)) {
          const before = preSnap.sheets[id];
          if (
            !before ||
            ["mergeData", "freeze", "columnData"].some(
              (k) =>
                JSON.stringify(sheet[k as keyof IWorksheetData]) !==
                JSON.stringify(before[k as keyof IWorksheetData]),
            )
          )
            throw new FileOperationError("UNSUPPORTED_FEATURE", "CSV 不支持格式编辑");
          for (const [r, row] of Object.entries(sheet.cellData ?? {}))
            for (const [c, cell] of Object.entries(row ?? {})) {
              const v = cell as { s?: unknown; f?: unknown };
              if (
                v.f ||
                JSON.stringify(v.s) !== JSON.stringify(before.cellData?.[Number(r)]?.[Number(c)]?.s)
              )
                throw new FileOperationError(
                  "UNSUPPORTED_FEATURE",
                  "CSV 不支持公式或样式，请另存为 xlsx",
                );
            }
        }
        exportCsv(postSnap, entry.imported.csv);
      } else exportXlsx(entry.imported, postSnap, entry.checkpointSnapshot);
    } catch (e) {
      await this.restore(entry, preSnap);
      return {
        ok: false,
        code:
          e instanceof FileOperationError ? (e.code as SubmitFail["code"]) : "UNSUPPORTED_FEATURE",
        message: e instanceof FileOperationError ? e.message : "无法保证保真写回",
      };
    }
    // 实际发射的结构操作补入写集（含引擎生成的真实 sheet id）
    const emittedDerived = deriveWriteSetAll(emitted);
    const structural = mergeStructural(
      batch.ops !== undefined ? writeSet.structural : [],
      emittedDerived.structural,
    );
    const finalWriteSet: DocWriteSet = {
      ranges: batch.ops !== undefined ? writeSet.ranges : emittedDerived.ranges,
      structural,
    };
    const needsSnapshot =
      declaredNeedsSnapshot ||
      emitted.some(
        (m) => m.id === "sheet.mutation.remove-sheet" || m.id === "sheet.mutation.move-range",
      );
    const inverseMutations = needsSnapshot
      ? undefined
      : makeInverse(preSnap, postSnap, emitted, live.unitId).inverse;
    // 快照型（remove-sheet/move-range 等结构操作）把 preSnap 存进 inverse 列，
    // 供 revert 用 snapshotRestoreMutations 重建还原 mutation
    const inverse = needsSnapshot
      ? { needsSnapshot: true as const, snapshot: preSnap }
      : { mutations: inverseMutations };
    const formulas = compiled !== undefined ? compiled.formulas : collectFormulas(entry, emitted);

    // ---- 6. dryRun：读预览 → 逆操作回滚；不写日志不广播 ----
    if (batch.dryRun) {
      const preview = readPreview(finalWriteSet, postSnap);
      await this.restore(entry, preSnap);
      return {
        ok: true,
        docId: meta.id,
        rev: head,
        dryRun: true,
        writeSet: finalWriteSet,
        mutations: emitted,
        formulas,
        preview,
      };
    }

    // ---- 7. 事务写 doc_ops + head_rev；提交后才广播 ----
    const rev = head + 1;
    const now = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO doc_ops (doc_id, rev, base_rev, source_kind, source_id, session_id, tool_call_id, write_set, mutations, inverse, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meta.id,
          rev,
          batch.baseRev,
          batch.source.kind,
          batch.source.id,
          batch.sessionId ?? null,
          batch.toolCallId ?? null,
          JSON.stringify(finalWriteSet),
          JSON.stringify(emitted),
          JSON.stringify(inverse),
          now,
        );
      this.db
        .prepare("UPDATE documents SET head_rev = ?, rev = ? WHERE id = ?")
        .run(rev, rev, meta.id);
      this.db.exec("COMMIT");
    } catch (_e) {
      this.db.exec("ROLLBACK");
      await this.restore(entry, preSnap);
      return {
        ok: false,
        code: "BAD_OPERATION",
        message: "文档日志提交失败，修改已回滚",
      };
    }
    meta.rev = rev;
    this.onRevision?.(meta.id, rev, `${batch.source.kind}:${batch.source.id}`, emitted);
    this.schedule(entry, batch.source.kind === "user" ? 2000 : 1000);
    return {
      ok: true,
      docId: meta.id,
      rev,
      dryRun: false,
      writeSet: finalWriteSet,
      mutations: emitted,
      formulas,
      ...(backupPath ? { backupPath } : {}),
    };
  }

  /**
   * 对 baseRev < rev ≤ head 的每个历史修订：先用其 structural 依次变换本次
   * 读集与写集（变换出 "deleted" → 拒绝），再检查其写集 ∩ 变换后的（读集 ∪ 写集）。
   * 同源（同一 agent/用户自己提交）的修订跳过相交检查——自己写的自己知道，
   * 但其结构变换仍要应用到本次坐标。
   */
  private checkConflicts(
    entry: DocEntry,
    history: DocOpRecord[],
    batch: SubmitBatch,
    readSet: RangeRef[],
    writeSet: DocWriteSet,
  ): SubmitFail | undefined {
    let readT = [...readSet];
    // 本次写集已是平移后坐标（ops 在编译前变换、mutations 在执行前变换），
    // 只有读集仍是旧快照坐标，需要逐结构操作平移。
    const writeT = [...writeSet.ranges];
    for (const h of history) {
      let deleted = false;
      for (const s of h.writeSet.structural) {
        readT = readT.map((r) => {
          const t = transformRange(r, s);
          if (t === "deleted") deleted = true;
          return t === "deleted" ? r : t;
        });
      }
      const sameSource =
        h.sourceKind === batch.source.kind && (h.sourceId ?? "") === batch.source.id;
      if (sameSource) continue;
      if (deleted) {
        return {
          ok: false,
          code: "VERSION_CONFLICT",
          message: `修订 ${h.rev} 删除了本次读过的区域`,
          conflicts: [
            {
              rev: h.rev,
              source: `${h.sourceKind}:${h.sourceId ?? ""}`,
              cells: this.renderCells(entry, [...readSet, ...writeSet.ranges]),
            },
          ],
        };
      }
      const incoming = [...readT, ...writeT];
      const hits: RangeRef[] = [];
      for (const w of h.writeSet.ranges) {
        for (const r of incoming) {
          const ix = rangeIntersection(w, r);
          if (ix) hits.push(ix);
        }
      }
      if (hits.length > 0) {
        return {
          ok: false,
          code: "VERSION_CONFLICT",
          message: `修订 ${h.rev} 修改了与本次读写重叠的区域`,
          conflicts: [
            {
              rev: h.rev,
              source: `${h.sourceKind}:${h.sourceId ?? ""}`,
              cells: this.renderCells(entry, hits).slice(0, MAX_CONFLICT_CELLS),
            },
          ],
        };
      }
    }
    return undefined;
  }

  private remapPreservation(imported: ImportedWorkbook, snapshot: IWorkbookData): void {
    if (!imported.preservation) return;
    const refs = imported.preservation.sheetParts;
    imported.preservation.sheetParts = Object.fromEntries(
      snapshot.sheetOrder
        .map((id, i) => [id, refs[imported.snapshot.sheetOrder[i] ?? ""]])
        .filter((x) => x[1] !== undefined),
    ) as typeof refs;
  }

  private async restore(entry: DocEntry, snapshot: IWorkbookData): Promise<void> {
    await entry.live.boot.dispose();
    const boot = bootUniver();
    const book = createBook(boot, structuredClone(snapshot));
    entry.live = {
      boot,
      capture: new MutationCapture(boot),
      unitId: book.unitId,
      save: book.workbook.save,
    };
  }

  private schedule(entry: DocEntry, delay: number): void {
    if (this.closing || entry.paused) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.enqueue(entry, () => this.doCheckpoint(entry)).catch(() => {
        this.schedule(entry, 5000);
      });
    }, delay);
    entry.timer.unref();
  }

  async checkpoint(docId: string, root: string): Promise<void> {
    const entry = await this.entry(docId, root);
    await this.enqueue(entry, () => this.doCheckpoint(entry));
  }

  private async doCheckpoint(entry: DocEntry): Promise<void> {
    clearTimeout(entry.timer);
    try {
      await this.checkExternal(entry);
      if (entry.paused)
        throw new FileOperationError("VERSION_CONFLICT", "外部修改与未写回修订冲突，已暂停写回");
      if (entry.meta.rev === entry.checkpointRev) return;
      const snapshot = structuredClone(entry.live.save());
      const bytes = entry.imported.csv
        ? exportCsv(snapshot, entry.imported.csv)
        : exportXlsx(entry.imported, snapshot, entry.checkpointSnapshot);
      const hash = sha256(bytes);
      const saved = JSON.stringify(snapshot);
      // Durable publication intent closes the rename/SQLite crash window.
      this.db
        .prepare(
          "INSERT INTO doc_checkpoints VALUES (?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET rev=excluded.rev,hash=excluded.hash,snapshot=excluded.snapshot",
        )
        .run(entry.meta.id, entry.meta.rev, hash, saved);
      const nextImported = entry.imported.csv
        ? importCsv(bytes, entry.meta.path)
        : importXlsx(bytes, entry.meta.path);
      this.remapPreservation(nextImported, snapshot);
      atomicWrite(entry.workspaceRoot, entry.meta.path, bytes, entry.checkpointHash, (back) => {
        if (!entry.imported.csv) verifyXlsx(back, snapshot);
        else if (sha256(back) !== hash)
          throw new FileOperationError("INTERNAL", "CSV 回读校验失败");
      });
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "UPDATE documents SET checkpoint_rev=?, checkpoint_hash=?, checkpoint_snapshot=? WHERE id=?",
          )
          .run(entry.meta.rev, hash, saved, entry.meta.id);
        this.db.prepare("DELETE FROM doc_checkpoints WHERE doc_id=?").run(entry.meta.id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      nextImported.snapshot = snapshot;
      entry.imported = nextImported;
      entry.checkpointSnapshot = snapshot;
      entry.checkpointHash = hash;
      entry.checkpointRev = entry.meta.rev;
      entry.meta.checkpointRev = entry.checkpointRev;
      delete entry.meta.checkpointError;
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev);
    } catch (e) {
      entry.meta.checkpointError =
        e instanceof FileOperationError ? e.message : "写回失败，文档日志已保留，将重试";
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      throw e;
    }
  }

  private async checkExternal(entry: DocEntry): Promise<void> {
    const { abs } = resolveWorkspacePath(entry.workspaceRoot, entry.meta.path);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(abs);
    } catch {
      entry.paused = true;
      entry.meta.checkpointError = "源文件无法读取，已暂停写回";
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      return;
    }
    const hash = sha256(bytes);
    if (hash === entry.checkpointHash) return;
    const pending = this.db
      .prepare("SELECT * FROM doc_checkpoints WHERE doc_id=?")
      .get(entry.meta.id) as { rev: number; hash: string; snapshot: string } | undefined;
    if (pending?.hash === hash && pending.rev === entry.meta.rev) {
      // The publication succeeded but the checkpoint metadata transaction was interrupted.
      this.db
        .prepare(
          "UPDATE documents SET checkpoint_rev=?,checkpoint_hash=?,checkpoint_snapshot=? WHERE id=?",
        )
        .run(pending.rev, hash, pending.snapshot, entry.meta.id);
      this.db.prepare("DELETE FROM doc_checkpoints WHERE doc_id=?").run(entry.meta.id);
      const imported =
        entry.meta.kind === "csv"
          ? importCsv(bytes, entry.meta.path)
          : importXlsx(bytes, entry.meta.path);
      const snapshot = JSON.parse(pending.snapshot) as IWorkbookData;
      this.remapPreservation(imported, snapshot);
      imported.snapshot = snapshot;
      entry.imported = imported;
      entry.checkpointSnapshot = snapshot;
      entry.checkpointHash = hash;
      entry.checkpointRev = pending.rev;
      entry.meta.checkpointRev = pending.rev;
      return;
    }
    if (entry.meta.rev > entry.checkpointRev) {
      entry.paused = true;
      entry.meta.checkpointError = "外部文件与未写回修订冲突，已暂停写回";
      clearTimeout(entry.timer);
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      return;
    }
    await this.reloadExternal(entry, bytes);
  }

  private async reloadExternal(entry: DocEntry, bytes: Uint8Array): Promise<void> {
    const imported =
      entry.meta.kind === "csv"
        ? importCsv(bytes, entry.meta.path)
        : importXlsx(bytes, entry.meta.path);
    const snapshot = imported.snapshot;
    const rev = entry.meta.rev + 1;
    const hash = sha256(bytes);
    const ranges = [{ sheetId: "*", r0: 0, c0: 0, r1: MAX_R, c1: MAX_C }];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO doc_ops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          entry.meta.id,
          rev,
          entry.meta.rev,
          "external",
          "file",
          null,
          null,
          JSON.stringify({ ranges, structural: [] }),
          "[]",
          JSON.stringify({ needsSnapshot: true }),
          nowIso(),
        );
      this.db
        .prepare(
          "UPDATE documents SET rev=?, head_rev=?, checkpoint_rev=?, checkpoint_hash=?, checkpoint_snapshot=? WHERE id=?",
        )
        .run(rev, rev, rev, hash, JSON.stringify(snapshot), entry.meta.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    await this.restore(entry, snapshot);
    entry.imported = imported;
    entry.checkpointSnapshot = structuredClone(entry.live.save());
    entry.checkpointHash = hash;
    entry.checkpointRev = rev;
    entry.meta.rev = rev;
    entry.meta.checkpointRev = rev;
    delete entry.meta.checkpointError;
    this.onRevision?.(entry.meta.id, rev, "external:file", []);
  }

  async create(
    workspaceId: string,
    root: string,
    path: string,
    sessionId: string,
    agentId: string,
    sheetName = "Sheet1",
  ): Promise<OpenedDoc> {
    const { abs } = resolveWorkspacePath(root, path);
    if (existsSync(abs)) throw new FileOperationError("VERSION_CONFLICT", "新工作簿路径已存在");
    if (extname(path).toLowerCase() !== ".xlsx")
      throw new FileOperationError("INVALID_ARGUMENT", "新建工作簿必须使用 .xlsx");
    const snapshot: IWorkbookData = {
      id: newId("wbk"),
      name: path,
      appVersion: ENGINE_VERSION,
      locale: "zh-CN" as never,
      styles: {},
      sheetOrder: ["s0"],
      sheets: { s0: { id: "s0", name: sheetName, rowCount: 1000, columnCount: 26, cellData: {} } },
    };
    atomicWrite(root, path, minimalXlsx(snapshot), null);
    this.backups.bind({ workspaceId, workspaceRoot: root, sessionId, agentId }).markCreated(path);
    return this.open(workspaceId, root, path);
  }

  async previewCreate(ops: ChangeOp[]): Promise<ToolResult> {
    const boot = bootUniver();
    try {
      const snapshot: IWorkbookData = {
        id: "preview",
        name: "preview.xlsx",
        appVersion: ENGINE_VERSION,
        locale: "zh-CN" as never,
        styles: {},
        sheetOrder: ["s0"],
        sheets: { s0: { id: "s0", name: "Sheet1", rowCount: 1000, columnCount: 26, cellData: {} } },
      };
      const book = createBook(boot, snapshot);
      const compiled = compileOps({ unitId: book.unitId, snapshot: book.workbook.save() }, ops);
      for (const cmd of compiled.commands)
        if (!(await boot.executeCommand(cmd.id, cmd.params)))
          throw new OpCompileError("预览操作未生效");
      const after = book.workbook.save();
      minimalXlsx(after);
      return {
        status: "ok",
        data: {
          dryRun: true,
          rev: 0,
          preview: readPreview({ ranges: compiled.ranges, structural: compiled.structural }, after),
        },
      };
    } catch (e) {
      return {
        status: "error",
        error: {
          code: e instanceof FileOperationError ? e.code : "INVALID_ARGUMENT",
          message:
            e instanceof FileOperationError || e instanceof OpCompileError
              ? e.message
              : "新建预览失败",
          retryable: false,
        },
      };
    } finally {
      await boot.dispose();
    }
  }

  async discardCreated(docId: string, root: string, sessionId: string): Promise<void> {
    const entry = await this.entry(docId, root);
    clearTimeout(entry.timer);
    await entry.live.boot.dispose();
    rmSync(resolveWorkspacePath(root, entry.meta.path).abs, { force: true });
    this.db.prepare("DELETE FROM doc_ops WHERE doc_id=?").run(docId);
    this.db.prepare("DELETE FROM doc_checkpoints WHERE doc_id=?").run(docId);
    this.db.prepare("DELETE FROM documents WHERE id=?").run(docId);
    this.db
      .prepare(
        "DELETE FROM backups WHERE workspace_id=? AND session_id=? AND original_path=? AND kind='created'",
      )
      .run(entry.meta.workspaceId, sessionId, entry.meta.path);
    this.docs.delete(docId);
    this.metas.delete(docId);
  }

  async flushAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const task of this.docs.values()) {
      try {
        const entry = await task;
        await this.enqueue(entry, () => this.doCheckpoint(entry));
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length)
      throw new FileOperationError("INTERNAL", "部分文档写回失败；日志已保留，可在下次启动恢复");
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.watchTimer);
    try {
      await this.flushAll();
    } finally {
      for (const task of this.docs.values()) {
        const entry = await task.catch(() => undefined);
        if (entry) {
          clearTimeout(entry.timer);
          await entry.live.boot.dispose();
        }
      }
      this.docs.clear();
    }
  }

  private renderCells(entry: DocEntry, ranges: RangeRef[]): string[] {
    const snap = entry.live.save();
    const names = new Map<string, string>();
    for (const [id, s] of Object.entries(snap.sheets ?? {})) {
      names.set(id, (s as IWorksheetData).name ?? id);
    }
    const out: string[] = [];
    for (const r of ranges) {
      if (out.length >= MAX_CONFLICT_CELLS) break;
      if (r.r1 - r.r0 > MAX_CONFLICT_CELLS || r.c1 - r.c0 > 10) {
        out.push(
          rangeRefToA1(
            { ...r, r1: Math.min(r.r1, r.r0 + MAX_CONFLICT_CELLS) },
            names.get(r.sheetId),
          ),
        );
        continue;
      }
      out.push(rangeRefToA1(r, names.get(r.sheetId)));
    }
    return out;
  }
}

function mergeStructural(a: StructuralOp[], b: StructuralOp[]): StructuralOp[] {
  const out = [...a];
  const key = (s: StructuralOp) => `${s.sheetId}|${s.kind}|${s.index}|${s.count}`;
  const seen = new Set(out.map(key));
  for (const s of b) {
    // op 声明的 insertSheet 用真实 id 替换通配占位
    if (s.kind === "insertSheet") {
      const i = out.findIndex((x) => x.kind === "insertSheet" && x.sheetId === "*");
      if (i >= 0) {
        out[i] = s;
        seen.add(key(s));
        continue;
      }
    }
    if (!seen.has(key(s))) {
      seen.add(key(s));
      out.push(s);
    }
  }
  return out;
}

/** 从发射的 set-range-values 收集公式单元格 A1（用户 mutation 路径）。 */
function collectFormulas(entry: DocEntry, emitted: DocMutation[]): string[] {
  const snap = entry.live.save();
  const names = new Map<string, string>();
  for (const [id, s] of Object.entries(snap.sheets ?? {})) {
    names.set(id, (s as IWorksheetData).name ?? id);
  }
  const out: string[] = [];
  for (const m of emitted) {
    if (m.id !== "sheet.mutation.set-range-values") continue;
    const q = m.params as {
      subUnitId?: string;
      cellValue?: Record<string, Record<string, { f?: string }>>;
    };
    const sid = String(q.subUnitId ?? "");
    const name = names.get(sid) ?? sid;
    for (const [rs, row] of Object.entries(q.cellValue ?? {})) {
      for (const [cs, cell] of Object.entries(row ?? {})) {
        if (typeof cell?.f === "string" && cell.f !== "") {
          out.push(`${name}!${indexToCol(Number(cs) + 1)}${Number(rs) + 1}`);
        }
      }
    }
  }
  return out;
}

/** dryRun 预览：读受影响区域的值（有界区域，≤2000 格）。 */
function readPreview(writeSet: DocWriteSet, postSnap: IWorkbookData): PreviewRegion[] {
  const out: PreviewRegion[] = [];
  let cells = 0;
  for (const r of writeSet.ranges) {
    if (r.sheetId === "*" || r.r1 >= MAX_R || r.c1 >= MAX_C) continue;
    const area = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
    if (cells + area > MAX_PREVIEW_CELLS) break;
    const sheet = postSnap.sheets?.[r.sheetId] as IWorksheetData | undefined;
    if (!sheet) continue;
    const values: unknown[][] = [];
    for (let rr = r.r0; rr <= r.r1; rr++) {
      const row: unknown[] = [];
      const cd = sheet.cellData?.[rr] as Record<number, { v?: unknown }> | undefined;
      for (let cc = r.c0; cc <= r.c1; cc++) row.push(cd?.[cc]?.v ?? null);
      values.push(row);
    }
    cells += area;
    out.push({
      range: rangeRefToA1(r, sheet.name ?? r.sheetId),
      values,
    });
  }
  return out;
}

export interface OpenedDoc {
  meta: DocumentMeta;
  imported: ImportedWorkbook;
}
