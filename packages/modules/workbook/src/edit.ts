import {
  assertToolAccess,
  assertToolEffectsAllowed,
  assertToolWriteAccess,
  FileOperationError,
  PathSafetyError,
  TurnAccessError,
} from "@excelmanus/kernel";
// workbook_edit（06 §4.3）：以类型化 ChangeOp 批量修改工作簿，整批原子提交。
// baseRev = 显式参数 ?? 按读集逐 op 推定 ?? 当前 head；读集 = 运行时记录的所读区域（各带读取修订）。
// 冲突返回 VERSION_CONFLICT + 冲突单元格清单 + 提示「只重读这些区域后再写」。

import type { ToolContext, ToolDefinition } from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import { z } from "zod";
import {
  WorkbookEditInput as editInput,
  WorkbookEditJsonSchema,
  workbookEditOps,
} from "./edit-input.ts";
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
      "宏工作簿先读 objects/overview 的 macroEvidence；仅明确无签名、类型与关系支持的普通字面值 cells.set 可编辑，不支持公式目标、公式输入或结构/格式等其他操作，混合不支持操作整批写前拒绝。保存前比较实际候选的 VBA 字节、关系、内容类型和 codeName，保存后仍须重读当前检查点核验；当前 hash 不保证未来输出。无法取得充分静态证据时停止并说明，不执行宏、不验证宏运行结果。现有外部公式及保存缓存只保留，不支持新增、改写、覆盖、清除、移动或重算；触及这些内容时整批在写入前拒绝，普通不相关单元格可编辑；含外部定义名或外部数组公式的工作簿暂仅支持读取。外部目标不会自动访问。创建或修改工作簿的数据、公式、格式与对象。pivot.mark_refresh_on_load 仅对已有本地 worksheet+矩形 ref 缓存设置 refreshOnLoad=true，参数 sheet 是源表、cacheId 取 workbook_read mode=objects 的 workbook cacheId。共享缓存会影响所有关联透视表；不会立即刷新、改写 cacheRecords/透视显示值或新增切片器交互；不支持外部、OLAP、命名源、歧义源、改源定义、清除标记或与源结构变化同批操作。每次调用必传工作区相对 path 或已读回的 docId，不能仅传 ops。print.set 修改指定 sheet 的打印区域、重复标题行、手动行列分页、纸张/方向/fit 和 oddHeader/oddFooter；字段省略保留，null 清除指定字段；repeatRows 使用 1:3 保留已有重复列，afterRows/afterColumns 使用1基行/列之后的位置并全量替换手动分页；fit 非 null 启用 fitToPage，动态页眉页脚 token 原样保留。用 workbook_read mode=print 核验当前修订。保留内置名 _xlnm.Print_Area/Print_Titles 必须使用 print.set，不能用 name.set。name.set 创建或更新命名区域（name、带表名的 range，可选 scope）；下拉来源可用 dv.add 的 formula1=名称，名称可从 workbook_read overview 的 definedNames 核对；条件格式和验证用 facets:['rules'] 读回。xlsx 是 ZIP 二进制，不能用 files.readText/read 的文本内容核验 XML。table.add 创建 Excel 表对象，columns 提供列名和可选首行计算列公式；table.column_formula 修改已有表的计算列并填充数据行。filter.set 的 values 是精确枚举，数值阈值用 condition（如 greaterThanOrEqual, value:300）；筛选自动隐藏不匹配行，不要再用 axis.hide 模拟筛选，移除筛选用 clear:true。image.add 从工作区 PNG/JPEG/GIF 插图，image.update 只改位置/尺寸/偏移，不重建原图片；shape.add/update/delete 只支持平面 rect/ellipse/rightArrow，shape.update 仅移动/缩放/偏移，原文字样式不改，不能用图片冒充形状。对象 ID 先从 workbook_read mode=objects 读取；未知复杂绘图只保留，不能编辑。anchor 为单格地址，offsetX/offsetY 为非负像素偏移；更新 anchor 时未指定的偏移归零，仅改尺寸则保留原偏移。axis.group 只改分组层级；axis.hide 只改隐藏状态；axis.collapse 只改指定汇总行/列的 collapsed 标记，不推断整组、不暗中改 hidden 或 level。完整展开需同批将成员行/列 axis.hide hidden=false，并将对应汇总行/列 axis.collapse collapsed=false；用 workbook_read 的 layout 回读核验。操作类型及字段见 ops schema；一次调用针对一个工作簿，整批原子提交，不保证跨调用或跨文件原子性。create=true 需要新的 .xlsx path，不覆盖已有文件；sheetNames 在 ops 执行前已按指定名称建表，不再额外创建 Sheet1，无需再从 Sheet1 重命名；省略时只有空白 Sheet1，ops=[] 可创建空工作簿。sheet.add 不切换后续操作的默认表，跨表操作必须明确表名。基于已读内容写入，baseRev 省略时用读集判定；VERSION_CONFLICT 应重读受影响区域后决定。dryRun=true 只预览不落库。回执 changes 区分单元格与结构变化；calc=computed 时 formulaValues 为计算值，calc=pending 时尚未完成计算，需要计算值可用 recalculate。复杂条件计算与批处理可选 run_script，查询/核验可选 workbook_analyze；按任务选择，不要求固定顺序。",
    input: editInput,
    inputJsonSchema: WorkbookEditJsonSchema,
    output: z.record(z.string(), z.unknown()),
    effect: "write",
    effectIntents: (args, scope) => {
      const a = editInput.parse(args);
      const path = a.docId ? svc.meta(a.docId)?.path : a.path;
      if (!path) return [];
      return a.create ? [{ kind: "create", path }] : scope
        ? svc.editEffectIntents(path, scope.workspaceRoot, workbookEditOps(a))
        : [{ kind: "mutate", path }];
    },
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
    targets: (args, scope) => {
      const a = editInput.parse(args);
      if (!scope) {
        // Legacy direct callers have no scope; runtime always supplies it.
        const path = a.docId ? svc.meta(a.docId)?.path : a.path;
        return path === undefined ? [] : [path];
      }
      for (const op of workbookEditOps(a))
        if (op.op === "image.add") assertToolAccess(op.path, scope.workspaceRoot);
      const path = a.create
        ? assertToolWriteAccess(a.path as string, scope.workspaceRoot, "create")
        : svc.editTarget(scope.workspaceId, scope.workspaceRoot, a);
      return [path];
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
      const ops = workbookEditOps(a);
      if (a.create) return svc.createWithOps(ctx, a.path as string, ops, a.dryRun);
      try {
        const target = a.docId ? svc.meta(a.docId)?.path : a.path;
        if (target) assertToolEffectsAllowed(svc.editEffectIntents(target, ctx.workspaceRoot, ops), ctx.workspaceRoot);
        svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, a);
        for (const op of ops)
          if (op.op === "image.add") assertToolAccess(op.path, ctx.workspaceRoot);
      } catch (e) {
        if (
          e instanceof FileOperationError ||
          e instanceof PathSafetyError ||
          e instanceof TurnAccessError
        )
          return err(e.code, e.message);
        throw e;
      }
      if (a.create && a.dryRun) {
        try {
          svc.validateCreatePath(ctx.workspaceRoot, a.path as string);
          return svc.previewCreate(ops, ctx.workspaceRoot);
        } catch (e) {
          if (
            e instanceof FileOperationError ||
            e instanceof PathSafetyError ||
            e instanceof TurnAccessError
          )
            return err(e.code, e.message);
          return err("INTERNAL", "新建预览失败");
        }
      }
      try {
        const path = svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, a);
        if (
          ctx.toolTargets !== undefined &&
          (ctx.toolTargets.length !== 1 || ctx.toolTargets[0] !== path)
        )
          return err(
            "INVALID_ARGUMENT",
            "工作簿目标与已检查的租约路径不一致，本次修改未执行；请重新读取目标",
          );
        if (!a.create)
          svc.assertMacroReadOpen(ctx.workspaceId, ctx.workspaceRoot, { docId: a.docId, path });
        const created = a.create
          ? await svc.create(ctx.workspaceId, ctx.workspaceRoot, path, ctx.sessionId, ctx.agentId)
          : undefined;
        const doc = created
          ? created.meta
          : a.docId
            ? await svc.entry(a.docId, ctx.workspaceRoot).then((e) => e.meta)
            : (await svc.open(ctx.workspaceId, ctx.workspaceRoot, path)).meta;
        // 读集按区域带各自读取修订；未显式给 baseRev 时，每个 op 的坐标系由文档服务
        // 按覆盖其目标的最近读取修订推定（perOpBase），读集外目标退回最近读取修订
        const recorded = ctx.reads.get(doc.id);
        const head = svc.headRev(doc.id);
        const baseRev = a.baseRev ?? recorded?.maxRev ?? head;
        const readSet = recorded?.ranges ?? [];
        const result = await svc.submit(doc.id, ctx.workspaceRoot, {
          baseRev,
          expectedPath: path,
          readSet,
          ...(a.baseRev === undefined && recorded ? { perOpBase: true } : {}),
          source: { kind: "agent", id: `${ctx.sessionId}/${ctx.agentId}` },
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          ops,
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
          if (
            a.create &&
            a.sheetNames &&
            result.message.startsWith("工作表不存在：") &&
            failure.error
          )
            failure.error.hint = `本次新建已回滚，文件未创建。sheetNames 已在 ops 前创建 ${JSON.stringify(a.sheetNames)}，不会额外保留 Sheet1；请删除针对不存在的默认表的重复重命名，后续操作直接引用实际表名。`;

          if (
            a.create &&
            !a.sheetNames &&
            result.message === "工作表名称无效或重复" &&
            failure.error
          )
            failure.error.hint =
              "新建工作簿已含 Sheet1；空工作簿使用 ops=[]，改默认表名使用 sheet.rename";
          if (
            a.create &&
            !a.sheetNames &&
            failure.error &&
            (result.message === "不能删除最后一个工作表" ||
              result.message.startsWith("工作表不存在："))
          ) {
            const missing = result.message.startsWith("工作表不存在：")
              ? result.message.slice("工作表不存在：".length)
              : null;
            failure.error.hint =
              "本次新建已回滚，文件未创建。省略 sheetNames 时初始只有 Sheet1。" +
              (missing
                ? `要直接创建目标表，可传 sheetNames: ${JSON.stringify([missing])}；有多个目标表时将名称一并列出。`
                : "不能删除最后一个工作表；可用 sheetNames 指定新建表名，或用 sheet.rename 改名。") +
              "也可先用 sheet.rename 改默认表名、sheet.add 新增其他表。跨表操作的 range 必须明确表名；sheet.add 不会切换后续操作的默认表。";
          }
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
        if (
          e instanceof FileOperationError ||
          e instanceof PathSafetyError ||
          e instanceof TurnAccessError
        )
          return err(e.code, e.message);
        return err("INTERNAL", "工作簿修改失败");
      }
    },
  };
}
