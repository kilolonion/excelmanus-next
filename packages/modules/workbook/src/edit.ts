import { rangeRefToA1 } from "@excelmanus/core";
import { FileOperationError, PathSafetyError } from "@excelmanus/kernel";
// workbook_edit（06 §4.3）：以类型化 ChangeOp 批量修改工作簿，整批原子提交。
// baseRev = 显式参数 ?? 按读集逐 op 推定 ?? 当前 head；读集 = 运行时记录的所读区域（各带读取修订）。
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
    ranges: result.writeSet.ranges
      .filter((r) => r.sheetId !== "*")
      .map((r) => rangeRefToA1(r, sheetNames.get(r.sheetId) ?? r.sheetId)),
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
      "修改工作簿或用 create=true 和新 .xlsx path 创建工作簿（默认表 Sheet1）：ops 为类型化操作数组（sheet.add/rename/delete、cells.set（二维数组，= 开头为公式）、cells.clear、style.set、merge、unmerge、rows/cols.insert/delete、freeze、recalculate（等待公式重算完成）），整批原子提交。结果 calc=computed 时 formulaValues 为写入公式的计算值；calc=pending 表示大表重算稍后以新修订到达，需要结果时提交 [{op:'recalculate'}]。baseRev 不传时自动用读集判定；冲突返回 VERSION_CONFLICT 与被改单元格，重读后再写。dryRun=true 只预览不落库。",
    input: editInput,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    // 11 §3.4：写入期间界面显示代理正在改的区域（不入日志）；dryRun 不算写入
    activity: (a: z.infer<typeof editInput>) =>
      a.dryRun || (!a.docId && !a.path)
        ? null
        : {
            kind: "write",
            ...(a.docId ? { docId: a.docId } : {}),
            ...(a.path ? { path: a.path } : {}),
            ranges: a.ops.flatMap((op) =>
              "range" in op && typeof op.range === "string"
                ? [
                    "sheet" in op && typeof op.sheet === "string" && !op.range.includes("!")
                      ? `${op.sheet}!${op.range}`
                      : op.range,
                  ]
                : [],
            ),
          },
    targets: (a) => {
      // 租约目标必须解析出路径（M4）：docId 调用经 svc.meta 还原 path，避免绕过租约。
      const q = a as { path?: unknown; docId?: unknown };
      const path =
        typeof q.path === "string"
          ? q.path
          : typeof q.docId === "string"
            ? svc.meta(q.docId)?.path
            : undefined;
      return path !== undefined ? [path] : [];
    },
    replay: "unsafe",
    timeoutMs: 60_000,
    roles: ["main", "lead", "worker"],
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
      if (a.create && (!a.path || a.docId))
        return err("INVALID_ARGUMENT", "create=true 需要新的 path，不能提供 docId");
      if (a.create && a.dryRun) return svc.previewCreate(a.ops);
      try {
        const created = a.create
          ? await svc.create(
              ctx.workspaceId,
              ctx.workspaceRoot,
              a.path as string,
              ctx.sessionId,
              ctx.agentId,
            )
          : undefined;
        const doc = created
          ? created.meta
          : a.docId
            ? await svc.entry(a.docId, ctx.workspaceRoot).then((e) => e.meta)
            : (await svc.open(ctx.workspaceId, ctx.workspaceRoot, a.path ?? "")).meta;
        // 读集按区域带各自读取修订；未显式给 baseRev 时，每个 op 的坐标系由文档服务
        // 按覆盖其目标的最近读取修订推定（perOpBase），读集外目标退回最近读取修订
        const recorded = ctx.reads.get(doc.id);
        const head = svc.headRev(doc.id);
        const baseRev = a.baseRev ?? recorded?.maxRev ?? head;
        const readSet = recorded?.ranges ?? [];
        const result = await svc.submit(doc.id, ctx.workspaceRoot, {
          baseRev,
          readSet,
          ...(a.baseRev === undefined && recorded ? { perOpBase: true } : {}),
          source: { kind: "agent", id: `${ctx.sessionId}/${ctx.agentId}` },
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          ops: a.ops,
          dryRun: a.dryRun,
        });
        if (!result.ok) {
          if (created) await svc.discardCreated(doc.id, ctx.workspaceRoot, ctx.sessionId);
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
        if (created) await svc.checkpoint(doc.id, ctx.workspaceRoot);
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
          docRevs: { [doc.id]: result.rev },
          data: {
            docId: doc.id,
            path: doc.path,
            docRevs: { [doc.id]: result.rev },
            dryRun: result.dryRun,
            changes: summarize(result, sheetNames),
            formulas: result.formulas,
            // ADR 0002：公式计算状态与计算值；pending 时可用 recalculate op 等待
            calc: result.calc,
            ...(result.formulaValues ? { formulaValues: result.formulaValues } : {}),
            ...(result.backupPath ? { backupPath: result.backupPath } : {}),
            ...(result.preview !== undefined ? { preview: result.preview } : {}),
          },
        };
      } catch (e) {
        if (e instanceof DocNotFoundError) return err("DOC_NOT_FOUND", e.message);
        if (e instanceof FileOperationError || e instanceof PathSafetyError)
          return err(e.code, e.message);
        return err("INTERNAL", "工作簿修改失败");
      }
    },
  };
}
