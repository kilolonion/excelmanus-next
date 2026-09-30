// modules/workbook：只读活文档（xlsx/csv → IWorkbookData 快照）+ workbook_read/workbook_analyze。
// 依赖方向：只依赖 kernel 公开接口 / protocol / core；不依赖 modules/files。

import type { CapabilityModule, DatabaseSync } from "@excelmanus/kernel";
import { DOCUMENTS_MIGRATION, DocumentService } from "./service.ts";
import { workbookTools } from "./tools.ts";

export interface WorkbookModule extends CapabilityModule {
  service: DocumentService;
}

/** 文档服务绑定到 SQLite（documents 表由本模块迁移创建）。 */
export function workbookModule(db: DatabaseSync): WorkbookModule {
  const service = new DocumentService(db);
  return {
    id: "workbook",
    migrations: [DOCUMENTS_MIGRATION],
    tools: workbookTools(service),
    service,
  };
}

export {
  CsvImportError,
  decodeCsv,
  importCsv,
} from "./csv.ts";
export {
  DOCUMENTS_MIGRATION,
  DocNotFoundError,
  type DocumentMeta,
  DocumentService,
  type OpenedDoc,
  UnsupportedDocError,
} from "./service.ts";
export { type ImportedWorkbook, importXlsx, XlsxImportError } from "./xlsx.ts";
