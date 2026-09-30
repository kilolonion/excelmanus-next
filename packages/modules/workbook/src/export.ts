import { existsSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import {
  atomicWrite,
  FileOperationError,
  PathSafetyError,
  pathVersion,
  resolveWorkspacePath,
  type ToolContext,
  type ToolDefinition,
} from "@excelmanus/kernel";
import { type FileIntentMeta, type ToolResult, WorkbookExportInput } from "@excelmanus/protocol";
import type { ICellData, IWorkbookData } from "@univerjs/core";
import { z } from "zod";
import { exportXlsx, minimalXlsx } from "./checkpoint.ts";
import { exportCsv } from "./csv.ts";
import type { DocumentService } from "./service.ts";

export async function publishNew(
  svc: DocumentService,
  ctx: ToolContext,
  path: string,
  snapshot: IWorkbookData,
): Promise<{ path: string; docId: string; rev: number }> {
  const { abs, rel } = resolveWorkspacePath(ctx.workspaceRoot, path);
  if (existsSync(abs) || extname(rel).toLowerCase() !== ".xlsx")
    throw new FileOperationError("INVALID_ARGUMENT", "saveTo 必须使用不存在的 .xlsx 路径");
  ctx.signal.throwIfAborted();
  atomicWrite(ctx.workspaceRoot, rel, minimalXlsx(snapshot), null);
  ctx.backups.markCreated(rel);
  const { meta } = await svc.open(ctx.workspaceId, ctx.workspaceRoot, rel);
  return { path: rel, docId: meta.id, rev: meta.rev };
}

export function workbookExportTool(svc: DocumentService): ToolDefinition {
  return {
    name: "workbook_export",
    title: "另存工作簿",
    description:
      "从活文档当前修订另存为新的 xlsx/csv/tsv，永不覆盖。mode=convert 使用 to 作为新文件路径；CSV/TSV 指定 sheet，encoding=utf-8/utf-8-bom/gbk。mode=split 使用 to 作为输出目录，指定 rowsPerFile 或零起算 column 按列值分组，保留首行表头；最多 100 个文件。",
    input: WorkbookExportInput,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    replay: "unsafe",
    timeoutMs: 60000,
    roles: ["main", "lead", "worker"],
    targets: (a) => [(a as { to: string }).to],
    intentMeta: (args, ctx): FileIntentMeta => {
      const a = WorkbookExportInput.parse(args);
      return {
        workspaceId: ctx.workspaceId,
        paths: { [a.to]: pathVersion(resolveWorkspacePath(ctx.workspaceRoot, a.to).abs) },
      };
    },
    recover: (info) => svc.recoverFiles(info.intentMeta),
    async execute(args, ctx): Promise<ToolResult> {
      const a = WorkbookExportInput.parse(args);
      const published: string[] = [];
      try {
        const meta = a.docId
          ? (await svc.entry(a.docId, ctx.workspaceRoot)).meta
          : (await svc.open(ctx.workspaceId, ctx.workspaceRoot, a.path ?? "")).meta;
        const { snapshot } = await svc.snapshot(meta.id, ctx.workspaceRoot);
        const entry = await svc.entry(meta.id, ctx.workspaceRoot);
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
          const maxRow = Math.max(0, ...Object.keys(data).map(Number));
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
        for (const p of plans)
          if (existsSync(resolveWorkspacePath(ctx.workspaceRoot, p.path).abs))
            throw new FileOperationError("VERSION_CONFLICT", "导出目标已存在，整批未执行");
        const versions: Record<string, string> = {};
        for (const p of plans) {
          ctx.signal.throwIfAborted();
          const { abs, rel } = resolveWorkspacePath(ctx.workspaceRoot, p.path);
          versions[rel] = atomicWrite(ctx.workspaceRoot, rel, p.bytes, null);
          published.push(abs);
          ctx.backups.markCreated(rel);
        }
        return {
          status: "ok",
          data: { files: Object.keys(versions), sourceRev: meta.rev },
          versions,
          docRevs: { [meta.id]: meta.rev },
          changes: { paths: Object.keys(versions) },
        };
      } catch (e) {
        for (const p of published) rmSync(p, { force: true });
        return {
          status: "error",
          error: {
            code:
              e instanceof FileOperationError || e instanceof PathSafetyError ? e.code : "INTERNAL",
            message:
              e instanceof FileOperationError || e instanceof PathSafetyError
                ? e.message
                : "另存失败，未覆盖原文件",
            retryable: false,
          },
        };
      }
    },
  };
}
