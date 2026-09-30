// workbook_edit（06 §4.3）：以类型化 ChangeOp 批量修改工作簿，整批原子提交。
// baseRev = 显式参数 ?? 本代理读集 minRev ?? 当前 head；读集 = 运行时记录的所读区域。
// 冲突返回 VERSION_CONFLICT + 冲突单元格清单 + 提示「只重读这些区域后再写」。

import type { ToolContext, ToolDefinition } from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import type { IWorksheetData } from "@univerjs/core";
import { z } from "zod";
import { ChangeOp } from "./ops.ts";
import { DocNotFoundError, type DocumentService, type SubmitOk } from "./service.ts";

const editInput = z.object({
  docId: z.string().optional(),
  path: z.string().optional(),
  baseRev: z.number().int().nonnegative().optional(),
  dryRun: z.boolean().optional(),
  /** M2a 不支持：新建文件在 M2b。 */
  create: z.boolean().optional(),
  ops: z.array(ChangeOp).min(1),
});

const err = (code: string, message: string): ToolResult => ({
  status: "error",
  error: { code, message, retryable: false },
});

function summarize(result: SubmitOk, sheetNames: Map<string, string>): Record<string, unknown> {
  const cellsBySheet: Record<string, number> = {};
  for (const r of result.writeSet.ranges) {
    if (r.sheetId === "*") continue;
    const area = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
    const name = sheetNames.get(r.sheetId) ?? r.sheetId;
    cellsBySheet[name] = (cellsBySheet[name] ?? 0) + area;
  }
  return {
    cellsBySheet,
    structural: result.writeSet.structural.map(
      (s) => `${s.kind}@${sheetNames.get(s.sheetId) ?? s.sheetId}:${s.index}+${s.count}`,
    ),
  };
}

export function workbookEditTool(svc: DocumentService): ToolDefinition {
  return {
    name: "workbook_edit",
    title: "修改工作簿",
    description:
      "修改已打开的工作簿：ops 为类型化操作数组（sheet.add/rename/delete、cells.set（二维数组，= 开头为公式）、cells.clear、style.set、merge、unmerge、rows/cols.insert/delete、freeze），整批原子提交。baseRev 不传时自动用读集判定；冲突返回 VERSION_CONFLICT 与被改单元格，重读后再写。dryRun=true 只预览不落库。",
    input: editInput,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    targets: (a) =>
      typeof (a as { path?: unknown }).path === "string" ? [(a as { path: string }).path] : [],
    replay: "unsafe",
    timeoutMs: 60_000,
    roles: ["main"],
    recover: (info) => {
      const hit = svc.committedByToolCall(info.toolCallId);
      if (!hit) return undefined;
      return {
        status: "ok",
        data: {
          docId: hit.docId,
          rev: hit.rev,
          docRevs: { [hit.docId]: hit.rev },
          alreadyCommitted: true,
        },
      };
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const a = editInput.parse(args);
      if (a.create === true) {
        return err("UNSUPPORTED_FEATURE", "M2a 不支持新建工作簿文件（create），留待 M2b");
      }
      try {
        const doc = a.docId
          ? await svc.entry(a.docId, ctx.workspaceRoot).then((e) => e.meta)
          : (await svc.open(ctx.workspaceId, ctx.workspaceRoot, a.path ?? "")).meta;
        const recorded = ctx.reads.get(doc.id);
        const head = svc.headRev(doc.id);
        const baseRev = a.baseRev ?? recorded?.minRev ?? head;
        const readSet = recorded?.ranges ?? [];
        const result = await svc.submit(doc.id, ctx.workspaceRoot, {
          baseRev,
          readSet,
          source: { kind: "agent", id: `${ctx.sessionId}/${ctx.agentId}` },
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          ops: a.ops,
          dryRun: a.dryRun,
        });
        if (!result.ok) {
          if (result.code === "VERSION_CONFLICT") {
            return {
              status: "error",
              data: { docId: doc.id, conflicts: result.conflicts ?? [] },
              error: {
                code: "VERSION_CONFLICT",
                message: result.message,
                hint: "只重读这些区域后再写",
                retryable: false,
              },
            };
          }
          return err(result.code, result.message);
        }
        // 提交成功后把写集并入读集（代理读过自己写的）
        if (!result.dryRun) ctx.reads.record(doc.id, result.writeSet.ranges, result.rev);
        const { snapshot } = await svc.snapshot(doc.id, ctx.workspaceRoot);
        const sheetNames = new Map(
          Object.entries(snapshot.sheets ?? {}).map(([id, s]) => [
            id,
            (s as IWorksheetData).name ?? id,
          ]),
        );
        return {
          status: "ok",
          data: {
            docId: doc.id,
            path: doc.path,
            docRevs: { [doc.id]: result.rev },
            dryRun: result.dryRun,
            changes: summarize(result, sheetNames),
            formulas: result.formulas,
            ...(result.preview !== undefined ? { preview: result.preview } : {}),
          },
        };
      } catch (e) {
        if (e instanceof DocNotFoundError) return err("DOC_NOT_FOUND", e.message);
        return err("EDIT_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
