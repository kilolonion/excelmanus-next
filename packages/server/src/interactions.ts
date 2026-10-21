import type { QuestionCoordinator, SessionLog, ToolDefinition } from "@excelmanus/kernel";
import { PresentPayload, type ToolResult } from "@excelmanus/protocol";
import type { DocumentService } from "@excelmanus/workbook";
import { z } from "zod";
import { finalizeNumeric, numericFinalization, presentVerifiedFile } from "./numeric-finalizer.ts";

const output = z.record(z.string(), z.unknown());
const ok = (data: unknown): ToolResult => ({ status: "ok", data });

const askInput = z.strictObject({
  type: z.enum(["choice", "text", "range_confirm", "range_pick", "change_confirm"]),
  spec: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().positive().max(86_400).optional(),
});
const presentExample = '{"payload":{"kind":"file","path":"报告.xlsx"}}';
const payloadSchema = z.strictObject({
  payload: PresentPayload.describe(
    `必须嵌套在 payload 内，不把 kind/path/range 放到根节点。例：${presentExample}`,
  ),
});
const payloadInput = z.strictObject({
  payload: z.preprocess((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({ code: "custom", message: `缺少 payload；调用格式：${presentExample}` });
      return z.NEVER;
    }
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, PresentPayload),
});
const finalizationSchema = z.strictObject({ finalize: numericFinalization });
const finalizationInput = z.strictObject({
  finalize: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, numericFinalization),
});
const presentSchema = z.union([payloadSchema, finalizationSchema]);
const presentInput = z.union([payloadInput, finalizationInput], {
  error: `请使用 payload 或 finalize 独立分支；文件调用格式：${presentExample}`,
});
const todoExamples =
  'set 只传 op 和 items：{"op":"set","items":[{"id":"1","title":"核验","status":"pending"}]}；update 只传 op、todoId 和要改的 status/result：{"op":"update","todoId":"1","status":"done"}。不要混用两种操作的字段。';
const todoObjectError: z.core.$ZodErrorMap = (issue) =>
  issue.code === "unrecognized_keys"
    ? `多余字段：${issue.keys.join(", ")}。${todoExamples}`
    : undefined;
const todoSchema = z.discriminatedUnion("op", [
  z.strictObject(
    {
      op: z.literal("set"),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          '待办对象数组，每项用稳定 id、title 和 status（pending/in_progress/done）。例：[{"id":"1","title":"核验","status":"pending"}]。不是 JSON 字符串。',
        ),
    },
    { error: todoObjectError },
  ),
  z.strictObject(
    {
      op: z.literal("update"),
      todoId: z.string().describe("set 时对应条目的 id；不是标题，也不重复传 items"),
      status: z.string().optional().describe("pending、in_progress 或 done"),
      result: z.unknown().optional(),
    },
    { error: todoObjectError },
  ),
]);

const todoInput = z.preprocess((value) => {
  if (
    !value ||
    typeof value !== "object" ||
    !("op" in value) ||
    value.op !== "set" ||
    !("items" in value) ||
    typeof value.items !== "string"
  )
    return value;
  try {
    return { ...value, items: JSON.parse(value.items) };
  } catch {
    return value;
  }
}, todoSchema);

export function interactionTools(
  log: SessionLog,
  questions: QuestionCoordinator,
  documents?: DocumentService,
): ToolDefinition[] {
  const ask: ToolDefinition<z.infer<typeof askInput>> = {
    name: "ask_user",
    title: "向用户提问",
    description: "向用户提出选择、文本或区域确认问题；返回 questionId，等待用户通过界面回答。",
    input: askInput,
    output,
    effect: "interactive",
    targets: () => [],
    replay: "unsafe",
    timeoutMs: 86_400_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      const question = questions.request(ctx.sessionId, ctx.agentId, {
        questionType: args.type,
        spec: args.spec,
        toolCallId: ctx.toolCallId,
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        timeoutSeconds: args.timeoutSeconds,
      });
      return ok({
        questionId: question.id,
        status: "pending",
        ...(args.timeoutSeconds ? { timeoutSeconds: args.timeoutSeconds } : {}),
      });
    },
  };
  const present: ToolDefinition<z.infer<typeof presentInput>> = {
    name: "present",
    title: "呈现内容",
    description: `普通呈现使用 payload 对象。交付文件例：${presentExample}；指向区域例：{"payload":{"kind":"focus","path":"报告.xlsx","range":"'汇总'!A1:D5","note":"核对结果"}}。focus 可用已读回的 docId 替代 path。
数值终稿使用独立根分支 {"finalize":{"status":"complete","sources":[{"refId":"从可见工具正文复制的refId"}]}}。只复制当前会话当前代理可见的成功工具正文 numericEvidence.sources；仅报告部分指标时，从 candidates.items 选择对应 refId 替换默认 sources，不把 root 与全部子项一起照抄。非数值解释候选的默认 sources 为空，须从目录选择；数值任务仍必须组合实际数值，目录受限且没有数值义务的任务可使用真实非数值来源，但须至少选到工作簿原始 values/formulas 或宿主 external/report/preflight 事实，不能单靠脚本或 SQL 自造文字完成。纯目录清单等没有受支持工作簿来源的任务目前只能 incomplete。候选提供真实值类型、字段或列名出处。需要标签和单位时，复制 numericEvidence.bindings 的 {bindingId} 到 finalize.bindings；改选 sources 时只从 bindingCandidates.items 复制该数值的 bindingId，每值最多一个，不能用 valueRefId/labelRefId/relation 自造关系。无候选时不绑定，尤其 reportFacts 已定位保存总计时无需另造标签关系。同回执唯一显式单位候选可由宿主自动关联具体单元格，多个候选须明确选择、不能自动猜；并在 sources 中选择其数值；只支持同一次真实 range 读取中紧邻左侧或读窗首行上方的标签，不是业务语义认证。单位只取原文标签末尾受支持的明确单位括号片段，明确行数标签可用行；不能自己填写或猜测单位。目录 shown/total/truncated 与 bindingCoverage 表示值候选及标签绑定各自覆盖范围，未展示项须缩小范围重新获取，不能猜 refId 或自造 pointer。range 的 values 默认附同当前快照格式化显示；缺失或不支持格式明确保留，不用 SQL 舍入别名冒单元格显示。支持 workbook_read range 的 values/formulas、objects 的 reportFacts 白名单整体、overview/objects 的 preserved/externalLinkDetails 精确整体、workbook_analyze SQL/profile/sort_preflight 整体和具有真实宿主读取来源的 run_script 结果。reportFacts 自动区分保存透视显示总计、对象关联及能力边界；sort_preflight 分开提供当前预检、跨数据行合并风险与已确认保存包的 savedSheet 指纹；targetRange 仍是排序目标，savedSheet.scope 明确完整工作表 XML 及非其他工作表 XML 包部件的比较覆盖，不是局部读窗。预检不证明历史执行；仅在本轮真实 copy 身份与原件、输出双方当前可见检查点闭合且指纹相同时，宿主才能交付保存后该表原样的端点结论，不表示全过程从未修改或未来重算不变；不开放任意元数据指针。元数据数字、位置索引或文字不能代替实际数值。必须在最后一次写入并由现有自动保存完成后重新读回或分析，不能引用修改回执。本轮已预检且最终选定文档的排序目标，写后须逐目标重取当前 sort_preflight 和覆盖目标的 values/formulas 完整读窗；宿主自动带当前允许/阻断原因，另以真实成功 sort 回执说明历史执行，不把写后 safe 称为已执行。读窗覆盖不等于业务记录关联已独立验证，仍按原题选择必要记录与公式结果，不能只选少量数字漏掉必报项。已读取外链元数据的选定文档须有当前可见 overview/objects 外链整体，自动附目标、两层缓存与限制；不会自动读目标或刷新。requestedRange 是原请求，effectiveRange 是裁剪范围，returnedRange 是当前页实际返回；无原请求记录不补猜。成功终稿自动交付最终选择中本轮真实写入的已保存工作簿；只读 reportFacts 可交付对应原件；目录受限任务可交付最终选定真实证据的当前原件。外链整体只引用已确认当前检查点的真实目标原文与两层保存缓存，目标字符串不是已访问证明。实际访问只由宿主记录渲染，来源哈希读取也计入；范围未明确时固定要求澄清并 incomplete，访问记录未知或未闭合时不能 complete。已发旧修订卡不算当前交付。文件卡先核工作区可下载状态，note 由宿主生成，不能借卡片自报总计、刷新或访问状态；不会暗中保存或刷新只读原件。不允许自己填写 value、note、title、label、toolCallId、pointer 或总结。最多32处引用、200个标量、24000字符，超限缩小范围；过期或不可见来源必须重新获取。该调用必须是本步唯一工具，成功后由服务器核验真实值与全部读取来源、分组呈现一次 SQL/脚本出处并结束，不再自行补写。尚未完成可用 {"finalize":{"status":"incomplete","sources":[]}} 明确交付未完成。`,
    input: presentInput,
    inputJsonSchema: z.toJSONSchema(presentSchema),
    output,
    effect: "interactive",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    finalizesTurn: (args) =>
      args !== null && typeof args === "object" && Object.hasOwn(args, "finalize"),
    finalReply(args, result) {
      if (!("finalize" in args) || result.status !== "ok") return undefined;
      const data = result.data as { finalText?: unknown } | undefined;
      return typeof data?.finalText === "string" ? data.finalText : undefined;
    },
    execute(args, ctx) {
      if ("finalize" in args) return finalizeNumeric(log, documents, args.finalize, ctx);
      if (args.payload.kind === "file")
        return presentVerifiedFile(log, documents, args.payload.path, ctx);
      log.append(ctx.sessionId, ctx.agentId, [{ type: "ui.present", data: args.payload }]);
      return ok({ presented: true });
    },
  };
  const todo: ToolDefinition<z.infer<typeof todoInput>> = {
    name: "todo",
    title: "维护待办",
    description: `用 set 整体替换待办清单，或用 update 更新一项状态与结果。${todoExamples}`,
    input: todoInput,
    inputJsonSchema: z.toJSONSchema(todoSchema),
    output,
    effect: "state",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      if (args.op === "set") {
        log.append(ctx.sessionId, ctx.agentId, [{ type: "todo.set", data: { items: args.items } }]);
      } else {
        log.append(ctx.sessionId, ctx.agentId, [
          {
            type: "todo.updated",
            data: {
              todoId: args.todoId,
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.result !== undefined ? { result: args.result } : {}),
            },
          },
        ]);
      }
      return ok({ updated: true });
    },
  };
  return [ask, present, todo];
}
