import { FileOperationError, PathSafetyError } from "@excelmanus/kernel";
// workbook_edit（06 §4.3）：以类型化 ChangeOp 批量修改工作簿，整批原子提交。
// baseRev = 显式参数 ?? 按读集逐 op 推定 ?? 当前 head；读集 = 运行时记录的所读区域（各带读取修订）。
// 冲突返回 VERSION_CONFLICT + 冲突单元格清单 + 提示「只重读这些区域后再写」。

import type { ToolContext, ToolDefinition } from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import { z } from "zod";
import { WorkbookEditInput as editInput } from "./edit-input.ts";
import { DocNotFoundError, type DocumentService } from "./service.ts";

const err = (code: string, message: string): ToolResult => ({
  status: "error",
  error: { code, message, retryable: false },
});

export function workbookEditTool(svc: DocumentService): ToolDefinition {
  return {
    name: "workbook_edit",
    title: "修改工作簿",
    description:
      '修改工作簿或用 create=true 和新的 .xlsx path 创建工作簿，整批原子提交。新建已含一个空白 Sheet1，ops=[] 即可创建空工作簿，无需 sheet.add、清空单元格或 recalculate；自定义默认表名用 sheet.rename，sheet.add 只新增其他工作表且名称必须唯一。示例：{"create":true,"path":"空工作簿.xlsx","ops":[]}。修改已有文件时 ops 至少一个。ops 支持 sheet.add/rename/delete、cells.set（二维数组，= 开头为公式）、cells.clear、style.set、merge、unmerge、rows/cols.insert/delete、freeze、recalculate（等待公式重算完成）。changes 区分单元格与结构变化，重叠区域只计一次；新建回执含 created 与实际 sheets。calc=computed 时 formulaValues 为写入公式的计算值；calc=pending 表示稍后重算，需要计算值时用 recalculate。baseRev 不传时自动用读集判定；VERSION_CONFLICT → 重读被改单元格后再写。dryRun=true 只预览不落库。',
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
      if (a.create && a.dryRun) {
        try {
          svc.validateCreatePath(ctx.workspaceRoot, a.path as string);
          return svc.previewCreate(a.ops);
        } catch (e) {
          if (e instanceof FileOperationError || e instanceof PathSafetyError)
            return err(e.code, e.message);
          return err("INTERNAL", "新建预览失败");
        }
      }
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
          ...(created ? { created: true } : {}),
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
          const failure = err(result.code, result.message);
          if (a.create && result.message === "工作表名称无效或重复" && failure.error)
            failure.error.hint =
              "新建工作簿已含 Sheet1；空工作簿使用 ops=[]，改默认表名使用 sheet.rename";
          return failure;
        }
        if (created) await svc.checkpoint(doc.id, ctx.workspaceRoot);
        // 提交成功后把写集并入读集（代理读过自己写的）
        if (!result.dryRun) ctx.reads.record(doc.id, result.writeSet.ranges, result.rev);
        return {
          status: "ok",
          docRevs: { [doc.id]: result.rev },
          data: {
            docId: doc.id,
            path: doc.path,
            docRevs: { [doc.id]: result.rev },
            dryRun: result.dryRun,
            changes: result.changes,
            ...(created ? { created: true, sheets: result.sheets } : {}),
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
