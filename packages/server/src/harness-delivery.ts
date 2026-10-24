import { createHash } from "node:crypto";
import { capToolOutput, numericDeliveryState, type SessionLog, type ToolContext, type ToolDefinition } from "@excelmanus/kernel";
import type { HarnessBinding, HarnessCheckReceipt, HarnessDeliveryState, NumericSource, ToolResult } from "@excelmanus/protocol";
import type { DocumentService } from "@excelmanus/workbook";
import { z } from "zod";
import { assertDeliveryBindings, finalizeNumeric, finalizeNumericFactSets, numericFactSets, numericFinalization, verifiedDeliveryFile } from "./numeric-finalizer.ts";

const handle = z.string().min(1).max(200);
const explanation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("method"), factSetId: handle }),
  z.strictObject({ kind: z.literal("rule"), checkId: handle }),
  z.strictObject({ kind: z.literal("finding"), checkId: handle }),
  z.strictObject({ kind: z.literal("limitation"), code: z.enum(["declared_scope_only", "query_alias_not_unit", "saved_not_business_verified"]) }),
]);
export const HarnessDeliveryInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect") }),
  z.strictObject({ action: z.literal("finalize"), outcome: z.enum(["completed", "findings", "partial", "blocked"]),
    factSetIds: z.array(handle).optional(), artifactIds: z.array(handle).optional(), checkIds: z.array(handle).optional(), explanations: z.array(explanation).optional() }),
]);
type DeliveryArgs = z.infer<typeof HarnessDeliveryInput>;
type FinalizeArgs = Extract<DeliveryArgs, { action: "finalize" }>;
export interface HarnessDeliveryOptions {
  log: SessionLog;
  documents: DocumentService;
  deliveryState(ctx: ToolContext): Promise<HarnessDeliveryState>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rejected = (message: string): ToolResult => ({ status: "error", error: { code: "INVALID_ARGUMENT", message, retryable: false } });
const hostFinalizationConflicts = new WeakSet<object>();
function stateChanged(message: string): ToolResult {
  const result: ToolResult = { status: "error", error: { code: "VERSION_CONFLICT", message, retryable: true } };
  hostFinalizationConflicts.add(result);
  return result;
}
/** Live object provenance only. Serialized markers or copied errors cannot grant retry credit. */
export const isHostFinalizationConflict = (result: ToolResult): boolean =>
  hostFinalizationConflicts.has(result) && result.status === "error" &&
  result.error?.code === "VERSION_CONFLICT" && result.error.retryable === true;

function needsFreshInspection(log: SessionLog, ctx: ToolContext): boolean {
  if (!ctx.turnId) return false;
  const start = log.dbHandle.prepare(
    "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type IN ('turn.started','turn.access.updated') AND type='turn.started' ORDER BY seq DESC LIMIT 1",
  ).get(ctx.sessionId, ctx.agentId) as { seq: number; data: string } | undefined;
  if (!start) return false;
  if (object(JSON.parse(start.data)).turnId !== ctx.turnId) return true;
  // Iterate only this agent's model-context projection, never its access.fact history.
  const rows = log.dbHandle.prepare(
    "SELECT c.from_seq,c.superseded,c.item,l.data FROM agent_context c CROSS JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.from_seq>? AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' ORDER BY c.idx DESC",
  ).all(ctx.sessionId, ctx.agentId, start.seq, ctx.agentId) as { from_seq: number; superseded: number; item: string; data: string }[];
  let inspectedSeq = -1;
  for (const row of rows) {
    const shown = object(JSON.parse(row.item)), recorded = object(JSON.parse(row.data));
    const result = object(recorded.result), data = object(result.data), marker = object(data.__hostFinalizationConflict);
    if ((recorded.toolName === "deliver" || recorded.toolName === "present") &&
        recorded.status === "error" && result.status === "error" &&
        marker.version === 1 && marker.kind === "state_changed" && marker.turnId === ctx.turnId) return inspectedSeq <= row.from_seq;
    if (row.superseded === 0 && recorded.toolName === "deliver" && recorded.status === "ok" &&
        result.status === "ok" && data.action === "inspect" && shown.isError !== true &&
        shown.toolName === "deliver" && shown.toolCallId === recorded.toolCallId &&
        JSON.stringify(shown.output) === JSON.stringify(capToolOutput(result as ToolResult, row.from_seq)))
      inspectedSeq = Math.max(inspectedSeq, row.from_seq);
  }
  return false;
}

const fingerprint = (state: HarnessDeliveryState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const physicalLocation = (location: HarnessCheckReceipt["findings"][number]["location"]) => location && ({ path: location.path, sheet: location.sheet, worksheetRow: location.worksheetRow, column: location.column });
const visibleBinding = (binding: HarnessBinding) => ({ path: binding.path, sheet: binding.sheet, range: binding.range,
  ...(binding.expectedAbsent ? { expectedAbsent: true, historicalInputSha256: binding.sha256 } : { sha256: binding.sha256 }),
});
const visibleArtifacts = (state: HarnessDeliveryState) => state.artifacts.map(artifact => ({
  id: artifact.id, taskId: artifact.taskId, toolCallId: artifact.toolCallId, path: artifact.path,
  effect: artifact.effect, execution: artifact.execution, persistence: artifact.persistence, validation: artifact.validation,
  ...(artifact.effect === "format" ? { validationScope: "persisted_structure_and_presentation_only" } : {}),
  docId: artifact.docId, revision: artifact.revision, sha256: artifact.sha256, planVersion: artifact.planVersion,
  footprintCount: artifact.footprint.length, dependencyGapCount: artifact.dependencyGaps?.length ?? 0,
  bindings: artifact.bindings.map(visibleBinding),
}));
const visibleFindings = (check: HarnessCheckReceipt) => check.findings.map(finding => ({
  code: finding.code, location: physicalLocation(finding.location), sourceLocation: physicalLocation(finding.sourceLocation), actual: finding.actual, expected: finding.expected,
  expectedBasis: check.assurance === "source_derived" && (finding.code === "LINEAGE_ANCHOR_MISMATCH" || finding.code === "LOOKUP_VALUE_MISMATCH") && finding.sourceLocation?.column
    ? "source" : check.assurance === "structural" ? "host_contract" : "declared_check_parameter",
}));
const visibleChecks = (state: HarnessDeliveryState, selected?: ReadonlySet<string>) => state.checks.map(check => ({ id: check.id, taskId: check.taskId, status: check.status, purpose: check.purpose, assurance: check.assurance,
  ...(check.planId === "host.byte_transfer" ? { validationScope: "byte_identical_transfer_only" } : {}),
  ...((check.status === "passed" || check.status === "failed") && (!selected || selected.has(check.id)) ? {
    bindings: check.bindings.map(visibleBinding),
    findings: visibleFindings(check), failedCount: check.failedCount, unverifiedCount: check.unverifiedCount, uncoveredFieldCount: check.uncoveredFields.length, findingsTruncated: check.findingsTruncated,
  } : { dataSuppressed: true }),
}));
const currentBindings = (state: HarnessDeliveryState) => [
  ...state.artifacts.filter(artifact => artifact.persistence === "saved" && artifact.validation !== "stale").flatMap(artifact => [
    ...artifact.bindings,
    ...(artifact.sha256 ? [{ path: artifact.path, docId: artifact.docId, rev: artifact.revision, sha256: artifact.sha256 }] : []),
  ]),
  ...state.checks.filter(check => check.status === "passed" || check.status === "failed").flatMap(check => check.bindings),
];
const limitationText = {
  declared_scope_only: "检查只覆盖已声明且实际读取的来源和字段，不证明所有自然语言要求均已被声明。",
  query_alias_not_unit: "查询列名是实际查询的别名，不认证业务含义、单位或原始行完整性。",
  saved_not_business_verified: "文件已保存只表示持久化事实，不等于业务检查通过或外链已经刷新。",
};

/** Handles must occur in the same agent's current authentic inspect response, not merely the log. */
function wasInspected(log: SessionLog, ctx: ToolContext, kind: "factSets" | "artifacts" | "checks", current: { id: string }): boolean {
  const rows = log.dbHandle.prepare(
    "SELECT c.item,l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' AND json_extract(c.item,'$.toolName')='deliver' ORDER BY c.idx DESC",
  ).all(ctx.sessionId, ctx.agentId, ctx.agentId) as { item: string; data: string }[];
  return rows.some(row => {
    const shown = object(JSON.parse(row.item)), recorded = object(JSON.parse(row.data));
    const output = object(shown.output), result = object(recorded.result);
    if (shown.isError === true || recorded.toolName !== "deliver" || shown.toolCallId !== recorded.toolCallId || recorded.status !== "ok" || result.status !== "ok" || output.status !== "ok") return false;
    const visible = object(output.data), actual = object(result.data);
    if (actual.action !== "inspect" || visible.action !== "inspect") return false;
    const values = actual[kind], seen = visible[kind];
    return Array.isArray(values) && Array.isArray(seen) && values.some(value => JSON.stringify(value) === JSON.stringify(current)) && seen.some(value => JSON.stringify(value) === JSON.stringify(current));
  });
}

function renderState(state: HarnessDeliveryState, outcome: FinalizeArgs["outcome"], selected: ReadonlySet<string>): string {
  const outcomes = { completed: "任务已完成。", findings: "调查已完成，以下保留实际发现。", partial: "任务部分完成，仍有未解决事项。", blocked: "任务受阻，未宣称完成。" };
  const parts = [outcomes[outcome], "执行、保存、检查与任务结果分别报告；通过仅适用于列出的范围。"];
  if (state.plan || state.checks.length) parts.push(limitationText.declared_scope_only);
  for (const artifact of state.artifacts) {
    parts.push(`文件 ${JSON.stringify(artifact.path)}：执行=${artifact.execution}；保存=${artifact.persistence}；验证=${artifact.validation}；已记录依赖缺口=${artifact.dependencyGaps?.length ?? 0}${artifact.revision === undefined ? "" : `；修订=${artifact.revision}`}${artifact.sha256 ? `；SHA256=${artifact.sha256}` : ""}。`);
    if (artifact.effect === "format") parts.push("格式类验证仅证明已持久化的结构与呈现，不证明业务规则、图表含义、批注内容真实性或既有数值正确性。");
  }
  for (const check of state.checks) {
    parts.push(`检查回执 ${JSON.stringify(check.id)}：${check.status}；用途=${check.purpose}；保证类别=${check.assurance}。`);
    if (check.planId === "host.byte_transfer") parts.push("字节传输验证只证明目标保存的字节与移动或复制前的来源相同，不证明来源内容或整个工作簿的业务正确性。");
    if (check.status !== "passed" && check.status !== "failed") {
      parts.push("当前检查未获有效验证，不复述历史原始值、计数或模型解释。");
      continue;
    }
    if (!selected.has(check.id)) {
      parts.push("该检查的完整状态已计入任务结果；未选择已查看的明细标识，不复述原始观测值。");
      continue;
    }
    parts.push(`已发现失败=${check.failedCount}；不可验证=${check.unverifiedCount}；实际检查来源（historicalInputSha256 仅表示移动前输入摘要）=${JSON.stringify(check.bindings.map(visibleBinding))}；未覆盖字段数=${check.uncoveredFields.length}。`);
    if (check.uncoveredFields.length) parts.push("存在未覆盖字段；检查结论不涵盖这些字段，修复明细保留在原始检查回执中。");
    for (const finding of visibleFindings(check)) parts.push(`检查观测与预期（declared_check_parameter 是声明参数，host_contract 是宿主规则，均不认证为来源单元格事实）：${JSON.stringify(finding)}`);
    if (check.findingsTruncated) parts.push("仅展示部分反例，完整计数仍如上；未把截断反例当成全部记录。");
  }
  if (state.unverifiedObligations.length) parts.push(`仍有 ${state.unverifiedObligations.length} 项未解决或未验证义务。模型提出的义务说明不是已验证事实，不据其措辞认证完成。`);
  return parts.join("\n\n");
}

async function finish(
  options: HarnessDeliveryOptions, ctx: ToolContext, args: FinalizeArgs,
  evidence: () => Promise<ToolResult | undefined>, initial?: HarnessDeliveryState,
): Promise<ToolResult> {
  if (needsFreshInspection(options.log, ctx)) return rejected("上次宿主交付目录发生并发变化，请先重新 inspect；不能复用旧目录或省略标识直接重试。");
  const state = initial ?? await options.deliveryState(ctx);
  if (!state.allowedOutcomes.includes(args.outcome)) return rejected("当前任务存在未通过、过期或未验证的必需输出义务，不能通过改写结果或省略引用宣称完成。请修复或交付 partial/blocked。");
  const result = await evidence();
  if (result && result.status !== "ok") return result;
  const data = object(result?.data);
  if ((args.outcome === "completed" || args.outcome === "findings") && result && data.finalizationStatus !== "complete") return rejected("真实来源或访问核验尚未完成，不能确认任务完成。");
  const files = new Map<string, Awaited<ReturnType<typeof verifiedDeliveryFile>>>();
  for (const artifact of state.artifacts) {
    if (artifact.persistence !== "saved" || artifact.validation === "stale") continue;
    const file = await verifiedDeliveryFile(options.log, options.documents, artifact.path, ctx);
    if (file.sha256 !== artifact.sha256 || (artifact.docId !== undefined && (file.docId !== artifact.docId || file.rev !== artifact.revision))) return rejected("交付文件已发生变化，请重新检查。");
    files.set(file.path, file);
  }
  for (const value of Array.isArray(data.deliveredFiles) ? data.deliveredFiles : []) {
    const expected = object(value);
    if (typeof expected.path !== "string") return rejected("文件事实缺少路径。");
    const file = await verifiedDeliveryFile(options.log, options.documents, expected.path, ctx);
    if (file.sha256 !== expected.sha256 || file.rev !== expected.rev || file.docId !== expected.docId) return rejected("数值来源文件已发生变化，请重新检查。");
    files.set(file.path, file);
  }
  const after = await options.deliveryState(ctx);
  if (fingerprint(after) !== fingerprint(state) || !after.allowedOutcomes.includes(args.outcome)) return stateChanged("交付核验期间来源、文件、权限或检查状态改变，请重新检查交付目录。");
  const dependencies = Array.isArray(data.sourceDependencies) ? data.sourceDependencies as NumericSource[] : [];
  assertDeliveryBindings(options.documents, [
    ...currentBindings(after),
    ...dependencies.map(source => ({ path: source.path, docId: source.docId, rev: source.rev, sha256: source.sourceFile.currentSha256 })),
    ...[...files.values()].map(file => ({ path: file.path, ...(file.docId ? { docId: file.docId } : {}), ...(file.rev === undefined ? {} : { rev: file.rev }), sha256: file.sha256 })),
  ], ctx);
  const selectedChecks = new Set([...(args.checkIds ?? []), ...(args.explanations ?? []).flatMap(item => item.kind === "rule" || item.kind === "finding" ? [item.checkId] : [])]);
  const text = [renderState(after, args.outcome, selectedChecks), typeof data.finalText === "string" ? data.finalText : ""];
  for (const item of args.explanations ?? []) {
    if (item.kind === "limitation" && (item.code !== "declared_scope_only" || (!after.plan && !after.checks.length))) text.push(limitationText[item.code]);
    if (item.kind === "method") text.push("计算方法与实际来源随所选事实列出；表达式执行成功不是业务规则独立验证。");
    if (item.kind === "rule") text.push("规则引用仅标识以上实际运行的检查及其用途，不将模型提出的需求解释认证为用户原文或业务证明。");
  }
  if (files.size) options.log.append(ctx.sessionId, ctx.agentId, [...files.values()].map(file => ({ type: "ui.present" as const, data: { kind: "file" as const, path: file.path, note: `已保存文件 · SHA256 ${file.sha256}；验证状态见任务回执。` } })));
  return { status: "ok", data: { outcome: args.outcome, finalizationStatus: args.outcome === "completed" || args.outcome === "findings" ? "complete" : "incomplete", finalText: text.filter(Boolean).join("\n\n"), artifacts: visibleArtifacts(after), checks: visibleChecks(after, selectedChecks), unverifiedObligationCount: after.unverifiedObligations.length, deliveredFiles: [...files.values()] } };
}

/** Hidden historical calls traverse the identical whole-task guard and numeric provenance path. */
export async function finalizeLegacyHarness(options: HarnessDeliveryOptions, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = numericFinalization.safeParse(args);
  if (!parsed.success) return rejected("历史交付参数无效。");
  try {
    return await finish(options, ctx, { action: "finalize", outcome: parsed.data.status === "complete" ? "completed" : "partial" }, () => finalizeNumeric(options.log, options.documents, parsed.data, ctx, { suppressCards: true }));
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return rejected(error instanceof Error ? error.message : "交付核验失败。");
  }
}

export function harnessDeliveryTool(options: HarnessDeliveryOptions): ToolDefinition {
  return {
    name: "deliver", title: "交付结果", description: "inspect 返回当前授权、可见且未过期的事实集、文件与检查目录。finalize 只引用目录标识并选择任务结果；宿主重验所有依赖和整项任务义务后生成结果。未通过的必需输出检查不能改称 findings；源诊断发现可在任务允许时作为 findings 完成。不得填写数值、标签、单位、指针或自由说明。",
    input: HarnessDeliveryInput, inputJsonSchema: z.toJSONSchema(HarnessDeliveryInput, { io: "input" }), output: z.unknown(), effect: "interactive", targets: () => [], replay: "safe", timeoutMs: 30_000, roles: ["main", "lead", "worker", "reader"],
    finalizesTurn: args => object(args).action === "finalize",
    isHostFinalizationConflict,
    finalReply: (_args, result) => result.status === "ok" && typeof object(result.data).finalText === "string" ? object(result.data).finalText as string : undefined,
    async execute(raw, ctx) {
      const parsed = HarnessDeliveryInput.safeParse(raw);
      if (!parsed.success) return rejected("交付仅接受 inspect 或由可见目录标识组成的 finalize，不能提交自由内容。");
      try {
        const args = parsed.data, state = await options.deliveryState(ctx);
        const facts = await numericFactSets(options.log, options.documents, ctx);
        if (args.action === "inspect") {
          const after = await options.deliveryState(ctx);
          if (fingerprint(after) !== fingerprint(state)) return stateChanged("生成交付目录期间来源、权限或检查发生变化，请重新 inspect。");
          assertDeliveryBindings(options.documents, [
            ...currentBindings(after),
            ...facts.flatMap(fact => fact.provenance.map(source => ({ path: source.path, docId: source.docId, rev: source.rev, sha256: source.sourceFile.currentSha256 }))),
          ], ctx);
          return { status: "ok", data: { action: "inspect", taskId: after.taskId, factSets: facts, artifacts: visibleArtifacts(after), checks: visibleChecks(after), allowedOutcomes: after.allowedOutcomes, unverifiedObligationCount: after.unverifiedObligations.length } };
        }
        const factIds = [...new Set([...(args.factSetIds ?? []), ...(args.explanations ?? []).flatMap(item => item.kind === "method" ? [item.factSetId] : [])])];
        const checkIds = [...new Set([...(args.checkIds ?? []), ...(args.explanations ?? []).flatMap(item => item.kind === "rule" || item.kind === "finding" ? [item.checkId] : [])])];
        for (const [kind, ids, available] of [["factSets", factIds, facts], ["artifacts", args.artifactIds ?? [], visibleArtifacts(state)], ["checks", checkIds, visibleChecks(state)]] as const) {
          for (const id of ids) {
            const current = available.find(value => value.id === id);
            if (!current || !wasInspected(options.log, ctx, kind, current)) return rejected("所选标识尚未在当前可见交付目录中出现，或已过期、不可用；请先 inspect 并重新获取所需来源。");
          }
        }
        if ((args.outcome === "completed" || args.outcome === "findings") && !factIds.length && ctx.turnId && numericDeliveryState(options.log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId).required) return rejected("本轮需报告的数值结果尚未引用当前事实集；请先读取结果并 inspect。");
        return await finish(options, ctx, args, () => factIds.length ? finalizeNumericFactSets(options.log, options.documents, factIds, ctx) : Promise.resolve(undefined), state);
      } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return rejected(error instanceof Error ? error.message : "交付核验失败。");
  }
    },
  };
}
