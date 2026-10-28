import { harnessState, harnessTaskId, harnessUsefulProgress, harnessUsefulProofs, stableHarnessHash, turnAccessBinding, type SessionLog, type ToolContext, type ToolDefinition } from "@excelmanus/kernel";
import { semanticPlanKey, semanticAttemptKey } from "./harness-computation.ts";
import {
  type HarnessDeliveryState,
  type HarnessPlan,
  type ToolResult,
  VerificationInput,
} from "@excelmanus/protocol";
import { type DocumentService, workbookQueryTool } from "@excelmanus/workbook";
import { z } from "zod";
import {
  finalizeLegacyHarness,
  catalogScopeIdentity,
  harnessDeliveryTool,
  isHostFinalizationConflict,
} from "./harness-delivery.ts";

interface Coordinator {
  registerOrResolve(
    input: z.infer<typeof VerificationInput>,
    ctx: ToolContext,
  ): Promise<HarnessPlan>;
  recordUnsupported?(plan: HarnessPlan, ctx: ToolContext, diagnostics: unknown): ToolResult;
  prepare?(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  check(plan: HarnessPlan, ctx: ToolContext): Promise<ToolResult>;
  deliveryState(ctx: ToolContext): Promise<HarnessDeliveryState>;
}

/** Install after common effect wrappers so legacy and SDK callers retain their original gates. */
export function installHarnessFacades({
  tools,
  log,
  documents,
  coordinator,
}: {
  tools: Map<string, ToolDefinition>;
  log: SessionLog;
  documents: DocumentService;
  coordinator: Coordinator;
}): void {
  const analyze = tools.get("workbook_analyze");
  if (analyze) {
    tools.set("workbook_analyze", { ...analyze, modelVisible: false });
    tools.set("workbook_query", workbookQueryTool(analyze));
  }
  const todo = tools.get("todo");
  if (todo) tools.set("todo", { ...todo, modelVisible: false });
  const delivery = {
    log,
    documents,
    deliveryState: (ctx: ToolContext) => coordinator.deliveryState(ctx),
  };
  const present = tools.get("present");
  if (present)
    tools.set("present", {
      ...present,
      isHostFinalizationConflict,
      async execute(args, ctx) {
        if (args !== null && typeof args === "object" && Object.hasOwn(args, "finalize"))
          return finalizeLegacyHarness(delivery, (args as { finalize: unknown }).finalize, ctx);
        return present.execute(args, ctx);
      },
    });
  const input = z.union([
    z.strictObject({
      action: z.literal("describe"),
      tool: z.literal("workbook_edit").optional(),
      ops: z.array(z.string().min(1)).min(1).max(8).optional(),
      auxiliaryGroups: z.array(z.enum(["agents", "presentation", "skills", "memory"])).min(1).max(4).optional(),
      toolFamilies: z.array(z.enum(["files", "scripts", "render", "text", "workbook"])).min(1).max(5).optional(),
    }),
    z.strictObject({
      action: z.enum(["register", "prepare", "execute"]).default("execute"),
      verification: VerificationInput,
    }),
  ]);
  tools.set("workbook_check", {
    name: "workbook_check",
    title: "检查来源与结果",
    description:
      "普通只读查询或事实回答不需要登记写出计划。需要代理协作、展示、技能或记忆工具时，用 action=describe、auxiliaryGroups=[agents|presentation|skills|memory] 按需显示；不改变文件授权，不与 tool/ops 混用。需要类型化源诊断时可先 action=describe 读取完整 verification 格式，再 prepare/execute；describe 不读取文件也不执行检查。查询编辑操作格式用 action=describe、tool=workbook_edit、ops=[操作名]（一次1至8个），只返回这些操作的原始参数格式。完整验证声明只在此工具提供。写入前 action=register 登记声明并返回 planId/version，供写入工具的 verification 引用；允许输出尚未创建，登记不会读输出、执行检查或证明完成。先 action=prepare 检查域、表头、字段、输出形状与来源独立性，返回 supported/unsupported/invalid，不执行也不登记计划；action=execute 登记或复用不可变验证计划并检查当前已保存的来源和输出。支持闭合 typed_aggregate，以及使用原始来源 eventScope 与 sourceId 锚点的混合来源身份检查；仅支持类型化声明，不执行任意 SQL。返回作用范围、反例及不可验证项；源诊断发现与输出正确性义务分开。不支持的规则保留 unverified，按宿主允许结果交付 partial/blocked，不反复重试或声称完成。不会改写文件，不以登记计划冒称通过。",
    input,
    inputJsonSchema: z.toJSONSchema(input, { io: "input" }),
    output: z.unknown(),
    effect: "read",
    targets: () => [],
    replay: "safe",
    timeoutMs: 60_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx) {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        const data = {
          action: "prepare",
          preparation: "invalid",
          executed: false,
          diagnostics: parsed.error.issues.map((issue) => ({
            code: "DECLARATION_INVALID",
            path: issue.path,
            message: issue.message,
          })),
        };
        return args !== null &&
          typeof args === "object" &&
          (args as { action?: unknown }).action === "prepare"
          ? { status: "ok", data }
          : {
              status: "error",
              error: {
                code: "INVALID_ARGUMENT",
                message: "检查声明无效，请先 prepare 并修正字段。",
                retryable: false,
              },
              data,
            };
      }
      try {
        if (parsed.data.action === "describe") {
          const staged = !!ctx.turnId && !!(ctx.access?.binding() ?? turnAccessBinding(log.dbHandle,ctx.sessionId,ctx.agentId,ctx.turnId))?.contractRef;
          if (parsed.data.toolFamilies) {
            if (parsed.data.tool !== undefined || parsed.data.ops !== undefined || parsed.data.auxiliaryGroups !== undefined)
              throw new Error("工具族发现不能与其他格式查询混用。");
            return {status:"ok",data:{action:"describe",toolFamilies:[...new Set(parsed.data.toolFamilies)],executed:false,visibility:"requested; only tools allowed by the current contract, role and model are offered; use available read/query paths when omitted; request contract expansion only when the user task genuinely requires it"}};
          }
          if (parsed.data.auxiliaryGroups) {
            if (parsed.data.tool !== undefined || parsed.data.ops !== undefined)
              throw new Error("辅助工具显示请求不能与编辑格式查询混用。");
            return {status:"ok",data:{action:"describe",auxiliaryGroups:[...new Set(parsed.data.auxiliaryGroups)],executed:false}};
          }
          if (parsed.data.tool === "workbook_edit") {
            if (!parsed.data.ops) throw new Error("查询编辑格式需要 ops（1至8个操作名）。");
            type Json = Record<string, unknown>;
            const object = (value: unknown): Json =>
              value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
            const schema = object(tools.get("workbook_edit")?.inputJsonSchema);
            const properties = object(schema.properties);
            const ops = object(properties.ops);
            const items = object(ops.items);
            const alternatives = Array.isArray(items.oneOf) ? items.oneOf : items.anyOf;
            if (!Array.isArray(alternatives)) throw new Error("当前宿主没有可查询的编辑操作格式。");
            const requested = new Set(parsed.data.ops);
            const selected = alternatives.filter(branch =>
              requested.has(String(object(object(object(branch).properties).op).const)));
            const found = new Set(selected.map(branch =>
              String(object(object(object(branch).properties).op).const)));
            const missing = [...requested].filter(name => !found.has(name));
            if (missing.length) throw new Error("未知编辑操作：" + missing.join(", "));
            if (staged) return {status:"ok",data:{action:"describe",tool:"workbook_edit",ops:[...requested],executed:false,schemaAvailable:"next model request"}};
            const { anyOf: _anyOf, oneOf: _oneOf, ...itemBase } = items;
            return { status: "ok", data: {
              action: "describe", tool: "workbook_edit", ops: [...requested], executed: false,
              description: tools.get("workbook_edit")?.description,
              inputSchema: { ...schema, properties: { ...properties, ops: {
                ...ops, items: { ...itemBase, [Array.isArray(items.oneOf) ? "oneOf" : "anyOf"]: selected },
              } } },
            } };
          }
          if (parsed.data.ops) throw new Error("ops 仅用于 tool=workbook_edit 的格式查询。");
          if (staged) return {status:"ok",data:{action:"describe",executed:false,verificationAvailable:true,schemaAvailable:"next model request"}};
          return {
            status: "ok",
            data: {
              action: "describe",
              executed: false,
              verificationSchema: z.toJSONSchema(VerificationInput, { io: "input" }),
            },
          };
        }
        if (parsed.data.action === "register") {
          const plan = await coordinator.registerOrResolve(parsed.data.verification, ctx);
          return {
            status: "ok",
            data: {
              action: "register",
              planId: plan.id,
              version: plan.version,
              validation: "unverified",
              executed: false,
            },
          };
        }
        const prepared = await coordinator.prepare?.(parsed.data.verification, ctx);
        if (parsed.data.action === "prepare")
          return (
            prepared ?? {
              status: "error",
              error: {
                code: "INVALID_ARGUMENT",
                message: "当前宿主不支持 prepare。",
                retryable: false,
              },
            }
          );
        if (
          (prepared?.data as { preparation?: string } | undefined)?.preparation === "unsupported" &&
          coordinator.recordUnsupported
        ) {
          const plan = await coordinator.registerOrResolve(parsed.data.verification, ctx);
          return coordinator.recordUnsupported(
            plan,
            ctx,
            (prepared!.data as { diagnostics?: unknown }).diagnostics,
          );
        }
        if (
          prepared &&
          (prepared.data as { preparation?: string } | undefined)?.preparation !== "supported"
        )
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "声明预检尚未 supported，未登记或执行检查；请修正或诚实交付 partial。",
              retryable: false,
            },
            data: prepared.data,
          };
        return coordinator.check(
          await coordinator.registerOrResolve(parsed.data.verification, ctx),
          ctx,
        );
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
          throw error;
        return {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: error instanceof Error ? error.message : "检查参数无效。",
            retryable: false,
          },
        };
      }
    },
  });
  const checkTool = tools.get("workbook_check")!;
  tools.set("workbook_check", { ...checkTool, async execute(args, ctx) {
    const initialBinding = ctx.access?.binding() ?? turnAccessBinding(log.dbHandle,ctx.sessionId,ctx.agentId,ctx.turnId ?? "legacy");
    const initialTaskId = harnessTaskId({sessionId:ctx.sessionId,agentId:ctx.agentId,turnId:ctx.turnId ?? "legacy",...initialBinding});
    const initialScopeId = catalogScopeIdentity(log,ctx,initialTaskId);
    const result = await checkTool.execute(args, ctx);
    ctx.signal.throwIfAborted();
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const parsed = input.safeParse(args);
    const verification = parsed.success && parsed.data.action !== "describe"
      ? parsed.data.verification : undefined;
    const binding = ctx.access?.binding() ?? turnAccessBinding(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId ?? "legacy");
    const taskId = harnessTaskId({ sessionId:ctx.sessionId, agentId:ctx.agentId, turnId:ctx.turnId ?? "legacy", ...binding });
    if (taskId !== initialTaskId || catalogScopeIdentity(log,ctx,taskId) !== initialScopeId) return result;
    let attemptKey: string;
    if (typeof data.computationKey === "string") attemptKey = data.computationKey;
    else if (data.preparation === "invalid" || data.preparation === "unsupported" || result.status === "error") {
      const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics as Array<Record<string, unknown>> : [];
      attemptKey = stableHarnessHash({ preparation:data.preparation ?? "invalid",
        diagnostics: diagnostics.map(d=>({code:d.code,path:d.path})), code:result.error?.code,
        declaration: verification && !("planId" in verification)
          ? semanticAttemptKey(verification)
          : verification });
    } else {
      attemptKey = stableHarnessHash({ action:parsed.success ? parsed.data.action : "invalid",
        declaration:verification && !("planId" in verification) ? semanticPlanKey(verification) ?? verification : verification });
    }
    const state = harnessState(log.dbHandle,ctx.sessionId,taskId);
    log.append(ctx.sessionId, ctx.agentId, [{ type:"harness.progress", data:{
      taskId, kind:"attempt", attemptKey, progressKey:harnessUsefulProgress(state), proofKeys:harnessUsefulProofs(state),
      resolvedFailureKeys:Array.isArray(data.resolvedFailureKeys) ? data.resolvedFailureKeys.filter((key):key is string=>typeof key === "string") : [],
      nonproductivePreflight:data.preparation === "invalid" || data.preparation === "unsupported" || result.status === "error",
    }}]);
    if (Array.isArray(data.checks) && taskId === initialTaskId &&
        catalogScopeIdentity(log,ctx,taskId) === initialScopeId)
      return { ...result, data:{...data,evidenceScope:{scopeId:initialScopeId,taskId,turnId:ctx.turnId}} };
    return result;
  }});
  tools.set("deliver", harnessDeliveryTool(delivery));
}
