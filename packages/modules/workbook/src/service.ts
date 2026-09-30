// DocumentService（07 §3）：活文档 actor——每个打开的文档持有一个 Univer 无头
// 实例（主线程，ADR 0003），提交串行处理，修订号严格递增，doc_ops 追加写日志。
// 快照定影：createWorkbook 前深拷贝；对外 snapshot() 一律返回 getSnapshot 深拷贝。
// 冲突检测：baseRev 之后的写集 ∩（变换后的读集 ∪ 写集），结构操作按 03 §6.1 变换。

import { readFileSync, statSync } from "node:fs";
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
import { PathSafetyError, resolveWorkspacePath } from "@excelmanus/kernel";
import type { DocKind } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { importCsv } from "./csv.ts";
import {
  type Booted,
  bootUniver,
  createBook,
  type DocMutation,
  ENGINE_VERSION,
  MutationCapture,
} from "./engine.ts";
import { makeInverse, reconcile } from "./inverse.ts";
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

/** M2a：修订跟踪 + 追加型文档操作日志（不改已有迁移）。 */
export const DOC_OPS_MIGRATION = `
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
`;

export interface DocWriteSet {
  ranges: RangeRef[];
  structural: StructuralOp[];
}

export type SubmitSourceKind = "user" | "agent" | "script" | "engine";

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
}

export interface SubmitFail {
  ok: false;
  code: "VERSION_CONFLICT" | "LIMIT_EXCEEDED" | "DOC_NOT_FOUND" | "BAD_OPERATION";
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

  constructor(db: DatabaseSync) {
    this.db = db;
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
    const entry = await this.materialize(
      docId,
      workspaceId,
      rel,
      kind,
      imported,
      checkpointRev,
      headRev,
      now,
    );
    return { meta: entry.meta, imported };
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
  ): Promise<DocEntry> {
    const pending = this.docs.get(docId);
    if (pending) return pending;
    const task = (async (): Promise<DocEntry> => {
      const boot = bootUniver();
      const snapshot = JSON.parse(JSON.stringify(imported.snapshot)) as IWorkbookData;
      const book = createBook(boot, snapshot);
      const capture = new MutationCapture(boot);
      const ops = this.opsAfter(docId, checkpointRev);
      for (const op of ops) {
        for (const m of op.mutations) {
          const params = JSON.parse(JSON.stringify(m.params ?? {})) as object;
          try {
            await boot.executeCommand(m.id, params, { fromCollab: true });
          } catch {
            // 重放单条失败：跳过该条（日志已持久化，尽力恢复到最近一致状态）
          }
        }
      }
      const entry: DocEntry = {
        meta: { id: docId, workspaceId, path, kind, rev: headRev, createdAt },
        imported,
        live: { boot, capture, unitId: book.unitId, save: book.workbook.save },
        tail: Promise.resolve(),
      };
      this.metas.set(docId, entry.meta);
      return entry;
    })();
    this.docs.set(docId, task);
    return task;
  }

  /** 拿活文档；未在内存时按 documents 行从工作区重新导入并重放。 */
  async entry(docId: string, workspaceRoot: string): Promise<DocEntry> {
    const hit = await this.docs.get(docId);
    if (hit) return hit;
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
      this.enqueue(e, () => ({
        meta: { ...e.meta },
        snapshot: structuredClone(e.live.save()),
      })),
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

  /** 04 §8.2 恢复钩子：该 tool_call_id 是否已提交成修订。 */
  committedByToolCall(toolCallId: string): { docId: string; rev: number } | undefined {
    const row = this.db
      .prepare("SELECT doc_id, rev FROM doc_ops WHERE tool_call_id = ? ORDER BY rev LIMIT 1")
      .get(toolCallId) as { doc_id: string; rev: number } | undefined;
    return row ? { docId: row.doc_id, rev: row.rev } : undefined;
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
          code: "BAD_OPERATION",
          message: e instanceof Error ? e.message : String(e),
        };
      });
  }

  private async doSubmit(entry: DocEntry, batch: SubmitBatch): Promise<SubmitResult> {
    const { live, meta } = entry;
    const head = meta.rev;

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
    const preSnap = live.save();
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
      // 尽力回滚已应用部分
      try {
        const post = live.save();
        const inv = makeInverse(preSnap, post, emitted, live.unitId).inverse;
        for (const m of inv) await live.boot.executeCommand(m.id, m.params, { fromCollab: true });
      } catch {
        // 回滚失败：文档留在已应用部分状态，错误照常上报
      }
      return { ok: false, code: "BAD_OPERATION", message: execError };
    }

    const postSnap = live.save();
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
    const inverse = needsSnapshot
      ? { needsSnapshot: true as const }
      : { mutations: inverseMutations };
    const formulas = compiled !== undefined ? compiled.formulas : collectFormulas(entry, emitted);

    // ---- 6. dryRun：读预览 → 逆操作回滚；不写日志不广播 ----
    if (batch.dryRun) {
      const preview = readPreview(finalWriteSet, postSnap);
      try {
        if (inverseMutations !== undefined) {
          for (const m of inverseMutations) {
            await live.boot.executeCommand(m.id, m.params, { fromCollab: true });
          }
          for (const m of reconcile(preSnap, live.save(), live.unitId)) {
            await live.boot.executeCommand(m.id, m.params, { fromCollab: true });
          }
        }
      } catch {
        // 回滚尽力而为；dryRun 不污染修订号
      }
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
    } catch (e) {
      this.db.exec("ROLLBACK");
      return {
        ok: false,
        code: "BAD_OPERATION",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    meta.rev = rev;
    this.onRevision?.(meta.id, rev, `${batch.source.kind}:${batch.source.id}`, emitted);
    return {
      ok: true,
      docId: meta.id,
      rev,
      dryRun: false,
      writeSet: finalWriteSet,
      mutations: emitted,
      formulas,
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
