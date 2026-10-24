import type { SessionLog, ToolContext, ToolDefinition } from "@excelmanus/kernel";
import { type HarnessDeliveryState, type HarnessPlan, type ToolResult, VerificationInput } from "@excelmanus/protocol";
import { type DocumentService, workbookQueryTool } from "@excelmanus/workbook";
import { z } from "zod";
import { finalizeLegacyHarness, harnessDeliveryTool, isHostFinalizationConflict } from "./harness-delivery.ts";

interface Coordinator {
  registerOrResolve(input: z.infer<typeof VerificationInput>, ctx: ToolContext): Promise<HarnessPlan>;
  check(plan: HarnessPlan, ctx: ToolContext): Promise<ToolResult>;
  deliveryState(ctx: ToolContext): Promise<HarnessDeliveryState>;
}

/** Install after common effect wrappers so legacy and SDK callers retain their original gates. */
export function installHarnessFacades({ tools, log, documents, coordinator }: {
  tools: Map<string, ToolDefinition>; log: SessionLog; documents: DocumentService; coordinator: Coordinator;
}): void {
  const analyze = tools.get("workbook_analyze");
  if (analyze) {
    tools.set("workbook_analyze", { ...analyze, modelVisible: false });
    tools.set("workbook_query", workbookQueryTool(analyze));
  }
  const todo = tools.get("todo");
  if (todo) tools.set("todo", { ...todo, modelVisible: false });
  const delivery = { log, documents, deliveryState: (ctx: ToolContext) => coordinator.deliveryState(ctx) };
  const present = tools.get("present");
  if (present) tools.set("present", { ...present, isHostFinalizationConflict, async execute(args, ctx) {
    if (args !== null && typeof args === "object" && Object.hasOwn(args, "finalize")) return finalizeLegacyHarness(delivery, (args as { finalize: unknown }).finalize, ctx);
    return present.execute(args, ctx);
  } });
  const input = z.strictObject({ verification: VerificationInput });
  tools.set("workbook_check", {
    name: "workbook_check", title: "检查来源与结果", description: "登记或复用不可变验证计划并检查当前已保存的来源和输出。支持闭合 typed_aggregate，以及使用原始来源 eventScope 与 sourceId 锚点的混合来源身份检查；仅支持类型化声明，不执行任意 SQL。返回作用范围、反例及不可验证项；源诊断发现与输出正确性义务分开。不支持的规则保留 unverified，按宿主允许结果交付 partial/blocked，不反复重试或声称完成。不会改写文件，不以登记计划冒称通过。",
    input, inputJsonSchema: z.toJSONSchema(input, { io: "input" }), output: z.unknown(), effect: "read", targets: () => [], replay: "safe", timeoutMs: 60_000, roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx) {
      const parsed = input.parse(args);
      return coordinator.check(await coordinator.registerOrResolve(parsed.verification, ctx), ctx);
    },
  });
  tools.set("deliver", harnessDeliveryTool(delivery));
}
