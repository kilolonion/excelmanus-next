// modules/workbook：活文档（xlsx/csv → Univer 无头实例）+ workbook_read/workbook_analyze/workbook_edit。
// 依赖方向：只依赖 kernel 公开接口 / protocol / core；不依赖 modules/files。

import type { CapabilityModule, DatabaseSync } from "@excelmanus/kernel";
import { DOC_OPS_MIGRATION, DOCUMENTS_MIGRATION, DocumentService } from "./service.ts";
import { workbookTools } from "./tools.ts";

export interface WorkbookModule extends CapabilityModule {
  service: DocumentService;
}

/** 文档服务绑定到 SQLite（documents/doc_ops 表由本模块迁移创建）。 */
export function workbookModule(db: DatabaseSync): WorkbookModule {
  const service = new DocumentService(db);
  return {
    id: "workbook",
    migrations: [DOCUMENTS_MIGRATION, DOC_OPS_MIGRATION],
    tools: workbookTools(service),
    service,
  };
}

export {
  CsvImportError,
  decodeCsv,
  importCsv,
} from "./csv.ts";
export type { DocMutation } from "./engine.ts";
export {
  ChangeOp,
  type CompiledOps,
  compileOps,
  OpCompileError,
} from "./ops.ts";
export {
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocNotFoundError,
  type DocOpRecord,
  type DocumentMeta,
  DocumentService,
  type DocWriteSet,
  type OpenedDoc,
  type SubmitBatch,
  type SubmitResult,
  UnsupportedDocError,
} from "./service.ts";
export { type DerivedWriteSet, deriveWriteSet, deriveWriteSetAll } from "./writeset.ts";
export { type ImportedWorkbook, importXlsx, XlsxImportError } from "./xlsx.ts";
