import {
  describeObjectChanges,
  imagePreviewBytes,
  objectsOf,
  sniffWorkbookImage,
} from "./objects.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource } from "./rule-codec.ts";
// DocumentService（07 §3）：活文档 actor——每个打开的文档持有一个 Univer 无头
// 实例（主线程，ADR 0003），提交串行处理，修订号严格递增，doc_ops 追加写日志。
// 快照定影：createWorkbook 前深拷贝；对外 snapshot() 一律返回 getSnapshot 深拷贝。
// 冲突检测：读集区域各带读取修订，与之后修订的写集在 head 坐标系下求交（03 §6.1）。

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  indexToCol,
  isDerivedWorkbookMutation,
  MAX_C,
  MAX_R,
  newId,
  nowIso,
  parseRange,
  type RangeRef,
  rangeContains,
  rangeIntersection,
  rangeRefToA1,
  type StructuralOp,
  structuralTouchesInterior,
  subtractRanges,
  transformRange,
  transformRangeAll,
} from "@excelmanus/core";
import {
  assertToolAccess,
  assertToolWriteAccess,
  atomicWrite,
  BackupService,
  canonicalWorkspaceRoot,
  currentToolAccess,
  FileOperationError,
  type Migration,
  PathSafetyError,
  pathVersion,
  recordDocumentAccess,
  resolveWorkspacePath,
  runWithoutToolAccess,
  runWithToolAccess,
  sha256,
  type ToolAccessContext,
  TurnAccessError,
  withFileAccessSync,
} from "@excelmanus/kernel";
import type {
  BackupInfo,
  DocKind,
  FileIntentMeta,
  MergeDocsBody,
  ToolResult,
} from "@excelmanus/protocol";
import {
  OBJECT_LAYER_MUTATION,
  printNamesOf,
  printSettingsOf,
  SheetObjectsMutation,
} from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import {
  assertCellsWritable,
  assertUnprotected,
  assertWritable,
  exportXlsx,
  minimalXlsx,
  pendingChanges,
  workbookProtection,
} from "./checkpoint.ts";
import { exportCsv, importCsv } from "./csv.ts";
import {
  type Booted,
  bootUniver,
  createBook,
  type DocMutation,
  ENGINE_VERSION,
  MutationCapture,
} from "./engine.ts";
import {
  assertExternalLinkWrites,
  assertExternalRecalculation,
  assertNoExternalFormulaInputs,
  externalCells,
  filterExternalEngineResults,
  restoreSavedExternalCaches,
} from "./external-link-writes.ts";
import { makeInverse, type Snap, snapshotRestoreMutations } from "./inverse.ts";
import {
  assertMacroPreserved,
  assertMacroWriteSupported,
  inspectMacroPackage,
} from "./macro-evidence.ts";
import { mergeMutations } from "./merge.ts";
import {
  type ChangeOp,
  type CompiledOps,
  changeOpTarget,
  compileOps,
  OpCompileError,
  transformChangeOp,
  transformMutation,
} from "./ops.ts";
import { importPivotRefresh, planPivotRefreshPatches } from "./pivot-codec.ts";
import {
  boundedWriteRanges,
  sheetNamesOf,
  summarizeWriteSet,
  type WorkbookChanges,
  workbookSheets,
} from "./summary.ts";
import { fixupMutationForTransport, reconcileFilterResource } from "./transport.ts";
import { assertLegacyWorkbookWriteSupported } from "./workbook-manifest.ts";
import { deriveWriteSetAll } from "./writeset.ts";
import { type ImportedWorkbook, importXlsx } from "./xlsx.ts";
import { textOf } from "./xml.ts";

const MAX_SUBMIT_CELLS = 200_000;
const MAX_PREVIEW_CELLS = 2000;
const MAX_CONFLICT_CELLS = 50;
/** ADR 0002：公式数不超过该值的工作簿，提交同步等待重算并把结果并入本修订。 */
const FORMULA_SYNC_THRESHOLD = 5000;
const SYNC_CALC_MS = 3000;
const RECALC_MS = 30_000;
/** 超过该单元格数的工作簿不在提交路径做整本导出预检（导出只在检查点做）。 */
const PRECHECK_MAX_CELLS = 100_000;
const MAX_FORMULA_VALUES = 50;
const EXTERNAL_CONFLICT =
  "外部修改与未写回修订冲突，写回已暂停：请选择保留应用中的版本或载入外部版本";
const SOURCE_UNREADABLE = "源文件暂时无法读取，写回将稍后重试";

export interface DocumentMeta {
  id: string;
  workspaceId: string;
  path: string;
  kind: DocKind;
  rev: number;
  createdAt: string;
  checkpointRev?: number;
  checkpointError?: string;
  /** 外部修改与未写回修订冲突，写回已暂停，等用户二选一（07 §5）。 */
  externalConflict?: boolean;
  /** 有尚未作为 engine 修订提交的公式重算（ADR 0002）。 */
  calcPending?: boolean;
}

export class DocNotFoundError extends Error {
  constructor(docId: string) {
    super(`文档不存在：${docId}`);
    this.name = "DocNotFoundError";
  }
}

export class UnsupportedDocError extends FileOperationError {
  constructor(path: string) {
    super(
      "UNSUPPORTED_FEATURE",
      [".xls", ".xlsb"].includes(extname(path).toLowerCase())
        ? `旧格式不能直接读取或修改：${path}。请在界面打开该文件并选择“导入为新 .xlsx”，生成可能有损的转换副本，原文件保持不变；这是界面专用操作，不是模型可调用的工具。`
        : `不支持的文档类型（仅支持 .xlsx/.xlsm/.csv/.tsv）：${path}`,
    );
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

/** 修订撤销：记下回退修订对应的原修订，供修订列表标注"已撤销"。 */
export const DOC_OPS_REVERTS_MIGRATION: Migration = {
  id: "workbook/doc-ops-reverts",
  sql: "ALTER TABLE doc_ops ADD COLUMN reverts INTEGER;",
};

export const DOC_MOVES_MIGRATION: Migration = {
  id: "workbook/doc-moves",
  sql: "CREATE TABLE doc_moves (doc_id TEXT PRIMARY KEY, from_path TEXT NOT NULL, to_path TEXT NOT NULL, hash TEXT NOT NULL);",
};

export const DOC_PATH_MOVES_MIGRATION: Migration = {
  id: "workbook/doc-path-moves",
  sql: "CREATE TABLE doc_path_moves (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, from_path TEXT NOT NULL, to_path TEXT NOT NULL, hash TEXT NOT NULL);",
};

export interface DocWriteSet {
  objects?: string[];
  ranges: RangeRef[];
  structural: StructuralOp[];
}

/** 一次已提交的用户编辑：区域为提交时（head）坐标，带表名与 A1 文本。 */
export interface UserEdit {
  docId: string;
  path: string;
  rev: number;
  ranges: Array<RangeRef & { sheetName: string; a1: string }>;
}

export type SubmitSourceKind = "user" | "agent" | "script" | "engine" | "external";

export interface SubmitSource {
  kind: SubmitSourceKind;
  id: string;
}

export interface SubmitBatch {
  /** Canonical target pinned when acquiring the tool lease; rechecked inside the actor. */
  expectedPath?: string;
  baseRev: number;
  /**
   * 提交者依据读过的区域（省略 = 只按写集判定；用户编辑的读集即写集）。
   * 每个区域可带读取修订 `rev`（坐标处于该修订的坐标系，缺省 = baseRev）；
   * `sheetName` 表示 sheetId 待按表名解析（从会话上下文重建的读集）。
   */
  readSet?: Array<RangeRef & { rev?: number; sheetName?: string; coarse?: boolean }>;
  /**
   * 代理自动读集路径：每个 op 的坐标依据修订按覆盖其目标的最近读取推定（baseRev 视为最近读取修订）；
   * 目标不在读集内、且其坐标在最早与最近读取之间被他人插删改变 → 冲突（依据不明确）。
   */
  perOpBase?: boolean;
  source: SubmitSource;
  sessionId?: string;
  toolCallId?: string;
  /** agent 来源：ChangeOp 编译执行。 */
  ops?: ChangeOp[];
  /** user 来源：工作台 mutation 复现（经传输修补）。 */
  mutations?: DocMutation[];
  dryRun?: boolean;
  /** 新建文件的首次提交：把默认工作表也记入结构变更与可恢复日志。 */
  created?: boolean;
  /** 用户提交的传输修补需要发送方快照（可选）。 */
  senderSnapshot?: unknown;
  /**
   * 用户在冲突条里明确选择「保留我的」：坐标仍从 baseRev 平移到 head，
   * 但不再因 baseRev 之后他人的写入而拒绝（仅 user 来源有效）。
   */
  overwrite?: boolean;
  /** 回退提交：被撤销的修订号（写入 doc_ops.reverts）。 */
  reverts?: number;
}

/** 修订列表的一项（撤销面板）。 */
export interface DocRevisionInfo {
  rev: number;
  sourceKind: string;
  sourceId: string | null;
  sessionId: string | null;
  createdAt: string;
  changes: WorkbookChanges;
  reverts: number | null;
  revertedBy: number | null;
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
  changes: WorkbookChanges;
  sheets?: ReturnType<typeof workbookSheets>;
  mutations: DocMutation[];
  formulas: string[];
  /** ADR 0002：computed = 本次写入引起的重算已完成并并入本修订；pending = 稍后以 engine 修订到达。 */
  calc: "computed" | "pending";
  /** 写入公式单元格的计算值（sheet!A1 → 值；最多 50 个；pending 时不给）。 */
  formulaValues?: Record<string, unknown>;
  preview?: PreviewRegion[];
  backupPath?: string;
}

export interface SubmitFail {
  ok: false;
  code:
    | "INVALID_ARGUMENT"
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
  /** 只读打开的派生值只留内存；已有授权修改/重算才允许记录并写回。 */
  persistEngineResults: boolean;
  computedInMemoryOnly: boolean;
  openedHash: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Trusted origin of committed but not yet checkpointed writes; never inferred from a timer. */
  pendingWriteAccess?: ToolAccessContext;
  /** Retained while an authorized calculation can still produce derived revisions. */
  writeAccess?: ToolAccessContext;
  /** 外部修改与未写回修订冲突（07 §5）：写回暂停，等用户二选一后清除。 */
  external?: { hash: string };
  /** 最近确认过的源文件签名（size/mtime/ino）：未变时跳过整文件读取与哈希。 */
  fileSig?: string;
  /** 源文件暂时不可读（只提示并稍后重试，不暂停）。 */
  readError?: boolean;
  /** 重启后冲突：imported 是外部文件的包、基线是外部快照，下次检查点按快照差异整体写回。 */
  rebased?: boolean;
  /** 工作簿公式数（导入计数 + 之后写入的公式），决定是否同步等待重算。 */
  formulaCount: number;
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

// 尾段允许一级点号：Univer 数字格式 mutation 为 sheet.mutation.set.numfmt / remove.numfmt
const docMutationId = /^[\w-]+\.mutation\.[\w-]+(?:\.[\w-]+)?$/;

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

// 仅存于服务端 SQLite 检查点，不从用户文件读取，也不交给引擎或 xlsx 导出。
const PENDING_CALCULATION = "excelmanusPendingCalculation";
function readCheckpointSnapshot(json: string): { snapshot: IWorkbookData; pending: boolean } {
  const snapshot = JSON.parse(json) as IWorkbookData;
  const pending = snapshot.custom?.[PENDING_CALCULATION] === true;
  if (snapshot.custom) delete snapshot.custom[PENDING_CALCULATION];
  return { snapshot, pending };
}

export class DocumentService {
  private readonly docs = new Map<string, Promise<DocEntry>>();
  private readonly liveEntries = new Map<string, DocEntry>();
  private readonly workspaceTails = new Map<string, Promise<unknown>>();
  private inWorkspace<T>(id: string, action: () => Promise<T>): Promise<T> {
    const run = (this.workspaceTails.get(id) ?? Promise.resolve()).then(action);
    const tail = run.catch(() => {});
    this.workspaceTails.set(id, tail);
    void tail.then(() => {
      if (this.workspaceTails.get(id) === tail) this.workspaceTails.delete(id);
    });
    return run;
  }
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
  /** 用户编辑提交后回调（server 据此通知读过这些区域的代理，02 §4.7）。 */
  onUserEdit: ((edit: UserEdit) => void) | undefined;

  constructor(db: DatabaseSync, backups = new BackupService(db)) {
    this.db = db;
    this.backups = backups;
  }

  // ---------- 打开 / 恢复 ----------

  /** 打开（或复开）工作区内文档：导入 → 建 Univer 实例 → 重放 doc_ops → {docId, rev}。 */
  async open(workspaceId: string, workspaceRoot: string, relPath: string): Promise<OpenedDoc> {
    return this.inWorkspace(workspaceId, () =>
      this.openUnlocked(workspaceId, workspaceRoot, relPath),
    );
  }

  private pendingWriteOrigin(workspaceId: string, path: string): ToolAccessContext | undefined {
    const pendingWrite = this.db
      .prepare(
        "SELECT id,head_rev,checkpoint_rev,checkpoint_snapshot FROM documents WHERE workspace_id=? AND path=?",
      )
      .get(workspaceId, path) as
      | { id: string; head_rev: number; checkpoint_rev: number; checkpoint_snapshot: string | null }
      | undefined;
    let resumedAccess: ToolAccessContext | undefined;
    if (pendingWrite && !this.docs.has(pendingWrite.id)) {
      const pendingCalc = pendingWrite.checkpoint_snapshot
        ? readCheckpointSnapshot(pendingWrite.checkpoint_snapshot).pending
        : false;
      if (pendingWrite.head_rev > pendingWrite.checkpoint_rev || pendingCalc) {
        const lower = pendingCalc
          ? Math.min(pendingWrite.checkpoint_rev, pendingWrite.head_rev - 1)
          : pendingWrite.checkpoint_rev;
        const rows = this.db
          .prepare("SELECT inverse FROM doc_ops WHERE doc_id=? AND rev>? AND rev<=? ORDER BY rev")
          .all(pendingWrite.id, lower, pendingWrite.head_rev);
        const origins = rows.map(
          (row) =>
            (JSON.parse(String(row.inverse ?? "{}")) as { _hostAccessOrigin?: unknown })
              ._hostAccessOrigin,
        );
        const current = currentToolAccess();
        const marked = origins.some((origin) => origin !== undefined);
        const matches = (origin: unknown) => {
          if (!origin || typeof origin !== "object" || !current) return false;
          const o = origin as Record<string, unknown>;
          return (
            o.version === 1 &&
            o.sessionId === current.sessionId &&
            o.originAgentId === current.originAgentId &&
            o.originTurnId === current.originTurnId
          );
        };
        if (marked) {
          if (
            !current?.binding().accessDeliveryRequired ||
            !origins.length ||
            !origins.every(matches)
          )
            throw new FileOperationError(
              "VERSION_CONFLICT",
              "受限任务的待保存修订缺少可信原任务归属；原件和日志均保留，请从原任务继续恢复（仅限原任务当前有效范围；若已无法授权，需人工处理日志），不能由新任务或后台代写",
            );
          resumedAccess = current;
        } else if (current?.binding().accessDeliveryRequired) {
          throw new FileOperationError(
            "VERSION_CONFLICT",
            "待保存修订的原任务归属无法验证；原件和日志均保留，本轮不自动恢复写回",
          );
        }
      }
    }
    return resumedAccess;
  }

  private async openUnlocked(
    workspaceId: string,
    workspaceRoot: string,
    relPath: string,
  ): Promise<OpenedDoc> {
    const checked = assertToolAccess(relPath, workspaceRoot);
    this.assertWorkspaceRoot(workspaceId, workspaceRoot);
    let resumedAccess = this.pendingWriteOrigin(workspaceId, checked);
    this.recoverMoves(workspaceId, workspaceRoot);
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    if (rel !== checked) resumedAccess = this.pendingWriteOrigin(workspaceId, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "workbook-open" }, () =>
        statSync(abs),
      );
    } catch (error) {
      if (error instanceof TurnAccessError) throw error;
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
    const bytes = withFileAccessSync(
      { kind: "file-bytes", path: abs, purpose: "workbook-open" },
      () => readFileSync(abs),
    );
    const existing = this.db
      .prepare("SELECT * FROM documents WHERE workspace_id = ? AND path = ?")
      .get(workspaceId, rel) as DocRow | undefined;
    const cached = existing ? await this.docs.get(existing.id) : undefined;
    // 字节与已验证的检查点相同时复用导入结果，避免每次复开重新解析整本。
    // 外部字节变化仍先走完整导入校验，保留损坏文件和冲突处理语义。
    const imported =
      cached && sha256(bytes) === cached.checkpointHash
        ? cached.imported
        : kind === "xlsx"
          ? importXlsx(bytes, rel)
          : importCsv(bytes, rel);
    if (!cached || sha256(bytes) !== cached.checkpointHash)
      recordDocumentAccess({
        kind: "package-cache-parse",
        path: rel,
        purpose: "decode-opened-bytes",
        packageState: "opened-file-bytes",
      });
    if (cached) {
      await this.enqueue(cached, () => this.checkExternal(cached, true));
      this.db
        .prepare("UPDATE documents SET last_opened_at = ? WHERE id = ?")
        .run(nowIso(), cached.meta.id);
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
    // 外部修改 + 未写回修订（重启后）：以最后检查点快照 + 重放还原应用中的版本，
    // 文档进入"待用户二选一"状态；保真写回以外部文件的包为底（原始包已不在磁盘上）。
    const conflict = Boolean(savedHash && savedHash !== hash && headRev > checkpointRev);
    let externalBaseline: IWorkbookData | undefined;
    let pendingCalculation = false;
    if (conflict) {
      if (!savedSnapshot)
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "外部文件与未写回日志冲突，且缺少检查点快照，无法还原应用中的版本",
        );
      const saved = readCheckpointSnapshot(savedSnapshot);
      const snap = saved.snapshot;
      pendingCalculation = saved.pending;
      externalBaseline = rekeyLike(imported.snapshot, snap);
      this.remapPreservation(imported, snap);
      imported.snapshot = snap;
    } else if (savedHash === hash && savedSnapshot) {
      const saved = readCheckpointSnapshot(savedSnapshot);
      const snap = saved.snapshot;
      pendingCalculation = saved.pending;
      this.remapPreservation(imported, snap);
      hydrateMissingPivotRefresh(imported, snap);
      imported.snapshot = snap;
    }
    // 首次打开即保存检查点快照：之后若外部修改与未写回修订冲突（含重启后），能还原应用版本
    const storeSnapshot = !savedSnapshot && (!savedHash || savedHash === hash);
    this.db
      .prepare(
        "UPDATE documents SET checkpoint_hash=COALESCE(checkpoint_hash,?), checkpoint_snapshot=COALESCE(checkpoint_snapshot,?) WHERE id=?",
      )
      .run(hash, storeSnapshot ? JSON.stringify(imported.snapshot) : null, docId);
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
      conflict ? (savedHash as string) : hash,
      hash,
      pendingCalculation,
      savedHash === hash,
      resumedAccess,
    );
    if (externalBaseline) {
      entry.checkpointSnapshot = externalBaseline;
      entry.rebased = true;
      await this.enqueue(entry, () => this.checkExternal(entry, true));
    } else entry.fileSig = fileSig(st);
    if (savedHash && savedHash !== hash && headRev === checkpointRev)
      await this.enqueue(entry, () => this.reloadExternal(entry, bytes));
    if (headRev > checkpointRev && !entry.external) {
      try {
        await this.enqueue(entry, () => this.doCheckpoint(entry));
      } catch (e) {
        // 启动恢复同样不应对确定性的保真拒绝进行无限重试。
        if (!(e instanceof FileOperationError && e.code === "UNSUPPORTED_FEATURE"))
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
    openedHash: string,
    pendingCalculation: boolean,
    hydrateLegacyPivotMetadata: boolean,
    resumedAccess?: ToolAccessContext,
  ): Promise<DocEntry> {
    const pending = this.docs.get(docId);
    if (pending) return pending;
    const task = (async (): Promise<DocEntry> => {
      const boot = bootUniver();
      const snapshot = JSON.parse(JSON.stringify(imported.snapshot)) as IWorkbookData;
      const book = createBook(boot, snapshot);
      const capture = new MutationCapture(boot);
      const checkpointSnapshot = structuredClone(book.workbook.save());
      // This baseline describes formulas on disk, before createBook normalizes table syntax.
      for (const [sid, sheet] of Object.entries(imported.snapshot.sheets))
        for (const [r, row] of Object.entries(sheet.cellData ?? {}))
          for (const [c, cell] of Object.entries(row ?? {})) {
            const target = checkpointSnapshot.sheets[sid]?.cellData?.[Number(r)]?.[Number(c)];
            const formula = (cell as { f?: string } | undefined)?.f;
            if (formula && target?.f) target.f = formula;
          }
      const ops = this.opsAfter(docId, checkpointRev);
      for (const op of ops) {
        for (const m of op.mutations) {
          const params = JSON.parse(JSON.stringify(m.params ?? {})) as Record<string, unknown>;
          const replay =
            hydrateLegacyPivotMetadata && m.id === OBJECT_LAYER_MUTATION
              ? carryMissingPivotRefresh({ id: m.id, params }, book.workbook.save())
              : { id: m.id, params };
          try {
            if (
              !(await boot.executeCommand(replay.id, replay.params, {
                fromCollab: true,
                excelmanusReplay: true,
              }))
            )
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
      // 回放引起的重算只是重现日志中已有的结果，不另记 engine 修订
      if (ops.length > 0) await boot.waitCalc(SYNC_CALC_MS);
      capture.takeEngineResults();
      const entry: DocEntry = {
        meta: { id: docId, workspaceId, path, kind, rev: headRev, createdAt },
        imported,
        live: { boot, capture, unitId: book.unitId, save: book.workbook.save },
        tail: Promise.resolve(),
        workspaceRoot,
        checkpointSnapshot,
        checkpointHash: hash,
        checkpointRev,
        pendingWriteAccess: headRev > checkpointRev ? resumedAccess : undefined,
        writeAccess: resumedAccess,
        persistEngineResults:
          !workbookProtection(imported).readOnly && (ops.length > 0 || pendingCalculation),
        computedInMemoryOnly: false,
        openedHash,
        formulaCount: Object.values(imported.formulaCounts ?? {}).reduce((s, n) => s + n, 0),
      };
      // 仅剩显式重算授权时，恢复尚未完成的计算；已记录完整结果的回放不重复记修订。
      const lastOp = ops.at(-1);
      if (
        pendingCalculation ||
        (lastOp?.sourceKind === "engine" && lastOp.sourceId === "recalculate")
      ) {
        entry.meta.calcPending = true;
        const done = await boot.waitCalc(RECALC_MS, entry.formulaCount > 0);
        await this.commitEngine(entry);
        if (done) delete entry.meta.calcPending;
        else entry.meta.calcPending = true;
      }
      this.watchCalc(entry);
      entry.meta.checkpointRev = checkpointRev;
      this.metas.set(docId, entry.meta);
      this.liveEntries.set(docId, entry);
      if (!this.watchTimer) {
        this.watchTimer = runWithoutToolAccess(() =>
          setInterval(() => {
            for (const task of this.docs.values())
              void task.then((e) => this.enqueue(e, () => this.checkExternal(e))).catch(() => {});
          }, 1000),
        );
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

  /**
   * 调用方根目录必须是该工作区登记的根目录：docId 只能在其所属工作区内打开，
   * 不能被绑到其他工作区的同名文件（P1-32）。未装配工作区表时（独立使用文档服务）不检查。
   */
  private assertWorkspaceRoot(workspaceId: string, workspaceRoot: string): void {
    let row: { path: string } | undefined;
    try {
      row = this.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as
        | { path: string }
        | undefined;
    } catch {
      return;
    }
    let same = false;
    try {
      same =
        row !== undefined &&
        canonicalWorkspaceRoot(row.path) === canonicalWorkspaceRoot(workspaceRoot);
    } catch {
      same = false;
    }
    if (!same) throw new PathSafetyError("OUT_OF_WORKSPACE", "文档不属于当前工作区");
  }

  /** 拿活文档；未在内存时按 documents 行从工作区重新导入并重放。 */
  async entry(docId: string, workspaceRoot: string): Promise<DocEntry> {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as
      | DocRow
      | undefined;
    if (!row) throw new DocNotFoundError(docId);
    assertToolAccess(row.path, workspaceRoot);
    this.assertWorkspaceRoot(row.workspace_id, workspaceRoot);
    const hit = await this.docs.get(docId);
    if (hit) {
      assertToolAccess(hit.meta.path, workspaceRoot);
      if (canonicalWorkspaceRoot(workspaceRoot) !== canonicalWorkspaceRoot(hit.workspaceRoot))
        throw new PathSafetyError("OUT_OF_WORKSPACE", "文档不属于当前工作区");
      return hit;
    }
    this.recoverMoves(row.workspace_id, workspaceRoot);
    const current = this.db.prepare("SELECT path FROM documents WHERE id=?").get(docId) as {
      path: string;
    };
    const opened = await this.openUnlocked(row.workspace_id, workspaceRoot, current.path);
    return this.entry(opened.meta.id, workspaceRoot);
  }

  /** 移动已登记的单个工作簿；保留 docId 与修订链，普通文件返回 null。 */
  async moveFile(
    workspaceId: string,
    root: string,
    from: string,
    to: string,
  ): Promise<{ docId: string; from: string; to: string } | null> {
    return this.inWorkspace(workspaceId, () => this.moveFileUnlocked(workspaceId, root, from, to));
  }

  /** Hold all affected document actors while the files module performs its synchronous transaction. */
  async withFileMoves(
    workspaceId: string,
    root: string,
    moves: Array<{ from: string; to: string }>,
    execute: (commit: () => void) => ToolResult | Promise<ToolResult>,
  ): Promise<ToolResult> {
    return this.inWorkspace(workspaceId, async () => {
      this.assertWorkspaceRoot(workspaceId, root);
      this.recoverMoves(workspaceId, root);
      const paths = moves.map((move) => ({
        from: resolveWorkspacePath(root, move.from).rel,
        to: resolveWorkspacePath(root, move.to).rel,
      }));
      const rows = this.db
        .prepare("SELECT id,path FROM documents WHERE workspace_id=?")
        .all(workspaceId) as { id: string; path: string }[];
      const affected = rows
        .flatMap((row) => {
          const move = paths.find((m) => row.path === m.from || row.path.startsWith(`${m.from}/`));
          if (!move) return [];
          if (
            row.path === move.from &&
            extname(move.from).toLowerCase() !== extname(move.to).toLowerCase()
          )
            throw new FileOperationError(
              "INVALID_ARGUMENT",
              "重命名不能改变工作簿格式，请保留原扩展名",
            );
          return [{ ...row, to: move.to + row.path.slice(move.from.length) }];
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const entries: DocEntry[] = [];
      for (const row of affected) entries.push(await this.entry(row.id, root));
      const commit = () => {
        for (const row of affected)
          this.db.prepare("UPDATE documents SET path=? WHERE id=?").run(row.to, row.id);
        const roots = paths.filter((m) =>
          affected.some((row) => row.path === m.from || row.path.startsWith(`${m.from}/`)),
        );
        for (const row of this.db
          .prepare("SELECT id,original_path FROM backups WHERE workspace_id=?")
          .all(workspaceId)) {
          const path = String(row.original_path),
            move = roots.find((m) => path === m.from || path.startsWith(`${m.from}/`));
          if (move)
            this.db
              .prepare("UPDATE backups SET original_path=? WHERE id=?")
              .run(move.to + path.slice(move.from.length), row.id!);
        }
      };
      const lock = (i: number): Promise<ToolResult> => {
        const entry = entries[i];
        if (entry) return this.enqueue(entry, () => lock(i + 1));
        return (async () => {
          for (const entry of entries) await this.doCheckpoint(entry);
          const result = await execute(commit);
          if (result.status === "ok") {
            for (const row of affected) {
              const meta = this.metas.get(row.id);
              if (meta) meta.path = row.to;
            }
            for (const entry of entries) entry.fileSig = this.statSig(entry);
          }
          return result;
        })();
      };
      return lock(0);
    });
  }

  private async moveFileUnlocked(
    workspaceId: string,
    root: string,
    from: string,
    to: string,
  ): Promise<{ docId: string; from: string; to: string } | null> {
    this.assertWorkspaceRoot(workspaceId, root);
    this.recoverMoves(workspaceId, root);
    const src = resolveWorkspacePath(root, from);
    const dst = resolveWorkspacePath(root, to);
    const row = this.db
      .prepare("SELECT id FROM documents WHERE workspace_id=? AND path=?")
      .get(workspaceId, src.rel) as { id: string } | undefined;
    if (!row) return this.moveDirectory(workspaceId, root, src, dst);
    const entry = await this.entry(row.id, root);
    return this.enqueue(entry, async () => {
      if (entry.meta.path !== src.rel)
        throw new FileOperationError("VERSION_CONFLICT", "文件路径已改变，请刷新后重试");
      if (src.rel === dst.rel) return { docId: row.id, from: src.rel, to: dst.rel };
      if (extname(src.rel).toLowerCase() !== extname(dst.rel).toLowerCase())
        throw new FileOperationError(
          "INVALID_ARGUMENT",
          "重命名不能改变工作簿格式，请保留原扩展名",
        );
      if (
        existsSync(dst.abs) ||
        this.db
          .prepare("SELECT 1 FROM documents WHERE workspace_id=? AND path=?")
          .get(workspaceId, dst.rel)
      )
        throw new FileOperationError("VERSION_CONFLICT", "目标路径已存在，不会覆盖");
      await this.doCheckpoint(entry);
      mkdirSync(dirname(dst.abs), { recursive: true });
      // 在文件系统操作前持久化意图，重启可补齐路径登记。
      this.db
        .prepare("INSERT INTO doc_moves (doc_id, from_path, to_path, hash) VALUES (?,?,?,?)")
        .run(row.id, src.rel, dst.rel, entry.checkpointHash);
      let linked = false;
      try {
        linkSync(src.abs, dst.abs); // 原子拒绝已存在目标；不覆盖其他文件。
        linked = true;
        unlinkSync(src.abs);
      } catch (error) {
        if (!linked) this.db.prepare("DELETE FROM doc_moves WHERE doc_id=?").run(row.id);
        throw new FileOperationError(
          "VERSION_CONFLICT",
          `移动未完成：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.finishMove(row.id, workspaceId, src.rel, dst.rel);
      entry.meta.path = dst.rel;
      entry.fileSig = this.statSig(entry);
      return { docId: row.id, from: src.rel, to: dst.rel };
    });
  }

  private async moveDirectory(
    workspaceId: string,
    root: string,
    src: { abs: string; rel: string },
    dst: { abs: string; rel: string },
  ): Promise<{ docId: string; from: string; to: string } | null> {
    const rows = this.db
      .prepare("SELECT id,path FROM documents WHERE workspace_id=?")
      .all(workspaceId) as { id: string; path: string }[];
    const moved = rows
      .filter((row) => row.path.startsWith(`${src.rel}/`))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!moved.length) return null;
    if (!src.rel || !dst.rel || dst.rel.startsWith(`${src.rel}/`))
      throw new FileOperationError("INVALID_ARGUMENT", "不能移动工作区根目录或将文件夹移入自身");
    if (src.rel === dst.rel) return { docId: moved[0]!.id, from: src.rel, to: dst.rel };
    if (
      existsSync(dst.abs) ||
      rows.some((row) => row.path === dst.rel || row.path.startsWith(`${dst.rel}/`))
    )
      throw new FileOperationError("VERSION_CONFLICT", "目标路径已存在，不会覆盖");
    if (!statSync(src.abs).isDirectory())
      throw new FileOperationError("INVALID_ARGUMENT", "源路径不是文件夹");
    const entries: DocEntry[] = [];
    for (const row of moved) entries.push(await this.entry(row.id, root));
    const lock = (index: number): Promise<{ docId: string; from: string; to: string }> => {
      const entry = entries[index];
      if (entry) return this.enqueue(entry, () => lock(index + 1));
      return (async () => {
        for (const e of entries) await this.doCheckpoint(e);
        if (existsSync(dst.abs))
          throw new FileOperationError("VERSION_CONFLICT", "目标路径已存在，不会覆盖");
        const hash = pathVersion(src.abs);
        if (!hash) throw new FileOperationError("NOT_FOUND", "源文件夹不存在");
        mkdirSync(dirname(dst.abs), { recursive: true });
        const id = newId("move");
        this.db
          .prepare("INSERT INTO doc_path_moves VALUES (?,?,?,?,?)")
          .run(id, workspaceId, src.rel, dst.rel, hash);
        try {
          renameSync(src.abs, dst.abs);
        } catch (error) {
          this.db.prepare("DELETE FROM doc_path_moves WHERE id=?").run(id);
          throw error;
        }
        this.finishDirectoryMove(id, workspaceId, src.rel, dst.rel);
        for (const e of entries) e.fileSig = this.statSig(e);
        return { docId: moved[0]!.id, from: src.rel, to: dst.rel };
      })();
    };
    return lock(0);
  }

  private finishDirectoryMove(id: string, workspaceId: string, from: string, to: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare("SELECT id,path FROM documents WHERE workspace_id=?")
        .all(workspaceId)) {
        const path = String(row.path);
        if (path.startsWith(`${from}/`))
          this.db
            .prepare("UPDATE documents SET path=? WHERE id=?")
            .run(to + path.slice(from.length), row.id!);
      }
      for (const row of this.db
        .prepare("SELECT id,original_path FROM backups WHERE workspace_id=?")
        .all(workspaceId)) {
        const path = String(row.original_path);
        if (path === from || path.startsWith(`${from}/`))
          this.db
            .prepare("UPDATE backups SET original_path=? WHERE id=?")
            .run(to + path.slice(from.length), row.id!);
      }
      this.db.prepare("DELETE FROM doc_path_moves WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const meta of this.metas.values())
      if (meta.workspaceId === workspaceId && meta.path.startsWith(`${from}/`))
        meta.path = to + meta.path.slice(from.length);
  }

  private finishMove(docId: string, workspaceId: string, from: string, to: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE documents SET path=? WHERE id=?").run(to, docId);
      this.db
        .prepare("UPDATE backups SET original_path=? WHERE workspace_id=? AND original_path=?")
        .run(to, workspaceId, from);
      this.db.prepare("DELETE FROM doc_moves WHERE doc_id=?").run(docId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const meta = this.metas.get(docId);
    if (meta) meta.path = to;
  }

  /** 只恢复已持久化的移动意图；绝不覆盖不同内容的目标。 */
  private recoverMoves(workspaceId: string, root: string): void {
    const access = currentToolAccess();
    if (access && access.binding().decision.kind !== "unbounded") {
      const pendingMove = this.db
        .prepare(
          "SELECT 1 FROM doc_moves m JOIN documents d ON d.id=m.doc_id WHERE d.workspace_id=? LIMIT 1",
        )
        .get(workspaceId);
      const pendingDirectory =
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='doc_path_moves'").get() &&
        this.db
          .prepare("SELECT 1 FROM doc_path_moves WHERE workspace_id=? LIMIT 1")
          .get(workspaceId);
      if (pendingMove || pendingDirectory)
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "工作区有待恢复的移动操作；受限任务不能扫描其他目录，请先独立处理恢复",
        );
      this.backups.recoverFileBatches(workspaceId, root);
      return;
    }
    this.backups.recoverFileBatches(workspaceId, root);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='doc_path_moves'").get()) {
      for (const move of this.db
        .prepare("SELECT * FROM doc_path_moves WHERE workspace_id=?")
        .all(workspaceId)) {
        const from = String(move.from_path),
          to = String(move.to_path),
          id = String(move.id);
        const src = resolveWorkspacePath(root, from).abs,
          dst = resolveWorkspacePath(root, to).abs;
        if (existsSync(src) && !existsSync(dst)) {
          this.db.prepare("DELETE FROM doc_path_moves WHERE id=?").run(id);
          continue;
        }
        if (existsSync(src) || !existsSync(dst) || pathVersion(dst) !== move.hash)
          throw new FileOperationError(
            "VERSION_CONFLICT",
            `文件夹移动恢复需要检查：${from} → ${to}`,
          );
        this.finishDirectoryMove(id, workspaceId, from, to);
      }
    }
    const moves = this.db
      .prepare(`SELECT m.* FROM doc_moves m JOIN documents d ON d.id=m.doc_id
      WHERE d.workspace_id=?`)
      .all(workspaceId);
    for (const move of moves) {
      const from = String(move.from_path),
        to = String(move.to_path),
        id = String(move.doc_id);
      const src = resolveWorkspacePath(root, from).abs,
        dst = resolveWorkspacePath(root, to).abs;
      if (existsSync(src) && !existsSync(dst)) {
        this.db.prepare("DELETE FROM doc_moves WHERE doc_id=?").run(id);
        continue;
      }
      if (!existsSync(dst) || sha256(readFileSync(dst)) !== move.hash)
        throw new FileOperationError("VERSION_CONFLICT", `移动恢复需要检查文件：${from} → ${to}`);
      if (existsSync(src)) {
        const a = statSync(src),
          b = statSync(dst);
        if (a.dev !== b.dev || a.ino !== b.ino)
          throw new FileOperationError("VERSION_CONFLICT", "移动恢复发现两个不同文件，未覆盖");
        unlinkSync(src);
      }
      this.finishMove(id, workspaceId, from, to);
    }
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
    includeImageData = false,
  ): Promise<{ meta: DocumentMeta; snapshot: IWorkbookData }> {
    return this.entry(docId, workspaceRoot).then((e) =>
      this.enqueue(e, async () => {
        await this.checkExternal(e);
        assertToolAccess(e.meta.path, workspaceRoot);
        // Pinned Univer 1.0.2 saveUnit already deep-clones cells/styles/custom and creates
        // fresh serialized resources; snapshot-isolation.test.ts guards this contract.
        const snapshot = e.live.save();
        recordDocumentAccess({
          kind: "document-snapshot",
          path: e.meta.path,
          docId: e.meta.id,
          rev: e.meta.rev,
          mode: "snapshot",
          purpose: "actor-snapshot",
        });
        if (includeImageData)
          for (const sheet of Object.values(snapshot.sheets)) {
            const objects = objectsOf(sheet);
            for (const image of objects.images) {
              try {
                image.data = Buffer.from(
                  imagePreviewBytes(image, e.imported.preservation?.parts ?? {}),
                ).toString("base64");
              } catch {
                /* Renderer reports missing embedded content explicitly. */
              }
            }
            if (objects.images.length)
              sheet.custom = { ...sheet.custom, excelmanusObjects: objects };
          }
        return { meta: { ...e.meta }, snapshot };
      }),
    );
  }

  /** 本次打开与当前磁盘字节的真实比较；不把历史变更归因于本次读取。 */
  sourceStatus(docId: string, root: string) {
    this.assertMacroReadEntry(docId, root);
    return this.entry(docId, root).then((entry) =>
      this.enqueue(entry, () => {
        const currentSha256 = sha256(
          withFileAccessSync(
            {
              kind: "file-bytes",
              path: entry.meta.path,
              docId: entry.meta.id,
              rev: entry.meta.rev,
              purpose: "source-status-hash",
            },
            () => readFileSync(resolveWorkspacePath(root, entry.meta.path).abs),
          ),
        );
        return {
          openedSha256: entry.openedHash,
          currentSha256,
          changedSinceOpen: currentSha256 !== entry.openedHash,
          calculation: entry.computedInMemoryOnly
            ? "computed-in-memory-not-persisted"
            : "no-unpersisted-calculation-observed",
          pendingWrite:
            entry.meta.rev > entry.checkpointRev ||
            (!!entry.writeAccess && entry.meta.calcPending === true),
        };
      }),
    );
  }

  /** Do not let a macro metadata read trigger cold pending-write recovery. */
  assertMacroReadOpen(
    workspaceId: string,
    root: string,
    input: { docId?: string; path?: string },
  ): void {
    const path = this.editTarget(workspaceId, root, input);
    const row = this.db
      .prepare("SELECT * FROM documents WHERE workspace_id=? AND path=?")
      .get(workspaceId, path) as DocRow | undefined;
    if (!row || row.kind !== "xlsx" || this.docs.has(row.id)) return;
    const pending =
      row.head_rev > row.checkpoint_rev ||
      (row.checkpoint_snapshot !== null &&
        readCheckpointSnapshot(row.checkpoint_snapshot).pending) ||
      this.db.prepare("SELECT 1 FROM doc_checkpoints WHERE doc_id=?").get(row.id) !== undefined;
    if (!pending) return;
    const bytes = withFileAccessSync(
      { kind: "file-bytes", path, docId: row.id, purpose: "macro-cold-read-preflight" },
      () => readFileSync(resolveWorkspacePath(root, path).abs),
    );
    // Empty path intentionally excludes extension-only detection for this lifecycle guard.
    const macro = inspectMacroPackage(bytes, "", {
      checkpointRev: row.checkpoint_rev,
      currentRev: row.head_rev,
      packageRev: null,
      isCurrent: false,
      packageState: "unconfirmed_disk",
    });
    if (macro)
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "此宏工作簿存在尚未恢复的保存或计算状态；只读宏核验不会自动恢复写回，请先从原任务处理后再读取。",
      );
  }

  private assertMacroReadEntry(docId: string, root: string): void {
    const row = this.db.prepare("SELECT workspace_id FROM documents WHERE id=?").get(docId) as
      | { workspace_id: string }
      | undefined;
    if (!row) throw new DocNotFoundError(docId);
    this.assertMacroReadOpen(row.workspace_id, root, { docId });
  }

  /** Same-buffer disk facts, serialized with writes; this read never checkpoints or commits. */
  macroEvidence(docId: string, root: string) {
    this.assertMacroReadEntry(docId, root);
    return this.entry(docId, root).then((entry) =>
      this.enqueue(entry, () => this.readMacroEvidence(entry)),
    );
  }

  private readMacroEvidence(entry: DocEntry) {
    assertToolAccess(entry.meta.path, entry.workspaceRoot);
    const bytes = withFileAccessSync(
      {
        kind: "file-bytes",
        path: entry.meta.path,
        docId: entry.meta.id,
        rev: entry.meta.rev,
        purpose: "macro-evidence-current-disk",
      },
      () => readFileSync(resolveWorkspacePath(entry.workspaceRoot, entry.meta.path).abs),
    );
    const currentSha256 = sha256(bytes);
    const pendingWrite =
      entry.meta.rev > entry.checkpointRev ||
      (entry.persistEngineResults && entry.meta.calcPending === true);
    const packageRev =
      currentSha256 === entry.checkpointHash && !entry.rebased && !entry.external
        ? entry.checkpointRev
        : null;
    const isCurrent =
      packageRev !== null &&
      entry.checkpointRev === entry.meta.rev &&
      !pendingWrite &&
      !entry.readError &&
      !entry.meta.checkpointError;
    return {
      docId: entry.meta.id,
      path: entry.meta.path,
      rev: entry.meta.rev,
      docRevs: { [entry.meta.id]: entry.meta.rev },
      sourceFile: {
        openedSha256: entry.openedHash,
        currentSha256,
        changedSinceOpen: currentSha256 !== entry.openedHash,
        calculation: entry.computedInMemoryOnly
          ? "computed-in-memory-not-persisted"
          : "no-unpersisted-calculation-observed",
        pendingWrite,
      },
      macroEvidence:
        entry.meta.kind === "xlsx"
          ? inspectMacroPackage(bytes, entry.meta.path, {
              checkpointRev: entry.checkpointRev,
              currentRev: entry.meta.rev,
              packageRev,
              isCurrent,
              packageState: isCurrent
                ? "confirmed_checkpoint"
                : packageRev !== null
                  ? "saved_checkpoint_not_current"
                  : "unconfirmed_disk",
            })
          : undefined,
    };
  }

  imagePreview(docId: string, root: string, sheetId: string, imageId: string) {
    return this.entry(docId, root).then((e) =>
      this.enqueue(e, () => {
        const image = objectsOf(e.live.save().sheets[sheetId]).images.find((i) => i.id === imageId);
        if (!image) throw new FileOperationError("INVALID_ARGUMENT", "图片不存在");
        return {
          bytes: imagePreviewBytes(image, e.imported.preservation?.parts ?? {}),
          mediaType: image.mediaType,
        };
      }),
    );
  }

  /** 进程内已知的 docId（WS 订阅校验用；也看库）。 */
  hasDoc(docId: string): boolean {
    if (this.docs.has(docId) || this.metas.has(docId)) return true;
    return this.db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId) !== undefined;
  }

  /** Host-only final barrier across the whole trusted origin, not model-selected sources.
   * Pure synchronous state inspection: never opens an actor/file or starts calculation/save.
   */
  hasPendingWritesForOrigin(
    workspaceId: string,
    origin: Pick<ToolAccessContext, "sessionId" | "originAgentId" | "originTurnId">,
  ): boolean {
    const matches = (value: unknown, persisted = false): boolean => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Record<string, unknown>;
      return (
        (!persisted || candidate.version === 1) &&
        candidate.sessionId === origin.sessionId &&
        candidate.originAgentId === origin.originAgentId &&
        candidate.originTurnId === origin.originTurnId
      );
    };
    for (const entry of this.liveEntries.values()) {
      if (entry.meta.workspaceId !== workspaceId) continue;
      if (
        (entry.meta.rev > entry.checkpointRev && matches(entry.pendingWriteAccess)) ||
        (entry.meta.calcPending && matches(entry.writeAccess))
      )
        return true;
    }
    const rows = this.db
      .prepare(
        "SELECT id,head_rev,checkpoint_rev,checkpoint_snapshot FROM documents WHERE workspace_id=?",
      )
      .all(workspaceId) as Pick<
      DocRow,
      "id" | "head_rev" | "checkpoint_rev" | "checkpoint_snapshot"
    >[];
    for (const row of rows) {
      // An active actor is authoritative; a saved pending flag can be older than its state.
      if (this.liveEntries.has(row.id)) continue;
      const pendingCalc = row.checkpoint_snapshot
        ? readCheckpointSnapshot(row.checkpoint_snapshot).pending
        : false;
      if (row.head_rev <= row.checkpoint_rev && !pendingCalc) continue;
      const lower = pendingCalc
        ? Math.min(row.checkpoint_rev, row.head_rev - 1)
        : row.checkpoint_rev;
      const pending = this.db
        .prepare("SELECT inverse FROM doc_ops WHERE doc_id=? AND rev>? AND rev<=?")
        .all(row.id, lower, row.head_rev);
      if (
        pending.some((op) =>
          matches(
            (JSON.parse(String(op.inverse ?? "{}")) as { _hostAccessOrigin?: unknown })
              ._hostAccessOrigin,
            true,
          ),
        )
      )
        return true;
    }
    return false;
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
    try {
      const entry = await this.entry(docId, workspaceRoot);
      return await this.enqueue(entry, (): Promise<SubmitResult> | SubmitResult => {
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
        // 逆操作还原的是曾经通过可写性判定的状态：跳过面向新编辑的 mutation 白名单，
        // 保真性仍由导出预检/检查点保证
        return this.doSubmit(
          entry,
          {
            baseRev: entry.meta.rev,
            readSet: [],
            source,
            sessionId,
            toolCallId,
            mutations,
            reverts: rev,
          },
          { revert: true },
        );
      });
    } catch (e) {
      return {
        ok: false,
        code: e instanceof FileOperationError ? (e.code as SubmitFail["code"]) : "INTERNAL",
        message: e instanceof FileOperationError ? e.message : "回退修订失败",
      };
    }
  }

  /** 修订列表（新到旧，不含公式重算的 engine 修订）；区域按当前表名显示。 */
  async revisions(
    docId: string,
    workspaceRoot: string,
    opts: { limit: number; before?: number },
  ): Promise<{ headRev: number; items: DocRevisionInfo[] }> {
    const { meta, snapshot } = await this.snapshot(docId, workspaceRoot);
    const names = sheetNamesOf(snapshot as IWorkbookData);
    const rows = this.db
      .prepare(
        `SELECT rev, source_kind, source_id, session_id, created_at, write_set, reverts,
           (SELECT MAX(r.rev) FROM doc_ops r WHERE r.doc_id = o.doc_id AND r.reverts = o.rev) AS reverted_by
         FROM doc_ops o WHERE doc_id = ? AND source_kind != 'engine' AND rev < ?
         ORDER BY rev DESC LIMIT ?`,
      )
      .all(docId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) as Array<{
      rev: number;
      source_kind: string;
      source_id: string | null;
      session_id: string | null;
      created_at: string;
      write_set: string;
      reverts: number | null;
      reverted_by: number | null;
    }>;
    return {
      headRev: meta.rev,
      items: rows.map((r) => ({
        rev: r.rev,
        sourceKind: r.source_kind,
        sourceId: r.source_id,
        sessionId: r.session_id,
        createdAt: r.created_at,
        changes: summarizeWriteSet(JSON.parse(r.write_set) as DocWriteSet, names),
        reverts: r.reverts,
        revertedBy: r.reverted_by,
      })),
    };
  }

  /**
   * 用户撤销某次修订（撤销面板、/undo）：只在之后没有其他修订改到同一区域时才回退，
   * 否则拒绝并说明（不静默覆盖后来的修改）。结构变更的修订只能在它是最新修订时撤销。
   */
  async undoRevision(
    docId: string,
    workspaceRoot: string,
    rev: number,
    source: SubmitSource,
  ): Promise<SubmitResult> {
    const target = this.db
      .prepare("SELECT write_set, source_kind FROM doc_ops WHERE doc_id = ? AND rev = ?")
      .get(docId, rev) as { write_set: string; source_kind: string } | undefined;
    if (!target || target.source_kind === "engine")
      return { ok: false, code: "DOC_NOT_FOUND", message: "修订不存在" };
    if (this.db.prepare("SELECT 1 FROM doc_ops WHERE doc_id = ? AND reverts = ?").get(docId, rev))
      return { ok: false, code: "VERSION_CONFLICT", message: `修订 ${rev} 已经撤销过` };
    const ws = JSON.parse(target.write_set) as DocWriteSet;
    const overlaps = (a: RangeRef, b: RangeRef) =>
      a.sheetId === b.sheetId && a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
    const conflicts = (a: DocWriteSet, b: DocWriteSet) =>
      a.structural.length > 0 ||
      b.structural.length > 0 ||
      a.ranges.some((r) => b.ranges.some((t) => overlaps(r, t)));
    const reversals = new Map(
      (
        this.db
          .prepare(
            "SELECT rev, reverts FROM doc_ops WHERE doc_id = ? AND rev > ? AND reverts IS NOT NULL",
          )
          .all(docId, rev) as Array<{ rev: number; reverts: number }>
      ).map((r) => [r.rev, r.reverts]),
    );
    const later: DocOpRecord[] = [];
    for (const h of this.opsAfter(docId, rev).filter((h) => h.sourceKind !== "engine")) {
      const index = later.findIndex((r) => r.rev === reversals.get(h.rev));
      const original = later[index];
      // 只抵消没有跨过有效冲突写入的修订/逆操作对；内部强制回退不能掩盖后来的编辑。
      if (
        original &&
        later
          .slice(index + 1)
          .every(
            (r) => !conflicts(r.writeSet, original.writeSet) && !conflicts(r.writeSet, h.writeSet),
          )
      ) {
        later.splice(index, 1);
      } else {
        later.push(h);
      }
    }
    const blocker = later.find((h) => conflicts(ws, h.writeSet));
    if (blocker)
      return {
        ok: false,
        code: "VERSION_CONFLICT",
        message: `修订 ${blocker.rev} 之后又改动了相同区域或表结构，不能单独撤销修订 ${rev}；请先撤销之后的修订`,
      };
    return this.revert(docId, workspaceRoot, rev, source);
  }

  /** Resolve a tool target without opening an actor or changing file bytes. */
  editTarget(workspaceId: string, root: string, input: { docId?: string; path?: string }): string {
    const row = input.docId
      ? (this.db.prepare("SELECT workspace_id,path FROM documents WHERE id=?").get(input.docId) as
          | { workspace_id: string; path: string }
          | undefined)
      : undefined;
    if (row) assertToolAccess(row.path, root);
    if (input.path !== undefined) assertToolAccess(input.path, root);
    this.assertWorkspaceRoot(workspaceId, root);
    const supplied =
      input.path === undefined ? undefined : resolveWorkspacePath(root, input.path).rel;
    if (!input.docId) {
      if (supplied === undefined)
        throw new FileOperationError("INVALID_ARGUMENT", "需要 docId 或 path");
      return supplied;
    }
    if (!row) throw new DocNotFoundError(input.docId);
    if (row.workspace_id !== workspaceId)
      throw new PathSafetyError("OUT_OF_WORKSPACE", "文档不属于当前工作区");
    const canonical = resolveWorkspacePath(root, row.path).rel;
    if (supplied !== undefined && supplied !== canonical)
      throw new FileOperationError(
        "INVALID_ARGUMENT",
        "docId 与 path 指向不同工作簿，本次修改未执行；请重新读取目标并使用一致的 docId/path",
      );
    return canonical;
  }

  meta(docId: string): DocumentMeta | undefined {
    return this.metas.get(docId);
  }

  /** 双方 actor 按稳定顺序锁定，预览版本核对后走唯一提交路径。 */
  async merge(workspaceId: string, root: string, input: MergeDocsBody): Promise<SubmitResult> {
    if (input.sourceDocId === input.targetDocId)
      return { ok: false, code: "BAD_OPERATION", message: "请选择两个不同的工作簿" };
    return this.inWorkspace(workspaceId, async () => {
      const source = await this.entry(input.sourceDocId, root),
        target = await this.entry(input.targetDocId, root);
      if (source.meta.workspaceId !== workspaceId || target.meta.workspaceId !== workspaceId)
        throw new DocNotFoundError(input.targetDocId);
      const entries = [source, target].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
      const lock = (i: number): Promise<SubmitResult> => {
        const entry = entries[i];
        if (entry) return this.enqueue(entry, () => lock(i + 1));
        return (async (): Promise<SubmitResult> => {
          for (const e of entries) {
            await this.checkExternal(e);
            await this.commitEngine(e);
          }
          if (
            source.external ||
            target.external ||
            source.meta.rev !== input.sourceRev ||
            target.meta.rev !== input.targetRev
          )
            return {
              ok: false,
              code: "VERSION_CONFLICT",
              message: "工作簿已在对比后发生变化，请重新对比再合并",
            };
          const mutations = mergeMutations(source.live.save(), target.live.save(), input.cells);
          return this.doSubmit(target, {
            baseRev: input.targetRev,
            source: { kind: "user", id: "compare-merge" },
            mutations,
          });
        })();
      };
      return lock(0);
    });
  }

  // ---------- 提交 ----------

  /**
   * 统一写入路径（07 §3.3）：冲突检查（变换坐标）→ 编译/修补 → 同步窗口执行 →
   * 前像逆操作 → dryRun 回滚 或 事务写 doc_ops + head_rev → 广播。
   */
  submit(docId: string, workspaceRoot: string, batch: SubmitBatch): Promise<SubmitResult> {
    return Promise.resolve()
      .then(() => {
        this.assertMacroReadEntry(docId, workspaceRoot);
        return this.entry(docId, workspaceRoot);
      })
      .then((e) => this.enqueue(e, () => this.doSubmit(e, batch)))
      .catch((e): SubmitFail => {
        if (e instanceof DocNotFoundError) {
          return { ok: false, code: "DOC_NOT_FOUND", message: e.message };
        }
        return {
          ok: false,
          code:
            e instanceof FileOperationError || e instanceof TurnAccessError
              ? (e.code as SubmitFail["code"])
              : "BAD_OPERATION",
          message:
            e instanceof FileOperationError || e instanceof TurnAccessError
              ? e.message
              : "文档操作失败",
        };
      });
  }

  private async doSubmit(
    entry: DocEntry,
    batch: SubmitBatch,
    opts: { revert?: boolean } = {},
  ): Promise<SubmitResult> {
    assertToolWriteAccess(entry.meta.path, entry.workspaceRoot);
    for (const op of batch.ops ?? [])
      if (op.op === "image.add") assertToolAccess(op.path, entry.workspaceRoot);
    const macroBefore =
      entry.meta.kind === "xlsx" ? this.readMacroEvidence(entry).macroEvidence : undefined;
    if (macroBefore) {
      assertUnprotected(entry.imported);
      assertMacroWriteSupported(
        macroBefore,
        entry.live.save(),
        batch.ops,
        batch.mutations,
        opts.revert === true,
      );
      if (macroBefore.checkpoint.packageRev === null)
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "宏包与已确认检查点不同，请先处理外部变更；本批修改未执行",
        );
    }
    if (!batch.dryRun) await this.prepareWriteOrigin(entry);
    if (
      batch.expectedPath !== undefined &&
      resolveWorkspacePath(entry.workspaceRoot, entry.meta.path).rel !== batch.expectedPath
    )
      throw new FileOperationError(
        "INVALID_ARGUMENT",
        "工作簿路径已改变，本次修改未执行；请重新读取目标",
      );
    await this.checkExternal(entry);
    if (entry.external)
      return {
        ok: false,
        code: "VERSION_CONFLICT",
        message: `${EXTERNAL_CONFLICT}；选择前暂停写入`,
      };
    assertUnprotected(entry.imported);
    assertNoExternalFormulaInputs(batch.ops, batch.mutations);
    if (batch.ops?.some((op) => op.op === "recalculate"))
      assertExternalRecalculation(entry.live.save());
    // 之前异步到达的引擎结果先成为独立修订，本次冲突检查能看到它
    await this.commitEngine(entry);
    const recalc = batch.ops?.some((o) => o.op === "recalculate") === true;
    if (!batch.created && recalc && batch.ops?.every((o) => o.op === "recalculate")) {
      if (!batch.dryRun) await this.commitEngine(entry, true);
      const done = await entry.live.boot.waitCalc(
        RECALC_MS,
        batch.dryRun !== true && entry.formulaCount > 0,
      );
      await this.commitEngine(entry);
      if (done) delete entry.meta.calcPending;
      else if (!batch.dryRun) entry.meta.calcPending = true;
      if (!batch.dryRun && currentToolAccess()?.binding().accessDeliveryRequired)
        await this.doCheckpoint(entry);
      return {
        ok: true,
        docId: entry.meta.id,
        rev: entry.meta.rev,
        dryRun: batch.dryRun === true,
        writeSet: { ranges: [], structural: [] },
        changes: summarizeWriteSet({ ranges: [], structural: [] }, new Map()),
        mutations: [],
        formulas: [],
        calc: done ? "computed" : "pending",
      };
    }
    const { live, meta } = entry;
    const head = meta.rev;
    if (!Number.isInteger(batch.baseRev) || batch.baseRev < 0 || batch.baseRev > head)
      return { ok: false, code: "VERSION_CONFLICT", message: "baseRev 不在当前修订范围" };

    // ---- 0. 各 op 坐标依据修订之后的结构操作先把本次写入坐标平移到当前快照 ----
    let snapSheets: { order: string[]; sheets: Record<string, IWorksheetData> } | undefined;
    const sheetIdOf = (nameOrId: string | undefined): string | undefined => {
      if (!snapSheets) {
        const snap = live.save();
        snapSheets = {
          order: snap.sheetOrder ?? [],
          sheets: (snap.sheets ?? {}) as Record<string, IWorksheetData>,
        };
      }
      if (nameOrId === undefined) return snapSheets.order[0];
      if (snapSheets.sheets[nameOrId]) return nameOrId;
      for (const [id, s] of Object.entries(snapSheets.sheets)) {
        if (s.name === nameOrId) return id;
      }
      return undefined;
    };
    let opBases: number[] | undefined;
    if (batch.perOpBase && batch.ops !== undefined && batch.readSet !== undefined) {
      const inferred = this.inferOpBases(entry, batch, batch.ops, sheetIdOf);
      if (!Array.isArray(inferred)) return inferred;
      opBases = inferred;
    }
    const minBase = Math.min(batch.baseRev, ...(opBases ?? []));
    const history = this.opsAfter(meta.id, minBase).filter((r) => r.rev <= head);
    const structurals = history.flatMap((h) => h.writeSet.structural);
    const structuralsAfter = (rev: number) =>
      rev === minBase
        ? structurals
        : history.filter((h) => h.rev > rev).flatMap((h) => h.writeSet.structural);
    let opsIn = batch.ops;
    let mutIn = batch.mutations;
    if (structurals.length > 0) {
      if (batch.ops !== undefined) {
        const mapped: ChangeOp[] = [];
        for (const [i, op] of batch.ops.entries()) {
          const t = transformChangeOp(
            op,
            structuralsAfter(opBases?.[i] ?? batch.baseRev),
            sheetIdOf,
          );
          if (t === "deleted" || t === "ambiguous") {
            return {
              ok: false,
              code: "VERSION_CONFLICT",
              message:
                t === "deleted"
                  ? "目标行/列/工作表已被 baseRev 之后的结构修订删除"
                  : "目标区域内部在 baseRev 之后被插入或删除了行列，无法确定性平移，请重读后再写",
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
        compiled = compileOps(
          {
            unitId: live.unitId,
            snapshot: snap,
            images: loadImageFiles(opsIn, entry.workspaceRoot),
            preservation: entry.imported.preservation,
          },
          opsIn,
        );
        mutations = [];
      } else {
        const normalized = normalizeMutations(mutIn ?? []);
        const raw = opts.revert
          ? normalized.map((mutation) => carryMissingPivotRefresh(mutation, live.save()))
          : normalized;
        if (
          !opts.revert &&
          batch.source.kind === "user" &&
          raw.some((mutation) => isDerivedWorkbookMutation(mutation))
        )
          return {
            ok: false,
            code: "UNSUPPORTED_FEATURE",
            message: "工作台不能回传公式派生状态或计算结果；请提交由用户命令触发的修改",
          };
        if (raw.some((mutation) => mutation.id === OBJECT_LAYER_MUTATION)) {
          const before = live.save();
          const projected = structuredClone(before);
          for (const mutation of raw) {
            if (mutation.id !== OBJECT_LAYER_MUTATION) continue;
            const { subUnitId, objects } = SheetObjectsMutation.parse(mutation.params);
            const sheet = projected.sheets[subUnitId];
            if (sheet) sheet.custom = { ...sheet.custom, excelmanusObjects: objects };
          }
          assertPivotRefreshChanges(before, projected, opts.revert === true);
          planPivotRefreshPatches(
            entry.imported.preservation?.parts ?? {},
            entry.imported.preservation?.sheetParts ?? {},
            projected,
            before,
          );
        }
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
    if (batch.created) {
      const snapshot = live.save();
      writeSet.structural.unshift(
        ...snapshot.sheetOrder.map(
          (sheetId, index): StructuralOp => ({ sheetId, kind: "insertSheet", index, count: 0 }),
        ),
      );
    }
    // ---- 2. 冲突检查（统一在 head 坐标系；写集已在编译前平移；同源修订不算冲突） ----
    if (!(batch.overwrite === true && batch.source.kind === "user")) {
      const conflict = this.checkConflicts(entry, batch, batch.readSet ?? [], writeSet, minBase);
      if (conflict) return conflict;
    }

    // ---- 3. 20 万格上限（无界区域不计入） ----
    const boundedCells = boundedWriteRanges(writeSet.ranges).reduce(
      (s, r) => s + (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1),
      0,
    );
    if (boundedCells > MAX_SUBMIT_CELLS) {
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        message: `单次提交最多 ${MAX_SUBMIT_CELLS} 格，本次约 ${boundedCells} 格`,
      };
    }

    if (!opts.revert)
      assertWritable(
        entry.imported,
        writeSet.ranges,
        opsIn,
        mutations,
        live.save(),
        this.opsAfter(entry.meta.id, entry.checkpointRev).flatMap(
          (record) => record.writeSet.structural,
        ),
      );
    assertExternalLinkWrites(live.save(), opsIn, mutations, compiled);
    const workbookPart = entry.imported.preservation?.parts["xl/workbook.xml"];
    if (workbookPart) {
      const commands = compiled?.commands ?? mutations;
      assertLegacyWorkbookWriteSupported(textOf(workbookPart), {
        sheets:
          opsIn?.some((op) => /^sheet\.(?:add|delete|copy|move|rename|hide)$/.test(op.op)) ||
          commands.some((m) =>
            /(?:insert|remove|copy|move)-sheet|set-worksheet-(?:name|hidden|show|order)/.test(m.id),
          ),
        calcPr:
          !!compiled?.formulas.length ||
          commands.some((m) => mutationWritesFormula(m.params)) ||
          (entry.formulaCount > 0 &&
            (opsIn?.some(
              (op) =>
                (op.op === "find_replace" && op.formulas) ||
                /^(?:rows|cols)\.(?:insert|delete)$|^sheet\.(?:copy|rename|delete)$|^(?:sort|cells\.fill)$/.test(
                  op.op,
                ),
            ) ||
              commands.some((m) =>
                /move-range|move-rows|move-columns|reorder-range|(?:insert|remove)-(?:row|col)|copy-sheet|set-worksheet-name/.test(
                  m.id,
                ),
              ))),
      });
    }
    let backupPath: string | undefined;
    if (
      !batch.dryRun &&
      (batch.source.kind === "agent" ||
        batch.source.kind === "script" ||
        batch.source.kind === "user")
    ) {
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
        changes: summarizeWriteSet(writeSet, compiled?.sheetNames ?? sheetNamesOf(live.save())),
        mutations: [],
        formulas: [],
        calc: "computed",
        preview: [],
      };
    }

    // ---- 5. 应用（同步命令窗口内捕获 mutation） ----
    const preSnap = structuredClone(live.save());
    const unpersistedExternal = entry.computedInMemoryOnly && externalCells(preSnap).length > 0;
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
    } catch (e) {
      // 命令抛错：交出给下面统一回滚
      execError ??= `命令执行失败：${e instanceof Error ? e.message : String(e)}`;
    }
    if (execError !== undefined) {
      await this.restore(entry, preSnap);
      return { ok: false, code: "BAD_OPERATION", message: execError };
    }

    // ---- 5b. 公式重算（ADR 0002）：小工作簿同步等待，结果并入本修订；否则标 pending ----
    const formulas = compiled !== undefined ? compiled.formulas : collectFormulas(entry, emitted);
    const formulaTotal = entry.formulaCount + formulas.length;
    let calc: SubmitOk["calc"] = "computed";
    if (formulaTotal > 0 && (recalc || formulaTotal <= FORMULA_SYNC_THRESHOLD)) {
      if (!(await live.boot.waitCalc(recalc ? RECALC_MS : SYNC_CALC_MS, recalc))) calc = "pending";
    } else if (formulaTotal > 0) calc = "pending";
    const externalResults = filterExternalEngineResults(
      live.capture.takeEngineResults(),
      live.save(),
      entry.imported.snapshot,
    );
    const engineResults = withFormulas(externalResults.results, live.save());
    emitted.push(...engineResults);

    const postSnap = live.save();
    try {
      assertPivotRefreshChanges(preSnap, postSnap, opts.revert === true);
      // The bounded OOXML validation cannot be skipped by the large-workbook fast path.
      const pivotPatches = planPivotRefreshPatches(
        entry.imported.preservation?.parts ?? {},
        entry.imported.preservation?.sheetParts ?? {},
        postSnap,
        entry.checkpointSnapshot,
      );
      if (
        pivotPatches.length &&
        (writeSet.structural.length || deriveWriteSetAll(emitted).structural.length)
      )
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "透视缓存刷新标记不能与源结构变化同批提交",
        );
      if (!postSnap.sheetOrder.some((id) => !postSnap.sheets[id]?.hidden))
        throw new FileOperationError("UNSUPPORTED_FEATURE", "工作簿必须保留至少一个可见工作表");
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
      } else {
        const changes = pendingChanges([
          ...this.opsAfter(meta.id, entry.checkpointRev),
          {
            writeSet: {
              ranges: writeSet.ranges,
              structural: [...writeSet.structural, ...deriveWriteSetAll(emitted).structural],
            },
            sourceKind: batch.source.kind,
            mutations: engineResults,
          },
        ]);
        // 整本导出预检只对小工作簿做；大表导出只在检查点（P1-31，提交确认不被阻塞），
        // 但仍对本次写集命中的格做同规则的轻量保真检查，做不到就在提交时拒绝
        if (macroBefore || cellTotal(entry.imported) <= PRECHECK_MAX_CELLS) {
          const candidate = exportXlsx(
            entry.imported,
            postSnap,
            entry.checkpointSnapshot,
            entry.rebased ? undefined : changes,
          );
          assertMacroPreserved(macroBefore, candidate, entry.meta.path);
        } else
          assertCellsWritable(
            entry.imported,
            postSnap,
            entry.checkpointSnapshot,
            writeSet.ranges,
            entry.rebased ? new Set() : changes.structural,
          );
      }
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
    // 并入的引擎结果是派生值，不计入作者写集（不影响冲突判定与检查点"已修改格"）
    const emittedDerived = deriveWriteSetAll(
      emitted.slice(0, emitted.length - engineResults.length),
    );
    const structural = mergeStructural(
      batch.ops !== undefined ? writeSet.structural : [],
      emittedDerived.structural,
    );
    const objectChanges = describeObjectChanges(preSnap, postSnap);
    for (const sid of postSnap.sheetOrder) {
      const before = {
        settings: printSettingsOf(preSnap.sheets[sid]),
        names: printNamesOf(preSnap, sid),
      };
      const after = {
        settings: printSettingsOf(postSnap.sheets[sid]),
        names: printNamesOf(postSnap, sid),
      };
      if (JSON.stringify(before) !== JSON.stringify(after))
        objectChanges.push(`更新打印设置（${postSnap.sheets[sid]?.name ?? sid}）`);
    }
    for (const [resource, label] of [
      [CF_RESOURCE, "条件格式"],
      [DV_RESOURCE, "数据验证"],
      ["SHEET_FILTER_PLUGIN", "筛选"],
    ] as const) {
      const before = rulesResource(preSnap, resource),
        after = rulesResource(postSnap, resource);
      for (const sid of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (JSON.stringify(before[sid] ?? []) !== JSON.stringify(after[sid] ?? []))
          objectChanges.push(`更新${label}（${postSnap.sheets[sid]?.name ?? sid}）`);
    }
    const finalWriteSet: DocWriteSet = {
      ...(objectChanges.length ? { objects: objectChanges } : {}),
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
    const formulaValues = calc === "computed" ? readFormulaValues(formulas, postSnap) : undefined;

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
        changes: summarizeWriteSet(finalWriteSet, sheetNamesOf(preSnap, postSnap)),
        ...(batch.created ? { sheets: workbookSheets(postSnap) } : {}),
        mutations: emitted,
        formulas,
        calc,
        ...(formulaValues ? { formulaValues } : {}),
        preview,
      };
    }

    // ---- 7. 事务写 doc_ops + head_rev；提交后才广播 ----
    const rev = head + 1;
    const now = nowIso();
    const accessOrigin = this.writeOriginMetadata();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO doc_ops (doc_id, rev, base_rev, source_kind, source_id, session_id, tool_call_id, write_set, mutations, inverse, created_at, reverts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify({ ...inverse, ...accessOrigin }),
          now,
          batch.reverts ?? null,
        );
      this.db
        .prepare("UPDATE documents SET head_rev = ?, rev = ? WHERE id = ?")
        .run(rev, rev, meta.id);
      if (calc === "pending") {
        // 授权与编辑日志同事务落盘，覆盖首次检查点前崩溃；不能以 postSnap 覆盖原基线。
        const saved = this.db
          .prepare("SELECT checkpoint_snapshot FROM documents WHERE id=?")
          .get(meta.id) as { checkpoint_snapshot: string };
        const baseline = readCheckpointSnapshot(saved.checkpoint_snapshot).snapshot;
        baseline.custom = { ...baseline.custom, [PENDING_CALCULATION]: true };
        this.db
          .prepare("UPDATE documents SET checkpoint_snapshot=? WHERE id=?")
          .run(JSON.stringify(baseline), meta.id);
      }
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
    entry.pendingWriteAccess = currentToolAccess();
    entry.writeAccess = currentToolAccess();
    entry.persistEngineResults = true;
    entry.computedInMemoryOnly = unpersistedExternal || externalResults.filtered;
    entry.formulaCount += formulas.length;
    if (calc === "pending") meta.calcPending = true;
    else delete meta.calcPending;
    this.onRevision?.(meta.id, rev, `${batch.source.kind}:${batch.source.id}`, emitted);
    if (batch.source.kind === "user" && finalWriteSet.ranges.length > 0) {
      const names = sheetNamesOf(postSnap);
      this.onUserEdit?.({
        docId: meta.id,
        path: meta.path,
        rev,
        ranges: boundedWriteRanges(finalWriteSet.ranges).map((r) => ({
          ...r,
          sheetName: names.get(r.sheetId) ?? r.sheetId,
          a1: rangeRefToA1(r, names.get(r.sheetId) ?? r.sheetId),
        })),
      });
    }
    this.schedule(entry, batch.source.kind === "user" ? 2000 : 1000);
    if (currentToolAccess()?.binding().accessDeliveryRequired) {
      try {
        await this.doCheckpoint(entry);
      } catch (error) {
        throw new FileOperationError(
          "VERSION_CONFLICT",
          `修订 ${rev} 已提交文档日志，但保存未完成：${error instanceof Error ? error.message : String(error)}；未回滚已提交修订，请先处理保存问题`,
        );
      }
    }
    return {
      ok: true,
      docId: meta.id,
      rev,
      dryRun: false,
      writeSet: finalWriteSet,
      changes: summarizeWriteSet(finalWriteSet, sheetNamesOf(preSnap, postSnap)),
      ...(batch.created ? { sheets: workbookSheets(postSnap) } : {}),
      mutations: emitted,
      formulas,
      calc,
      ...(formulaValues ? { formulaValues } : {}),
      ...(backupPath ? { backupPath } : {}),
    };
  }

  // ---------- 公式引擎修订（ADR 0002） ----------

  /** 引擎在窗口外算完时，把结果排进文档 actor 作为 engine 来源修订提交。 */
  private watchCalc(entry: DocEntry): void {
    entry.live.capture.onEngineResults = () =>
      runWithoutToolAccess(() => {
        void this.enqueue(entry, () =>
          entry.writeAccess
            ? runWithToolAccess(entry.writeAccess, () => this.commitEngine(entry))
            : this.commitEngine(entry),
        ).catch(() => {});
      });
  }

  /** 异步到达的公式结果作为后续修订提交（source.kind = "engine"），走同一日志事务与广播。 */
  private async commitEngine(entry: DocEntry, authorize = false): Promise<void> {
    if (authorize || entry.persistEngineResults)
      assertToolWriteAccess(entry.meta.path, entry.workspaceRoot);
    const raw = entry.live.capture.takeEngineResults();
    if (workbookProtection(entry.imported).readOnly) {
      if (authorize) assertUnprotected(entry.imported);
      if (raw.length > 0) entry.computedInMemoryOnly = true;
      return;
    }
    if (!entry.persistEngineResults && !authorize) {
      if (raw.length > 0) entry.computedInMemoryOnly = true;
      return;
    }
    // 显式重算先记持久授权，即使计算未返回；崩溃后可由未保存日志恢复。
    if (raw.length === 0 && !authorize) return;
    const externalResults = filterExternalEngineResults(
      raw,
      entry.live.save(),
      entry.imported.snapshot,
    );
    if (externalResults.filtered) entry.computedInMemoryOnly = true;
    if (!externalResults.results.length && !authorize) return;
    const results = withFormulas(externalResults.results, entry.live.save());
    const unpersistedExternal =
      entry.computedInMemoryOnly && externalCells(entry.live.save()).length > 0;
    const { meta } = entry;
    const rev = meta.rev + 1;
    const writeSet: DocWriteSet = { ranges: deriveWriteSetAll(results).ranges, structural: [] };
    const accessOrigin = this.writeOriginMetadata();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO doc_ops (doc_id, rev, base_rev, source_kind, source_id, session_id, tool_call_id, write_set, mutations, inverse, created_at)
           VALUES (?, ?, ?, 'engine', ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          meta.id,
          rev,
          meta.rev,
          authorize ? "recalculate" : "formula",
          JSON.stringify(writeSet),
          JSON.stringify(results),
          // 引擎结果是派生值：回退其输入后引擎会重算，自身无需逆操作
          JSON.stringify({ mutations: [], ...accessOrigin }),
          nowIso(),
        );
      this.db
        .prepare("UPDATE documents SET head_rev = ?, rev = ? WHERE id = ?")
        .run(rev, rev, meta.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    meta.rev = rev;
    entry.pendingWriteAccess = currentToolAccess();
    entry.writeAccess = currentToolAccess();
    entry.persistEngineResults = true;
    entry.computedInMemoryOnly = unpersistedExternal || externalResults.filtered;
    if (authorize) meta.calcPending = true;
    else delete meta.calcPending;
    this.onRevision?.(meta.id, rev, "engine:formula", results);
    this.schedule(entry, 1000);
  }

  /** 显式重算：强制新一轮计算，并提交真实引擎结果，供检查点刷新公式缓存。 */
  async recalculate(
    docId: string,
    workspaceRoot: string,
    timeoutMs = RECALC_MS,
  ): Promise<{ rev: number; calc: SubmitOk["calc"] }> {
    this.assertMacroReadEntry(docId, workspaceRoot);
    const entry = await this.entry(docId, workspaceRoot);
    return this.enqueue(entry, async () => {
      assertToolWriteAccess(entry.meta.path, entry.workspaceRoot);
      assertUnprotected(entry.imported);
      if (entry.meta.kind === "xlsx")
        assertMacroWriteSupported(
          this.readMacroEvidence(entry).macroEvidence,
          entry.live.save(),
          [{ op: "recalculate" }],
          undefined,
        );
      await this.prepareWriteOrigin(entry);
      assertExternalRecalculation(entry.live.save());
      await this.commitEngine(entry, true);
      const done = await entry.live.boot.waitCalc(timeoutMs, entry.formulaCount > 0);
      await this.commitEngine(entry);
      if (done) delete entry.meta.calcPending;
      else entry.meta.calcPending = true;
      if (currentToolAccess()?.binding().accessDeliveryRequired) await this.doCheckpoint(entry);
      return { rev: entry.meta.rev, calc: done ? "computed" : "pending" };
    });
  }

  /**
   * 区域级冲突判定（03 §6.1），统一在 head 坐标系下进行：
   * - 本次写集已平移到 head；每个读集区域从其读取修订投影到 head；
   *   每条历史修订的写集经其后各修订的结构操作投影到 head。
   * - 读集区域被插删平移不算冲突（03 §6.1 自动变换）：本次 op 坐标已按其依据修订平移。
   * - 读集区域被整块删除行列：保留删除点处的"影子"区域（即移入该处的单元格），
   *   与删除修订的写集相交 → 冲突，直到在 head 坐标重读该处。
   * - 历史修订 h（非同源）与「读取修订 < h 的读集区域」及（h > writeBase 时）本次写集相交 → 冲突。
   * - 读取修订 ≥ h 的精确读集区域已覆盖的单元格不算冲突（重读即解决）；粗粒度条目不算证据。
   * 同源修订自己知道，只贡献结构变换。
   */
  private checkConflicts(
    entry: DocEntry,
    batch: SubmitBatch,
    readSet: NonNullable<SubmitBatch["readSet"]>,
    writeSet: DocWriteSet,
    writeBase: number,
  ): SubmitFail | undefined {
    const head = entry.meta.rev;
    const reads = this.resolveReadSheets(entry, readSet).map((r) => {
      const rev = Number.isInteger(r.rev) ? Math.min(Math.max(r.rev as number, 0), head) : -1;
      return {
        range: { sheetId: r.sheetId, r0: r.r0, c0: r.c0, r1: r.r1, c1: r.c1 },
        rev: rev < 0 ? batch.baseRev : rev,
        coarse: r.coarse === true,
      };
    });
    const from = Math.min(writeBase, ...reads.map((r) => r.rev));
    const all = this.opsAfter(entry.meta.id, from).filter((h) => h.rev <= head);
    const isOther = (h: DocOpRecord) => !sameSource(h, batch.source);

    // 读集区域投影到 head；整块被删的行列区域停在删除点（影子），被删工作表记下删除修订
    const projected = reads.map((e) => {
      let cur: RangeRef = e.range;
      let shadow = false;
      let removedBy: DocOpRecord | undefined;
      // 他人删除了区域的一部分行/列（区域收缩）：读过的数据被删，等同修改了读集
      const trimmedBy = new Set<number>();
      for (const h of all) {
        if (h.rev <= e.rev || removedBy) continue;
        for (const s of h.writeSet.structural) {
          const t = transformRange(cur, s);
          if (t !== "deleted") {
            if (
              !shadow &&
              !e.coarse &&
              isOther(h) &&
              (s.kind === "deleteRows" || s.kind === "deleteCols") &&
              structuralTouchesInterior(cur, s)
            )
              trimmedBy.add(h.rev);
            cur = t;
          } else if (s.kind === "removeSheet") {
            removedBy = h;
            break;
          } else shadow = true; // 停在删除点，后续结构操作继续平移影子
        }
      }
      return { rev: e.rev, coarse: e.coarse, head: cur, shadow, removedBy, trimmedBy };
    });
    const unknown = (ix: RangeRef, rev: number) =>
      subtractRanges(
        ix,
        projected
          .filter((p) => p.rev >= rev && !p.coarse && !p.shadow && !p.removedBy)
          .map((p) => p.head),
      );
    const known = (ix: RangeRef, rev: number) => unknown(ix, rev).length === 0;
    const fail = (h: DocOpRecord, message: string, cells: RangeRef[]): SubmitFail => ({
      ok: false,
      code: "VERSION_CONFLICT",
      message,
      conflicts: [
        {
          rev: h.rev,
          source: `${h.sourceKind}:${h.sourceId ?? ""}`,
          cells: [...new Set(this.renderCells(entry, cells))].slice(0, MAX_CONFLICT_CELLS),
        },
      ],
    });

    for (const [i, h] of all.entries()) {
      if (!isOther(h)) continue;
      // 读过的工作表被删：之后有任何精确重读（代理已看到删除后的文档）才放行
      const removed = projected.filter((p) => p.removedBy === h);
      if (
        removed.length > 0 &&
        !projected.some((q) => q.rev >= h.rev && !q.coarse && !q.shadow && !q.removedBy)
      )
        return fail(h, `修订 ${h.rev} 删除了本次读过的工作表`, []);
      // 读集被部分删除：收缩后的区域被重读（读取修订 ≥ h）才放行
      const trimmed = projected.filter((p) => p.trimmedBy.has(h.rev) && !known(p.head, h.rev));
      if (trimmed.length > 0)
        return fail(
          h,
          `修订 ${h.rev} 删除了本次读过的部分行/列`,
          trimmed.map((p) => p.head),
        );
      const later = all.slice(i + 1).flatMap((x) => x.writeSet.structural);
      const written: RangeRef[] = [];
      for (const w of conflictRanges(h.writeSet)) {
        const t = transformRangeAll(w, later);
        if (t !== "deleted") written.push(t);
      }
      const incoming = [
        ...projected.flatMap((p) =>
          p.rev < h.rev && !p.removedBy ? [{ range: p.head, shadow: p.shadow }] : [],
        ),
        ...(h.rev > writeBase ? writeSet.ranges.map((range) => ({ range, shadow: false })) : []),
      ];
      const hits: RangeRef[] = [];
      let deleted = false;
      for (const w of written) {
        for (const r of incoming) {
          const ix = rangeIntersection(w, r.range);
          const missing = ix ? unknown(ix, h.rev) : [];
          if (missing.length > 0) {
            hits.push(...missing);
            deleted ||= r.shadow;
          }
        }
      }
      if (hits.length > 0)
        return fail(
          h,
          deleted
            ? `修订 ${h.rev} 删除了本次读过的行/列（冲突单元格为删除后移入该处的位置）`
            : `修订 ${h.rev} 修改了与本次读写重叠的区域`,
          hits,
        );
    }
    return undefined;
  }

  /**
   * 代理自动读集路径（perOpBase）：每个 op 的坐标依据修订 = 覆盖其目标的最近精确读取修订；
   * 无覆盖时取 baseRev（最近读取修订），但若目标坐标在最早与最近读取之间被他人插删改变，
   * 代理所用坐标的依据不明确 → 冲突，提示重读目标区域。
   */
  private inferOpBases(
    entry: DocEntry,
    batch: SubmitBatch,
    ops: ChangeOp[],
    sheetIdOf: (nameOrId: string | undefined) => string | undefined,
  ): number[] | SubmitFail {
    const reads = this.resolveReadSheets(entry, batch.readSet ?? []).filter(
      (r) => Number.isInteger(r.rev) && (r.rev as number) <= batch.baseRev,
    );
    const exact = reads.filter((r) => !r.coarse);
    if (reads.length === 0) return ops.map(() => batch.baseRev);
    const lo = Math.min(...reads.map((r) => r.rev as number));
    const between = this.opsAfter(entry.meta.id, lo).filter(
      (h) => h.rev <= batch.baseRev && !sameSource(h, batch.source),
    );
    const bases: number[] = [];
    for (const op of ops) {
      const target = changeOpTarget(op, sheetIdOf);
      if (!target) {
        bases.push(batch.baseRev);
        continue;
      }
      const { axis, ref } = target;
      const covering = exact.filter((e) => {
        if (e.sheetId !== ref.sheetId && e.sheetId !== "*") return false;
        if (axis === "rows") return e.r0 <= ref.r0 && e.r1 >= ref.r1;
        if (axis === "cols") return e.c0 <= ref.c0 && e.c1 >= ref.c1;
        return rangeContains(e, ref);
      });
      if (covering.length > 0) {
        bases.push(Math.max(...covering.map((e) => e.rev as number)));
        continue;
      }
      const moving = between.find((h) => {
        const t = transformRangeAll(ref, h.writeSet.structural);
        return (
          t === "deleted" ||
          t.r0 !== ref.r0 ||
          t.r1 !== ref.r1 ||
          t.c0 !== ref.c0 ||
          t.c1 !== ref.c1
        );
      });
      if (moving) {
        return {
          ok: false,
          code: "VERSION_CONFLICT",
          message: `写入目标不在读集内，且修订 ${moving.rev} 的插删改变了其坐标，无法确定按哪个修订的坐标写入；请重读目标区域后再写`,
          conflicts: [
            {
              rev: moving.rev,
              source: `${moving.sourceKind}:${moving.sourceId ?? ""}`,
              cells: this.renderCells(entry, [ref]).slice(0, MAX_CONFLICT_CELLS),
            },
          ],
        };
      }
      bases.push(batch.baseRev);
    }
    return bases;
  }

  /** 重建读集的条目只有表名：按当前表名解析 sheetId，解析不到的保持 "*"（保守）。 */
  private resolveReadSheets(
    entry: DocEntry,
    readSet: NonNullable<SubmitBatch["readSet"]>,
  ): NonNullable<SubmitBatch["readSet"]> {
    if (!readSet.some((r) => r.sheetName !== undefined)) return readSet;
    const sheets = (entry.live.save().sheets ?? {}) as Record<string, IWorksheetData>;
    const ids = new Map(Object.entries(sheets).map(([id, s]) => [s.name ?? id, id]));
    return readSet.map((r) =>
      r.sheetName !== undefined ? { ...r, sheetId: ids.get(r.sheetName) ?? r.sheetId } : r,
    );
  }

  private remapPreservation(imported: ImportedWorkbook, snapshot: IWorkbookData): void {
    if (!imported.preservation) return;
    const refs = imported.preservation.sheetParts;
    const sourceByName = new Map<string, string>();
    for (const id of imported.snapshot.sheetOrder) {
      const name = imported.snapshot.sheets[id]?.name;
      if (name !== undefined && !sourceByName.has(name)) sourceByName.set(name, id);
    }
    imported.preservation.sheetParts = Object.fromEntries(
      snapshot.sheetOrder
        .map((id) => {
          const name = snapshot.sheets[id]?.name;
          const sourceId = name === undefined ? undefined : sourceByName.get(name);
          return [id, refs[sourceId ?? ""]] as const;
        })
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
    this.watchCalc(entry);
  }

  private sameWriteOrigin(
    a: ToolAccessContext | undefined,
    b: ToolAccessContext | undefined,
  ): boolean {
    return (
      a === b ||
      (!!a &&
        !!b &&
        a.sessionId === b.sessionId &&
        a.originAgentId === b.originAgentId &&
        a.originTurnId === b.originTurnId)
    );
  }

  /** Host-only provenance, not executable inverse commands or persisted permission. */
  private writeOriginMetadata(): Record<string, unknown> {
    const access = currentToolAccess();
    return access?.binding().accessDeliveryRequired
      ? {
          _hostAccessOrigin: {
            version: 1,
            sessionId: access.sessionId,
            originAgentId: access.originAgentId,
            originTurnId: access.originTurnId,
          },
        }
      : {};
  }

  /** Called inside the actor, so flushing a prior origin cannot deadlock on its own queue. */
  private async prepareWriteOrigin(entry: DocEntry): Promise<void> {
    const current = currentToolAccess();
    if (entry.meta.calcPending && !this.sameWriteOrigin(entry.writeAccess, current))
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "上一任务的计算尚未完成，不能把待保存修订转交给新任务",
      );
    if (
      entry.meta.rev > entry.checkpointRev &&
      !this.sameWriteOrigin(entry.pendingWriteAccess, current)
    )
      await this.doCheckpoint(entry);
  }

  private schedule(entry: DocEntry, delay: number): void {
    if (this.closing || entry.external) return;
    clearTimeout(entry.timer);
    // Independent scheduling never captures whichever task happened to replace the timer.
    entry.timer = runWithoutToolAccess(() =>
      setTimeout(() => {
        entry.timer = undefined;
        void this.enqueue(entry, () => {
          if (entry.meta.rev === entry.checkpointRev) {
            this.finishSavedOrigin(entry);
            return;
          }
          return this.doCheckpoint(entry);
        }).catch((e) => {
          if (
            e instanceof TurnAccessError ||
            (e instanceof FileOperationError && e.code === "UNSUPPORTED_FEATURE")
          )
            return;
          this.schedule(entry, 5000);
        });
      }, delay),
    );
    entry.timer.unref();
  }

  async checkpoint(docId: string, root: string): Promise<void> {
    const entry = await this.entry(docId, root);
    await this.enqueue(entry, () => this.doCheckpoint(entry));
  }

  private async doCheckpoint(entry: DocEntry): Promise<void> {
    const access = entry.meta.rev > entry.checkpointRev ? entry.pendingWriteAccess : undefined;
    if (access) return runWithToolAccess(access, () => this.saveCheckpoint(entry));
    const current = currentToolAccess();
    if (
      entry.meta.rev > entry.checkpointRev &&
      current &&
      current.binding().decision.kind !== "unbounded"
    )
      throw new FileOperationError(
        "VERSION_CONFLICT",
        "待保存修订没有可信的原任务访问归属，本轮不能代写",
      );
    return this.saveCheckpoint(entry);
  }

  private finishSavedOrigin(entry: DocEntry): void {
    if (entry.meta.rev !== entry.checkpointRev) return;
    delete entry.pendingWriteAccess;
    if (entry.writeAccess?.binding().accessDeliveryRequired && !entry.meta.calcPending) {
      entry.persistEngineResults = false;
      delete entry.writeAccess;
    }
  }

  private async saveCheckpoint(entry: DocEntry): Promise<void> {
    if (entry.meta.rev > entry.checkpointRev)
      assertToolWriteAccess(entry.meta.path, entry.workspaceRoot);
    clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      await this.checkExternal(entry, true);
      if (entry.external) throw new FileOperationError("VERSION_CONFLICT", EXTERNAL_CONFLICT);
      if (entry.meta.rev === entry.checkpointRev) {
        this.finishSavedOrigin(entry);
        return;
      }
      assertUnprotected(entry.imported);
      const macroBefore =
        entry.meta.kind === "xlsx" ? this.readMacroEvidence(entry).macroEvidence : undefined;
      const snapshot = structuredClone(entry.live.save());
      const bytes = entry.imported.csv
        ? exportCsv(snapshot, entry.imported.csv)
        : exportXlsx(
            entry.imported,
            snapshot,
            entry.checkpointSnapshot,
            // 以外部包为底写回应用版本（重启后保留应用版本）：写集不覆盖外部差异，按快照差异整体判定
            entry.rebased
              ? undefined
              : pendingChanges(this.opsAfter(entry.meta.id, entry.checkpointRev)),
          );
      assertMacroPreserved(macroBefore, bytes, entry.meta.path);
      const hash = sha256(bytes);
      const nextImported = entry.imported.csv
        ? importCsv(bytes, entry.meta.path)
        : importXlsx(bytes, entry.meta.path);
      restoreSavedExternalCaches(snapshot, nextImported.snapshot);
      const checkpointState = structuredClone(snapshot);
      if (entry.persistEngineResults && entry.meta.calcPending) {
        checkpointState.custom = { ...checkpointState.custom, [PENDING_CALCULATION]: true };
      }
      const saved = JSON.stringify(checkpointState);
      // Durable publication intent closes the rename/SQLite crash window.
      this.db
        .prepare(
          "INSERT INTO doc_checkpoints VALUES (?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET rev=excluded.rev,hash=excluded.hash,snapshot=excluded.snapshot",
        )
        .run(entry.meta.id, entry.meta.rev, hash, saved);
      this.remapPreservation(nextImported, snapshot);
      // exportXlsx 已对这份字节做过回读校验；atomicWrite 再核对临时文件与之逐字节相同，
      // 不再整本重复解析（P1-31）
      atomicWrite(entry.workspaceRoot, entry.meta.path, bytes, entry.checkpointHash);
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
      delete entry.rebased;
      entry.fileSig = this.statSig(entry);
      entry.checkpointRev = entry.meta.rev;
      entry.meta.checkpointRev = entry.checkpointRev;
      delete entry.meta.checkpointError;
      // Actor-serialized completion barrier: no unfinished authorized calculation is discarded.
      this.finishSavedOrigin(entry);
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev);
    } catch (e) {
      entry.meta.checkpointError =
        e instanceof FileOperationError ? e.message : "写回失败，文档日志已保留，将重试";
      this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      throw e;
    }
  }

  private statSig(entry: DocEntry): string | undefined {
    try {
      return fileSig(
        withFileAccessSync(
          { kind: "file-metadata", path: entry.meta.path, purpose: "checkpoint-signature" },
          () => statSync(resolveWorkspacePath(entry.workspaceRoot, entry.meta.path).abs),
        ),
      );
    } catch (error) {
      if (error instanceof TurnAccessError) throw error;
      return undefined;
    }
  }

  /**
   * 外部修改检测（07 §5）。force=false 时先比文件签名（size/mtime/ino），未变则不读整文件；
   * 读取失败只提示并稍后重试（不暂停，P1-30）；哈希回到检查点时自动解除冲突。
   */
  private async checkExternal(entry: DocEntry, force = false): Promise<void> {
    const { abs } = resolveWorkspacePath(entry.workspaceRoot, entry.meta.path);
    let bytes: Uint8Array;
    let sig: string;
    try {
      sig = fileSig(
        withFileAccessSync(
          {
            kind: "file-metadata",
            path: abs,
            docId: entry.meta.id,
            purpose: "external-change-check",
          },
          () => statSync(abs),
        ),
      );
      if (!force && !entry.readError && sig === entry.fileSig) return;
      bytes = withFileAccessSync(
        {
          kind: "file-bytes",
          path: abs,
          docId: entry.meta.id,
          rev: entry.meta.rev,
          purpose: "external-change-hash",
        },
        () => readFileSync(abs),
      );
    } catch (error) {
      if (error instanceof TurnAccessError) throw error;
      if (!entry.readError) {
        entry.readError = true;
        if (!entry.external) entry.meta.checkpointError = SOURCE_UNREADABLE;
        this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      }
      return;
    }
    entry.fileSig = sig;
    if (entry.readError) {
      entry.readError = false;
      if (entry.meta.checkpointError === SOURCE_UNREADABLE) {
        delete entry.meta.checkpointError;
        this.onCheckpoint?.(entry.meta.id, entry.checkpointRev);
      }
    }
    const hash = sha256(bytes);
    if (hash === entry.checkpointHash) {
      if (entry.external) {
        // 文件被改回最后检查点的内容：冲突自然消失，恢复写回
        this.clearExternal(entry);
        this.onCheckpoint?.(entry.meta.id, entry.checkpointRev);
        if (entry.meta.rev > entry.checkpointRev) this.schedule(entry, 1000);
      }
      return;
    }
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
      const { snapshot } = readCheckpointSnapshot(pending.snapshot);
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
      const changed = entry.external?.hash !== hash;
      entry.external = { hash };
      entry.meta.externalConflict = true;
      entry.meta.checkpointError = EXTERNAL_CONFLICT;
      clearTimeout(entry.timer);
      if (changed)
        this.onCheckpoint?.(entry.meta.id, entry.checkpointRev, entry.meta.checkpointError);
      return;
    }
    await this.reloadExternal(entry, bytes);
  }

  private clearExternal(entry: DocEntry): void {
    delete entry.external;
    delete entry.meta.externalConflict;
    if (entry.meta.checkpointError === EXTERNAL_CONFLICT) delete entry.meta.checkpointError;
  }

  /**
   * 外部修改冲突二选一（07 §5、03 §3.2），在文档 actor 内执行：
   * - keepApp：外部版本先存入备份区 → 应用中的版本写回文件（检查点）→ 记一条外部重新加载修订
   *   （内容未变，写集为空）。写回失败则恢复冲突状态，可改选载入外部版本。
   * - loadExternal：应用中的版本先存入备份区 → 载入外部版本，记外部重新加载修订（写集为全表）。
   */
  async resolveExternal(
    docId: string,
    workspaceRoot: string,
    choice: "keepApp" | "loadExternal",
  ): Promise<{ meta: DocumentMeta; backup: BackupInfo }> {
    const entry = await this.entry(docId, workspaceRoot);
    return this.enqueue(entry, async () => {
      await this.checkExternal(entry, true);
      const ext = entry.external;
      if (!ext)
        throw new FileOperationError("INVALID_ARGUMENT", "该文档当前没有待处理的外部修改冲突");
      const { meta } = entry;
      const scope = {
        workspaceId: meta.workspaceId,
        workspaceRoot: entry.workspaceRoot,
        sessionId: "user",
        agentId: "user",
      };
      const bytes = withFileAccessSync(
        { kind: "file-bytes", path: meta.path, docId: meta.id, purpose: "resolve-external" },
        () => readFileSync(resolveWorkspacePath(entry.workspaceRoot, meta.path).abs),
      );
      if (sha256(bytes) !== ext.hash)
        throw new FileOperationError("VERSION_CONFLICT", "外部文件刚刚又发生变化，请重试");
      if (choice === "loadExternal") {
        const backup = this.backups.storeBytes(scope, meta.path, this.appVersionBytes(entry));
        await this.reloadExternal(entry, bytes);
        return { meta: { ...meta }, backup };
      }
      const backup = this.backups.bind(scope).backup(meta.path);
      const prevHash = entry.checkpointHash;
      entry.checkpointHash = ext.hash;
      this.clearExternal(entry);
      try {
        await this.doCheckpoint(entry);
      } catch (e) {
        entry.checkpointHash = prevHash;
        entry.external = ext;
        meta.externalConflict = true;
        meta.checkpointError = EXTERNAL_CONFLICT;
        this.onCheckpoint?.(meta.id, entry.checkpointRev, meta.checkpointError);
        throw e instanceof FileOperationError
          ? new FileOperationError(e.code, `无法写回应用中的版本：${e.message}`)
          : e;
      }
      this.recordExternalRevision(entry, "keep-app", { ranges: [], structural: [] }, true);
      this.onCheckpoint?.(meta.id, entry.checkpointRev);
      return { meta: { ...meta }, backup };
    });
  }

  /** 应用中的版本（备份用）：优先保真导出；导出被拒时退回只含值与基本格式的新文件。 */
  private appVersionBytes(entry: DocEntry): Uint8Array {
    const snapshot = structuredClone(entry.live.save());
    if (entry.imported.csv) return exportCsv(snapshot, entry.imported.csv);
    try {
      return exportXlsx(
        entry.imported,
        snapshot,
        entry.checkpointSnapshot,
        entry.rebased
          ? undefined
          : pendingChanges(this.opsAfter(entry.meta.id, entry.checkpointRev)),
      );
    } catch (e) {
      // 备份是数据安全边界：无法保留原始部件时必须拒绝操作，禁止静默降级为
      // minimalXlsx（它会丢失公式、样式及扩展部件）。
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        `无法生成应用版本备份，已拒绝外部版本切换：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 外部重新加载修订（07 §5、§7.3）：rev 递增、写回状态与文件对齐，提交后广播
   * （external:* 来源由同步通道转成 doc.reload）。
   */
  private recordExternalRevision(
    entry: DocEntry,
    sourceId: string,
    writeSet: DocWriteSet,
    keepSnapshot: boolean,
    snapshot?: IWorkbookData,
  ): number {
    const rev = entry.meta.rev + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO doc_ops (doc_id, rev, base_rev, source_kind, source_id, session_id, tool_call_id, write_set, mutations, inverse, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.meta.id,
          rev,
          entry.meta.rev,
          "external",
          sourceId,
          null,
          null,
          JSON.stringify(writeSet),
          "[]",
          JSON.stringify(keepSnapshot ? { mutations: [] } : { needsSnapshot: true }),
          nowIso(),
        );
      this.db
        .prepare(
          `UPDATE documents SET rev=?, head_rev=?, checkpoint_rev=?, checkpoint_hash=?${snapshot ? ", checkpoint_snapshot=?" : ""} WHERE id=?`,
        )
        .run(
          rev,
          rev,
          rev,
          entry.checkpointHash,
          ...(snapshot ? [JSON.stringify(snapshot)] : []),
          entry.meta.id,
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    entry.checkpointRev = rev;
    entry.meta.rev = rev;
    entry.meta.checkpointRev = rev;
    this.onRevision?.(entry.meta.id, rev, `external:${sourceId}`, []);
    return rev;
  }

  /**
   * 用备份替换当前文件（07 §7.3），经文档 actor 编排：活文档有未写回修订先检查点
   * （失败则拒绝替换，未写回内容不丢），替换后作为外部重新加载修订进入文档。
   * 文档未登记或文件不存在（回收站还原）时直接替换。
   */
  async replaceFile<T>(
    workspaceId: string,
    workspaceRoot: string,
    path: string,
    replace: () => T,
  ): Promise<T> {
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, path);
    const row = this.db
      .prepare("SELECT id FROM documents WHERE workspace_id = ? AND path = ?")
      .get(workspaceId, rel) as { id: string } | undefined;
    const loaded = row ? await this.docs.get(row.id)?.catch(() => undefined) : undefined;
    const entry =
      loaded ?? (row && existsSync(abs) ? await this.entry(row.id, workspaceRoot) : undefined);
    if (!entry) return replace();
    return this.enqueue(entry, async () => {
      await this.checkExternal(entry, true);
      if (entry.external)
        throw new FileOperationError(
          "VERSION_CONFLICT",
          "该文件有待处理的外部修改冲突，请先选择保留哪个版本",
        );
      if (entry.meta.rev > entry.checkpointRev) await this.doCheckpoint(entry);
      const out = replace();
      await this.checkExternal(entry, true);
      return out;
    });
  }

  private async reloadExternal(entry: DocEntry, bytes: Uint8Array): Promise<void> {
    const imported =
      entry.meta.kind === "csv"
        ? importCsv(bytes, entry.meta.path)
        : importXlsx(bytes, entry.meta.path);
    recordDocumentAccess({
      kind: "package-cache-parse",
      path: entry.meta.path,
      docId: entry.meta.id,
      rev: entry.meta.rev,
      purpose: "decode-external-bytes",
      packageState: "opened-file-bytes",
    });
    const snapshot = imported.snapshot;
    const prevHash = entry.checkpointHash;
    entry.checkpointHash = sha256(bytes);
    try {
      this.recordExternalRevision(
        entry,
        "file",
        { ranges: [{ sheetId: "*", r0: 0, c0: 0, r1: MAX_R, c1: MAX_C }], structural: [] },
        false,
        snapshot,
      );
    } catch (e) {
      entry.checkpointHash = prevHash;
      throw e;
    }
    clearTimeout(entry.timer);
    entry.persistEngineResults = false;
    delete entry.pendingWriteAccess;
    delete entry.writeAccess;
    entry.computedInMemoryOnly = false;
    await this.restore(entry, snapshot);
    entry.imported = imported;
    entry.checkpointSnapshot = structuredClone(entry.live.save());
    entry.formulaCount = Object.values(imported.formulaCounts ?? {}).reduce((s, n) => s + n, 0);
    entry.fileSig = this.statSig(entry);
    this.clearExternal(entry);
    delete entry.meta.checkpointError;
    delete entry.meta.calcPending;
    this.onCheckpoint?.(entry.meta.id, entry.checkpointRev);
  }

  async create(
    workspaceId: string,
    root: string,
    path: string,
    sessionId: string,
    agentId: string,
    sheetName = "Sheet1",
  ): Promise<OpenedDoc> {
    return this.inWorkspace(workspaceId, async () => {
      this.validateCreatePath(root, path);
      const snapshot = this.newWorkbookSnapshot(path, sheetName);
      atomicWrite(root, path, minimalXlsx(snapshot), null);
      this.backups.bind({ workspaceId, workspaceRoot: root, sessionId, agentId }).markCreated(path);
      return this.openUnlocked(workspaceId, root, path);
    });
  }

  /** 用户在文件面板新建空工作簿：只写文件，不登记会话"新建"（不参与代理的新建回滚）。 */
  createEmpty(root: string, path: string): void {
    this.validateCreatePath(root, path);
    atomicWrite(root, path, minimalXlsx(this.newWorkbookSnapshot(path)), null);
  }

  validateCreatePath(root: string, path: string): void {
    const { abs } = resolveWorkspacePath(root, path);
    if (
      withFileAccessSync({ kind: "file-metadata", path: abs, purpose: "create-target" }, () =>
        existsSync(abs),
      )
    )
      throw new FileOperationError("VERSION_CONFLICT", "新工作簿路径已存在");
    if (extname(path).toLowerCase() !== ".xlsx")
      throw new FileOperationError("INVALID_ARGUMENT", "新建工作簿必须使用 .xlsx");
  }

  private newWorkbookSnapshot(path: string, sheetName = "Sheet1"): IWorkbookData {
    return {
      id: newId("wbk"),
      name: path,
      appVersion: ENGINE_VERSION,
      locale: "zh-CN" as never,
      styles: {},
      sheetOrder: ["s0"],
      sheets: { s0: { id: "s0", name: sheetName, rowCount: 1000, columnCount: 26, cellData: {} } },
    };
  }

  async previewCreate(ops: ChangeOp[], workspaceRoot?: string): Promise<ToolResult> {
    const boot = bootUniver();
    try {
      const snapshot = importXlsx(
        minimalXlsx(this.newWorkbookSnapshot("preview.xlsx")),
        "preview.xlsx",
      ).snapshot;
      const book = createBook(boot, snapshot);
      const before = structuredClone(book.workbook.save());
      assertNoExternalFormulaInputs(ops);
      const compiled = compileOps(
        {
          unitId: book.unitId,
          snapshot: book.workbook.save(),
          images: loadImageFiles(ops, workspaceRoot),
        },
        ops,
      );
      assertExternalLinkWrites(before, ops, [], compiled);
      const boundedCells = boundedWriteRanges(compiled.ranges).reduce(
        (sum, r) => sum + (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1),
        0,
      );
      if (boundedCells > MAX_SUBMIT_CELLS)
        throw new FileOperationError(
          "LIMIT_EXCEEDED",
          `单次提交最多 ${MAX_SUBMIT_CELLS} 格，本次约 ${boundedCells} 格`,
        );
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
          created: true,
          sheets: workbookSheets(after),
          changes: summarizeWriteSet(
            {
              ranges: compiled.ranges,
              objects: describeObjectChanges(before, after),
              structural: [
                { sheetId: "s0", kind: "insertSheet", index: 0, count: 0 },
                ...compiled.structural,
              ],
            },
            compiled.sheetNames,
          ),
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
    this.liveEntries.delete(docId);
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
      this.liveEntries.clear();
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

function sameSource(h: DocOpRecord, source: SubmitSource): boolean {
  return h.sourceKind === source.kind && (h.sourceId ?? "") === source.id;
}

/**
 * 冲突判定用的修订写集：行/列插删的"表尾"区域（用户 mutation 路径的写集）换成插删条带，
 * 尾部位移由结构变换承担，读集被平移不算被修改（03 §6.1）。
 */
function conflictRanges(ws: DocWriteSet): RangeRef[] {
  return ws.ranges.map((w) => {
    for (const s of ws.structural) {
      if (w.sheetId !== s.sheetId) continue;
      const rows = s.kind === "insertRows" || s.kind === "deleteRows";
      const cols = s.kind === "insertCols" || s.kind === "deleteCols";
      if (rows && w.r0 === s.index && w.r1 === MAX_R && w.c0 === 0 && w.c1 === MAX_C)
        return { ...w, r1: s.index + s.count - 1 };
      if (cols && w.c0 === s.index && w.c1 === MAX_C && w.r0 === 0 && w.r1 === MAX_R)
        return { ...w, c1: s.index + s.count - 1 };
    }
    return w;
  });
}

function mergeStructural(a: StructuralOp[], b: StructuralOp[]): StructuralOp[] {
  const out = [...a];
  const key = (s: StructuralOp) =>
    s.kind === "insertSheet" || s.kind === "removeSheet" || s.kind === "renameSheet"
      ? `${s.sheetId}|${s.kind}`
      : `${s.sheetId}|${s.kind}|${s.index}|${s.count}`;
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

/** 写入公式单元格的计算值（sheet!A1 → 值），供代理直接看到结果（06 §4.3、ADR 0002）。 */
function readFormulaValues(
  formulas: string[],
  snap: IWorkbookData,
): Record<string, unknown> | undefined {
  if (formulas.length === 0) return undefined;
  const byName = new Map(
    Object.values(snap.sheets ?? {}).map((s) => [(s as IWorksheetData).name, s as IWorksheetData]),
  );
  const out: Record<string, unknown> = {};
  for (const a1 of formulas.slice(0, MAX_FORMULA_VALUES)) {
    try {
      const p = parseRange(a1);
      const sheet = p.sheet !== undefined ? byName.get(p.sheet) : undefined;
      const cell = (
        sheet?.cellData as Record<number, Record<number, { v?: unknown }>> | undefined
      )?.[p.startRow - 1]?.[p.startCol - 1];
      out[a1] = cell?.v ?? null;
    } catch {
      out[a1] = null;
    }
  }
  return out;
}

function mutationWritesFormula(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, item]) =>
        (key === "f" && typeof item === "string" && item.length > 0) || mutationWritesFormula(item),
    )
  );
}

/**
 * 引擎结果 mutation 只带 v/t；在线应用时公式控制器保留 f，但日志回放（fromCollab）会整格覆盖。
 * 落库前把当前快照中的公式补回，保证"重建 = 增量"。
 */
function withFormulas(results: DocMutation[], snap: IWorkbookData): DocMutation[] {
  return results.map((m) => {
    const p = m.params as {
      subUnitId?: string;
      cellValue?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const sheet = snap.sheets?.[p.subUnitId ?? ""] as IWorksheetData | undefined;
    const cd = sheet?.cellData as
      | Record<string, Record<string, { f?: string; si?: string }>>
      | undefined;
    if (!p.cellValue || !cd) return m;
    const cellValue: typeof p.cellValue = {};
    for (const [r, row] of Object.entries(p.cellValue)) {
      cellValue[r] = {};
      for (const [c, cell] of Object.entries(row ?? {})) {
        const cur = cd[r]?.[c];
        (cellValue[r] as Record<string, unknown>)[c] = {
          ...cell,
          ...(cur?.f ? { f: cur.f } : {}),
          ...(cur?.si ? { si: cur.si } : {}),
        };
      }
    }
    return { id: m.id, params: { ...p, cellValue } };
  });
}

function fileSig(st: Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

/** Populate newly readable metadata only from the already hash-matched disk package. */
function hydrateMissingPivotRefresh(imported: ImportedWorkbook, snapshot: IWorkbookData): void {
  const p = imported.preservation;
  if (!p) return;
  const sheets = Object.fromEntries(
    Object.entries(snapshot.sheets).map(([id, sheet]) => [id, { ...sheet }]),
  );
  importPivotRefresh(p.parts, p.sheetParts, sheets);
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const derived = objectsOf(sheets[sid]).pivotRefreshOnLoad;
    if (!derived) continue;
    const objects = objectsOf(sheet);
    sheet.custom = {
      ...sheet.custom,
      excelmanusObjects: {
        ...objects,
        pivotRefreshOnLoad: { ...derived, ...objects.pivotRefreshOnLoad },
      },
    };
  }
}

/** Old durable object logs predate this field; only replay/undo carry their missing keys. */
function carryMissingPivotRefresh(mutation: DocMutation, snapshot: IWorkbookData): DocMutation {
  if (mutation.id !== OBJECT_LAYER_MUTATION) return mutation;
  const parsed = SheetObjectsMutation.safeParse(mutation.params);
  if (!parsed.success) return mutation;
  const { subUnitId, objects } = parsed.data;
  const current = objectsOf(snapshot.sheets[subUnitId]).pivotRefreshOnLoad;
  if (!current) return mutation;
  return {
    ...mutation,
    params: {
      ...parsed.data,
      objects: { ...objects, pivotRefreshOnLoad: { ...current, ...objects.pivotRefreshOnLoad } },
    },
  };
}

/** Only undo may restore an original absent/false lexical value. Public writes only mark true. */
function assertPivotRefreshChanges(
  before: IWorkbookData,
  after: IWorkbookData,
  restore: boolean,
): void {
  if (restore) return;
  for (const sid of new Set([...before.sheetOrder, ...after.sheetOrder])) {
    const a = objectsOf(before.sheets[sid]).pivotRefreshOnLoad ?? {};
    const b = objectsOf(after.sheets[sid]).pivotRefreshOnLoad ?? {};
    for (const cacheId of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (a[cacheId] !== b[cacheId] && b[cacheId] !== "true")
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "仅支持将已有透视缓存标记为打开时刷新；不能清除、删除或改写原始标记",
        );
  }
}

function cellTotal(imported: ImportedWorkbook): number {
  return Object.values(imported.cellCounts ?? {}).reduce((s, n) => s + n, 0);
}

/** 外部文件快照按工作表名改用应用快照的 id，避免外部重排工作表后按位置错配。 */
function rekeyLike(ext: IWorkbookData, app: IWorkbookData): IWorkbookData {
  const sheets: Record<string, IWorksheetData> = {};
  const sheetOrder: string[] = [];
  const extByName = new Map<string, IWorksheetData>();
  for (const id of ext.sheetOrder) {
    const sheet = ext.sheets[id];
    if (sheet?.name !== undefined && !extByName.has(sheet.name)) {
      extByName.set(sheet.name, sheet as IWorksheetData);
    }
  }
  app.sheetOrder.forEach((nid) => {
    const appSheet = app.sheets[nid] as IWorksheetData | undefined;
    const sheet = appSheet?.name === undefined ? undefined : extByName.get(appSheet.name);
    if (!sheet || nid === undefined) return;
    sheets[nid] = { ...sheet, id: nid } as IWorksheetData;
    sheetOrder.push(nid);
  });
  return { ...ext, sheetOrder, sheets };
}

export interface OpenedDoc {
  meta: DocumentMeta;
  imported: ImportedWorkbook;
}

function loadImageFiles(ops: ChangeOp[], root: string | undefined) {
  const images: Record<
    string,
    { data: string; mediaType: "image/png" | "image/jpeg" | "image/gif" }
  > = {};
  for (const op of ops) {
    if (op.op !== "image.add") continue;
    if (!root) throw new FileOperationError("INVALID_ARGUMENT", "图片预览需要工作区");
    const { abs } = resolveWorkspacePath(root, op.path);
    const stat = withFileAccessSync(
      { kind: "file-metadata", path: abs, purpose: "image-source" },
      () => statSync(abs),
    );
    if (!stat.isFile() || stat.size > 10_000_000)
      throw new FileOperationError("LIMIT_EXCEEDED", "图片必须是10MB以内的文件");
    const bytes = withFileAccessSync(
        { kind: "file-bytes", path: abs, purpose: "image-source" },
        () => readFileSync(abs),
      ),
      mediaType = sniffWorkbookImage(bytes);
    if (!mediaType) throw new FileOperationError("INVALID_ARGUMENT", "仅支持 PNG、JPEG、GIF 图片");
    images[op.path] = { data: bytes.toString("base64"), mediaType };
  }
  return images;
}
