import { z } from "zod";

export const FileIntentMeta = z.object({
  workspaceId: z.string(),
  paths: z.record(z.string(), z.string().nullable()),
});
export type FileIntentMeta = z.infer<typeof FileIntentMeta>;

export const BackupInfo = z.object({
  id: z.string(),
  originalPath: z.string(),
  backupPath: z.string(),
  sha256: z.string(),
  size: z.number(),
  createdAt: z.string(),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

export const WriteInput = z.strictObject({
  path: z.string().min(1).describe("工作区相对文本文件路径"),
  content: z.string().describe("完整 UTF-8 文本"),
  expectedVersion: z.string().optional().describe("覆盖时必须提供原文件 sha256"),
});
export const EditInput = z.strictObject({
  path: z.string().min(1),
  expectedVersion: z.string(),
  edits: z
    .array(
      z.strictObject({
        oldText: z.string().min(1),
        newText: z.string(),
        all: z.boolean().optional().describe("是否替换全部匹配，默认只允许唯一匹配"),
      }),
    )
    .min(1),
});
export const FileOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("mkdir"), path: z.string().min(1) }),
  z.strictObject({ op: z.literal("copy"), path: z.string().min(1), to: z.string().min(1) }),
  z.strictObject({ op: z.literal("move"), path: z.string().min(1), to: z.string().min(1) }),
  z.strictObject({ op: z.literal("delete"), path: z.string().min(1) }),
  z.strictObject({
    op: z.literal("backup"),
    path: z.string().optional(),
    list: z.boolean().optional(),
  }),
]);
export const FilesInput = z.strictObject({ ops: z.array(FileOp).min(1).max(100) });
export type FilesInput = z.infer<typeof FilesInput>;

export const WorkbookExportInput = z.strictObject({
  docId: z.string().min(1).optional().describe("源工作簿的已打开文档 id；与 path 至少提供一个"),
  path: z.string().min(1).optional().describe("源工作簿的工作区相对路径；与 docId 至少提供一个，to 不是源路径"),
  mode: z.enum(["convert", "split"]).default("convert"),
  to: z.string().min(1).describe("新文件路径；split 模式为输出目录"),
  format: z.enum(["xlsx", "csv", "tsv"]).default("xlsx").describe("输出格式，省略默认 xlsx；CSV/TSV 必须显式指定"),
  sheet: z.string().optional().describe("CSV/TSV 或 split 模式的工作表名"),
  encoding: z.enum(["utf-8", "utf-8-bom", "gbk"]).optional(),
  rowsPerFile: z.int().positive().optional(),
  column: z.int().nonnegative().optional().describe("按列分组拆分，零起算列号"),
}).refine((a) => Boolean(a.docId || a.path), {path: ["path"], message: "需要源工作簿 path 或 docId；to 仅为输出目标"});
export const AnalyzeSaveTo = z.strictObject({
  path: z.string().optional().describe("新 xlsx 文件路径；省略表示当前文档"),
  sheet: z.string().min(1).describe("新工作表名称"),
});

/** 用户文件管理入口；删除由界面的确认操作显式标记，不能从模型参数推断。 */
export const ManageFilesBody = FilesInput.extend({ confirmed: z.boolean().optional() });
export type ManageFilesBody = z.infer<typeof ManageFilesBody>;
export const ManageFilesResponse = z.object({
  ok: z.literal(true),
  paths: z.array(z.string()),
});
