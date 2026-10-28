import { extname, join } from "node:path";
import {
  assertToolReadAccess,
  assertToolWriteAccess,
  atomicWrite,
  effectPathExists,
  FileOperationError,
  PathSafetyError,
  pathVersion,
  prepareEffectPlan,
  recheckEffectPlan,
  resolveWorkspacePath,
  runWithEffectPlan,
  type ToolContext,
  type ToolDefinition,
  TurnAccessError,
} from "@excelmanus/kernel";
import { type FileIntentMeta, type ToolResult, WorkbookExportInput } from "@excelmanus/protocol";
import type { ICellData, IWorkbookData } from "@univerjs/core";
import { z } from "zod";
import { assertUnprotected, exportXlsx, minimalXlsx } from "./checkpoint.ts";
import { exportCsv } from "./csv.ts";
import type { DocumentService } from "./service.ts";

export async function publishNew(
  svc: DocumentService,
  ctx: ToolContext,
  path: string,
  snapshot: IWorkbookData,
): Promise<ToolResult> {
  return svc.publishNewSnapshot(ctx, path, snapshot);
}

export function workbookExportTool(svc: DocumentService): ToolDefinition {
  return {
    name: "workbook_export",
    title: "另存工作簿",
    description:
      "从活文档当前修订另存为新的 xlsx/csv/tsv，永不覆盖。每次必传源 path 或 docId，to 只是输出目标，不会从会话猜测源文件。format 省略默认 xlsx，CSV/TSV 显式指定。mode=convert 使用 to 作为新文件路径；CSV/TSV 指定 sheet，encoding=utf-8/utf-8-bom/gbk。mode=split 使用 to 作为输出目录，指定 rowsPerFile 或零起算 column 按列值分组，保留首行表头与原始单元格类型，忽略末尾只有格式的空行（不丢弃明细之间的空行）；普通按列分组优先用 split，避免脚本重建时丢失空值与类型；最多 100 个文件。回执 exports 返回每个输出的字节数及 CSV/TSV 的实际编码、BOM 标志；文本读取可能自动去掉 BOM，不要据此误判或额外导出临时副本。",
    input: WorkbookExportInput,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    replay: "unsafe",
    timeoutMs: 60000,
    roles: ["main", "lead", "worker"],
    effectIntents: (args) => {
      const a = WorkbookExportInput.parse(args);
      return a.mode === "convert" ? [{ kind: "create", path: a.to }] : [];
    },
    targets: (args, scope) => {
      const a = WorkbookExportInput.parse(args);
      if (scope && a.mode === "convert") assertToolWriteAccess(a.to, scope.workspaceRoot, "create");
      return a.mode === "convert" ? [a.to] : [];
    },
    intentMeta: (args, ctx): FileIntentMeta => {
      const a = WorkbookExportInput.parse(args);
      if (a.mode === "convert") assertToolWriteAccess(a.to, ctx.workspaceRoot, "create");
      return { workspaceId: ctx.workspaceId, paths: a.mode === "convert" ? { [a.to]: null } : {} };
    },
    recover: (info) => svc.recoverFiles(info.intentMeta),
    async execute(args, ctx): Promise<ToolResult> {
      const a = WorkbookExportInput.parse(args);
      const published: string[] = [];
      try {
        const source = a.docId ? svc.meta(a.docId)?.path : a.path;
        if (!source) throw new FileOperationError("INVALID_ARGUMENT", "缺少来源文件");
        assertToolReadAccess(source, "file-metadata", ctx.workspaceRoot);
        assertToolReadAccess(source, "file-bytes", ctx.workspaceRoot);
        if (a.mode === "convert") assertToolWriteAccess(a.to, ctx.workspaceRoot, "create");
        svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, a);
        const meta = a.docId
          ? (await svc.entry(a.docId, ctx.workspaceRoot)).meta
          : (await svc.open(ctx.workspaceId, ctx.workspaceRoot, a.path ?? "")).meta;
        const { snapshot } = await svc.snapshot(meta.id, ctx.workspaceRoot);
        const entry = await svc.entry(meta.id, ctx.workspaceRoot);
        assertUnprotected(entry.imported);
        const plans: Array<{ path: string; bytes: Uint8Array }> = [];
        const encode = (snap: IWorkbookData, original: boolean): Uint8Array =>
          a.format === "xlsx"
            ? original
              ? exportXlsx(entry.imported, snap, entry.checkpointSnapshot)
              : minimalXlsx(snap)
            : exportCsv(snap, {
                sheet: a.sheet,
                delimiter: a.format === "tsv" ? "\t" : ",",
                encoding: a.encoding,
              });
        if (a.mode === "convert") {
          if (a.format === "xlsx" && entry.imported.unsupported.macros)
            throw new FileOperationError(
              "UNSUPPORTED_FEATURE",
              "宏文件不能另存为 .xlsx；原文件检查点会保留宏",
            );
          if (extname(a.to).toLowerCase() !== `.${a.format}`)
            throw new FileOperationError("INVALID_ARGUMENT", "to 扩展名必须与 format 相同");
          plans.push({ path: a.to, bytes: encode(snapshot, true) });
        } else {
          if (Object.keys(entry.imported.unsupported).length)
            throw new FileOperationError(
              "UNSUPPORTED_FEATURE",
              "含对象的工作簿尚不能安全拆分，请先另存所需值区域",
            );
          if ((a.rowsPerFile === undefined) === (a.column === undefined))
            throw new FileOperationError(
              "INVALID_ARGUMENT",
              "split 必须提供 rowsPerFile 或 column 之一",
            );
          const sheet = a.sheet
            ? Object.values(snapshot.sheets).find((s) => s.name === a.sheet || s.id === a.sheet)
            : snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
          if (!sheet) throw new FileOperationError("NOT_FOUND", "工作表不存在");
          const data = (sheet.cellData as Record<number, Record<number, ICellData>>) ?? {};
          const maxRow = Object.entries(data).reduce(
            (last, [row, cells]) =>
              Object.values(cells).some(
                (cell) =>
                  cell &&
                  (cell.f || cell.si || (cell.v !== null && cell.v !== undefined && cell.v !== "")),
              )
                ? Math.max(last, Number(row))
                : last,
            0,
          );
          const groups = new Map<string, number[]>();
          for (let r = 1; r <= maxRow; r++) {
            const key =
              a.column !== undefined
                ? JSON.stringify(data[r]?.[a.column]?.v ?? null)
                : String(Math.floor((r - 1) / (a.rowsPerFile as number)));
            const rows = groups.get(key) ?? [];
            rows.push(r);
            groups.set(key, rows);
            if (groups.size > 100)
              throw new FileOperationError("LIMIT_EXCEEDED", "最多拆分 100 个文件");
          }
          let n = 0;
          for (const rows of groups.values()) {
            const cells: Record<number, Record<number, ICellData>> = {
              0: structuredClone(data[0] ?? {}),
            };
            rows.forEach((r, i) => {
              cells[i + 1] = structuredClone(data[r] ?? {});
              for (const cell of Object.values(cells[i + 1] ?? {})) {
                if (cell.f)
                  throw new FileOperationError(
                    "UNSUPPORTED_FEATURE",
                    "拆分含公式区域会改变引用，请先复制为值",
                  );
              }
            });
            const snap: IWorkbookData = {
              ...snapshot,
              sheetOrder: [sheet.id ?? "s0"],
              sheets: {
                [sheet.id ?? "s0"]: {
                  ...sheet,
                  cellData: cells,
                  rowCount: rows.length + 1,
                  mergeData: [],
                  rowData: {},
                  freeze: undefined,
                },
              },
            };
            plans.push({
              path: join(a.to, `part-${String(++n).padStart(3, "0")}.${a.format}`),
              bytes: encode(snap, false),
            });
          }
          if (!plans.length) throw new FileOperationError("INVALID_ARGUMENT", "没有可拆分的数据行");
        }
        const permit = prepareEffectPlan({
          workspaceRoot: ctx.workspaceRoot,
          atomicScope: plans.length === 1 ? "single-resource" : "none",
          signal: ctx.signal,
          effects: [
            { operation: "read-metadata", path: source },
            { operation: "read-content", path: source },
            ...plans.map((p) => ({ operation: "create" as const, path: p.path })),
          ],
        });
        return runWithEffectPlan(permit, () => {
          for (const p of plans)
            if (effectPathExists(p.path, ctx.workspaceRoot))
              throw new FileOperationError("VERSION_CONFLICT", "导出目标已存在，整批未执行");
          const versions: Record<string, string> = {};
          for (const p of plans) {
            recheckEffectPlan(permit);
            const { rel } = resolveWorkspacePath(ctx.workspaceRoot, p.path);
            versions[rel] = atomicWrite(ctx.workspaceRoot, rel, p.bytes, null);
            published.push(rel);
            ctx.backups.markCreated(rel, { sha256: versions[rel]!, size: p.bytes.length });
          }
          recheckEffectPlan(permit);
          return {
            status: "ok",
            data: {
              files: Object.keys(versions),
              sourceRev: meta.rev,
              exports: plans.map((p) => ({
                path: p.path,
                format: a.format,
                sizeBytes: p.bytes.length,
                ...(a.format === "xlsx"
                  ? {}
                  : {
                      encoding: a.encoding ?? "utf-8",
                      bom: p.bytes[0] === 0xef && p.bytes[1] === 0xbb && p.bytes[2] === 0xbf,
                    }),
              })),
            },
            versions,
            docRevs: { [meta.id]: meta.rev },
            changes: { paths: Object.keys(versions) },
          };
        });
      } catch (e) {
        // This adapter does not claim batch atomicity. Never borrow fresh remove permission
        // to conceal a partial publication after authority changes.
        return {
          status: published.length ? "partial" : "error",
          ...(published.length
            ? { data: { published, publication: "partial", rollback: "not_attempted" } }
            : {}),
          error: {
            code:
              e instanceof FileOperationError ||
              e instanceof PathSafetyError ||
              e instanceof TurnAccessError
                ? e.code
                : "INTERNAL",
            message:
              e instanceof FileOperationError ||
              e instanceof PathSafetyError ||
              e instanceof TurnAccessError
                ? `${e.message}${published.length ? "；部分目标已发布，未自动删除，请核对published清单" : ""}`
                : "另存失败，未覆盖原文件",
            retryable: false,
          },
        };
      }
    },
  };
}
