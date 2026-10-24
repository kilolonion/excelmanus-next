// modules/workbook：活文档（xlsx/csv → Univer 无头实例）+ workbook_read/workbook_analyze/workbook_edit。
// 依赖方向：只依赖 kernel 公开接口 / protocol / core；不依赖 modules/files。

import type { BackupService, CapabilityModule, DatabaseSync } from "@excelmanus/kernel";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_PATH_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "./service.ts";
import { workbookTools } from "./tools.ts";

export interface WorkbookModule extends CapabilityModule {
  service: DocumentService;
}

/** 文档服务绑定到 SQLite（documents/doc_ops 表由本模块迁移创建）。 */
export function workbookModule(db: DatabaseSync, backups?: BackupService): WorkbookModule {
  const service = new DocumentService(db, backups);
  return {
    id: "workbook",
    migrations: [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_PATH_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ],
    tools: workbookTools(service),
    service,
  };
}

export { type CompareSheet, compareWorkbooks } from "./compare.ts";
export {
  CsvImportError,
  decodeCsv,
  importCsv,
} from "./csv.ts";
export { WorkbookEditInput, workbookEditOps } from "./edit-input.ts";
export type { DocMutation } from "./engine.ts";
export {
  ChangeOp,
  type CompiledOps,
  compileOps,
  OpCompileError,
} from "./ops.ts";
export { buildLayout, displayText, workbookRenderTool } from "./render.ts";
export {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_PATH_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocNotFoundError,
  type DocOpRecord,
  type DocRevisionInfo,
  type DocumentMeta,
  DocumentService,
  type DocWriteSet,
  type OpenedDoc,
  type SubmitBatch,
  type SubmitResult,
  UnsupportedDocError,
  type UserEdit,
} from "./service.ts";
export {
  boundedWriteRanges,
  sheetNamesOf,
  summarizeWriteSet,
  unionArea,
  type WorkbookChanges,
  workbookSheets,
} from "./summary.ts";
export {
  WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER,
  WORKBOOK_ANALYZE_SQL_TABLE,
} from "./tools.ts";
export { type DerivedWriteSet, deriveWriteSet, deriveWriteSetAll } from "./writeset.ts";
export { type ImportedWorkbook, importXlsx, XlsxImportError } from "./xlsx.ts";

export { importLegacyFile } from "./legacy-import.ts";

export { WorkbookQueryInput, WorkbookQueryJsonSchema, workbookQueryTool } from "./tools.ts";
export { runSourceChecks, type SheetDomain } from "./source-checks.ts";
export { extractSourceCheckDomain, type SourceCheckSnapshot } from "./source-check-domain.ts";
