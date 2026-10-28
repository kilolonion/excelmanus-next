import { createHash } from "node:crypto";
import {
  assertDeliveryArtifactAllowed,
  capToolOutput,
  currentToolAccess,
  harnessProgress,
  listWorkspaceRootNamesSync,
  numericDeliveryState,
  type SessionLog,
  type ToolContext,
  type ToolDefinition,
  turnAccessBinding,
} from "@excelmanus/kernel";
import type {
  HarnessBinding,
  HarnessCheckReceipt,
  HarnessDeliveryState,
  NumericSource,
  ToolResult,
} from "@excelmanus/protocol";
import { HarnessCheckReceipt as ReceiptSchema } from "@excelmanus/protocol";
import type { DocumentService } from "@excelmanus/workbook";
import { z } from "zod";
import { hasHostEffectRegistrationGap } from "./harness-coordinator.ts";
import {
  assertDeliveryBindings,
  finalizeNumeric,
  finalizeNumericFactSets,
  numericFactSets,
  numericFinalization,
  verifiedDeliveryFile,
} from "./numeric-finalizer.ts";

const handle = z.string().min(1).max(200);
const explanation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("method"), factSetId: handle }),
  z.strictObject({ kind: z.literal("rule"), checkId: handle }),
  z.strictObject({ kind: z.literal("finding"), checkId: handle }),
  z.strictObject({
    kind: z.literal("limitation"),
    code: z.enum(["declared_scope_only", "query_alias_not_unit", "saved_not_business_verified"]),
  }),
]);
export const HarnessDeliveryInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("inspect"),
    catalogId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    action: z.literal("finalize"),
    outcome: z.enum(["completed", "findings", "partial", "blocked"]),
    factSetIds: z.array(handle).optional(),
    artifactIds: z.array(handle).optional(),
    checkIds: z.array(handle).optional(),
    explanations: z.array(explanation).optional(),
  }),
]);
type DeliveryArgs = z.infer<typeof HarnessDeliveryInput>;
type FinalizeArgs = Extract<DeliveryArgs, { action: "finalize" }>;
export interface HarnessDeliveryOptions {
  log: SessionLog;
  documents: DocumentService;
  deliveryState(ctx: ToolContext): Promise<HarnessDeliveryState>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const rejected = (message: string): ToolResult => ({
  status: "error",
  error: { code: "INVALID_ARGUMENT", message, retryable: false },
});
const hostFinalizationConflicts = new WeakSet<object>();
function stateChanged(message: string): ToolResult {
  const result: ToolResult = {
    status: "error",
    error: { code: "VERSION_CONFLICT", message, retryable: true },
  };
  hostFinalizationConflicts.add(result);
  return result;
}
/** Live object provenance only. Serialized markers or copied errors cannot grant retry credit. */
export const isHostFinalizationConflict = (result: ToolResult): boolean =>
  hostFinalizationConflicts.has(result) &&
  result.status === "error" &&
  result.error?.code === "VERSION_CONFLICT" &&
  result.error.retryable === true;

function needsFreshInspection(log: SessionLog, ctx: ToolContext): boolean {
  if (!ctx.turnId) return false;
  const start = log.dbHandle
    .prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type IN ('turn.started','turn.access.updated') AND type='turn.started' ORDER BY seq DESC LIMIT 1",
    )
    .get(ctx.sessionId, ctx.agentId) as { seq: number; data: string } | undefined;
  if (!start) return false;
  if (object(JSON.parse(start.data)).turnId !== ctx.turnId) return true;
  // Iterate only this agent's model-context projection, never its access.fact history.
  const rows = log.dbHandle
    .prepare(
      "SELECT c.from_seq,c.superseded,c.item,l.data FROM agent_context c CROSS JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.from_seq>? AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' ORDER BY c.idx DESC",
    )
    .all(ctx.sessionId, ctx.agentId, start.seq, ctx.agentId) as {
    from_seq: number;
    superseded: number;
    item: string;
    data: string;
  }[];
  let inspectedSeq = -1;
  for (const row of rows) {
    const shown = object(JSON.parse(row.item)),
      recorded = object(JSON.parse(row.data));
    const result = object(recorded.result),
      data = object(result.data),
      marker = object(data.__hostFinalizationConflict);
    if (
      (recorded.toolName === "deliver" || recorded.toolName === "present") &&
      recorded.status === "error" &&
      result.status === "error" &&
      marker.version === 1 &&
      marker.kind === "state_changed" &&
      marker.turnId === ctx.turnId
    )
      return inspectedSeq <= row.from_seq;
    if (
      row.superseded === 0 &&
      recorded.toolName === "deliver" &&
      recorded.status === "ok" &&
      result.status === "ok" &&
      data.action === "inspect" &&
      shown.isError !== true &&
      shown.toolName === "deliver" &&
      shown.toolCallId === recorded.toolCallId &&
      JSON.stringify(shown.output) ===
        JSON.stringify(capToolOutput(result as ToolResult, row.from_seq))
    )
      inspectedSeq = Math.max(inspectedSeq, row.from_seq);
  }
  return false;
}

const fingerprint = (state: HarnessDeliveryState) =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex");
const physicalLocation = (location: HarnessCheckReceipt["findings"][number]["location"]) =>
  location && {
    path: location.path,
    sheet: location.sheet,
    worksheetRow: location.worksheetRow,
    column: location.column,
  };
const visibleBinding = (binding: HarnessBinding) => ({
  path: binding.path,
  sheet: binding.sheet,
  range: binding.range,
  ...(binding.expectedAbsent
    ? { expectedAbsent: true, historicalInputSha256: binding.sha256 }
    : { sha256: binding.sha256 }),
});
const visibleArtifacts = (state: HarnessDeliveryState) =>
  state.artifacts.map((artifact) => ({
    id: artifact.id,
    taskId: artifact.taskId,
    toolCallId: artifact.toolCallId,
    path: artifact.path,
    effect: artifact.effect,
    execution: artifact.execution,
    persistence: artifact.persistence,
    validation: artifact.validation,
    ...(artifact.effect === "format"
      ? { validationScope: "persisted_structure_and_presentation_only" }
      : {}),
    docId: artifact.docId,
    revision: artifact.revision,
    sha256: artifact.sha256,
    planVersion: artifact.planVersion,
    footprintCount: artifact.footprint.length,
    dependencyGapCount: artifact.dependencyGaps?.length ?? 0,
    bindings: artifact.bindings.map(visibleBinding),
    ...(artifact.capture ? { capture: artifact.capture } : {}),
  }));
const visibleFindings = (check: HarnessCheckReceipt) =>
  check.findings.map((finding) => ({
    code: finding.code,
    location: physicalLocation(finding.location),
    sourceLocation: physicalLocation(finding.sourceLocation),
    actual: finding.actual,
    expected: finding.expected,
    expectedBasis:
      check.assurance === "source_derived" &&
      (finding.code === "LINEAGE_ANCHOR_MISMATCH" || finding.code === "LOOKUP_VALUE_MISMATCH") &&
      finding.sourceLocation?.column
        ? "source"
        : check.assurance === "structural"
          ? "host_contract"
          : "declared_check_parameter",
  }));
const visibleChecks = (
  state: Pick<HarnessDeliveryState, "checks">,
  selected?: ReadonlySet<string>,
) =>
  state.checks.map((check) => ({
    id: check.id,
    taskId: check.taskId,
    status: check.status,
    purpose: check.purpose,
    assurance: check.assurance,
    ...(check.planId === "host.byte_transfer"
      ? { validationScope: "byte_identical_transfer_only" }
      : {}),
    ...((check.status === "passed" || check.status === "failed") &&
    (!selected || selected.has(check.id))
      ? {
          bindings: check.bindings.map(visibleBinding),
          findings: visibleFindings(check),
          failedCount: check.failedCount,
          unverifiedCount: check.unverifiedCount,
          uncoveredFieldCount: check.uncoveredFields.length,
          findingsTruncated: check.findingsTruncated,
        }
      : { dataSuppressed: true }),
  }));
const currentBindings = (state: HarnessDeliveryState) => [
  ...state.artifacts
    .filter((artifact) => artifact.persistence === "saved" && artifact.validation !== "stale")
    .flatMap((artifact) => [
      ...artifact.bindings,
      ...(artifact.sha256
        ? [
            {
              path: artifact.path,
              docId: artifact.docId,
              rev: artifact.revision,
              sha256: artifact.sha256,
            },
          ]
        : []),
    ]),
  ...state.checks
    .filter((check) => check.status === "passed" || check.status === "failed")
    .flatMap((check) => check.bindings),
];
const limitationText = {
  declared_scope_only: "检查只覆盖已声明且实际读取的来源和字段，不证明所有自然语言要求均已被声明。",
  query_alias_not_unit: "查询列名是实际查询的别名，不认证业务含义、单位或原始行完整性。",
  saved_not_business_verified: "文件已保存只表示持久化事实，不等于业务检查通过或外链已经刷新。",
};

type CatalogKind = "factSets" | "artifacts" | "checks";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function catalogItem(kind: CatalogKind, value: { id: string }): { id: string } {
  if (JSON.stringify(value).length <= 2500) return value;
  const item = object(value);
  return {
    id: value.id,
    kind,
    contentHash: digest({ kind, value }),
    detailSuppressed: true,
    ...Object.fromEntries(
      [
        "field",
        "path",
        "taskId",
        "effect",
        "execution",
        "persistence",
        "validation",
        "status",
        "purpose",
        "assurance",
        "revision",
        "sha256",
      ]
        .filter((key) => typeof item[key] === "string" || typeof item[key] === "number")
        .map((key) => [
          key,
          typeof item[key] === "string" ? (item[key] as string).slice(0, 300) : item[key],
        ]),
    ),
  } as { id: string };
}
function accessIdentity(log: SessionLog, ctx: ToolContext) {
  return digest(
    ctx.access?.binding() ??
      currentToolAccess()?.binding() ??
      (ctx.turnId
        ? turnAccessBinding(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId)
        : undefined) ??
      null,
  );
}
export function catalogScopeIdentity(log: SessionLog, ctx: ToolContext, taskId: string) {
  return digest({
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    turnId: ctx.turnId,
    taskId,
    access: accessIdentity(log, ctx),
  });
}
function catalogIdentity(
  log: SessionLog,
  ctx: ToolContext,
  state: HarnessDeliveryState,
  facts: unknown,
) {
  const binding =
    ctx.access?.binding() ??
    currentToolAccess()?.binding() ??
    (ctx.turnId
      ? turnAccessBinding(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId)
      : undefined);
  return digest({
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    turnId: ctx.turnId,
    binding,
    state,
    facts,
  });
}
function catalogEvidenceEpoch(
  log: SessionLog,
  ctx: ToolContext,
  state: HarnessDeliveryState,
  facts: unknown[],
) {
  const semanticFacts = facts.map((value) => {
    const { id: _issuedId, sourceToolCallId: _issuedCall, ...semantic } = object(value);
    return digest(semantic);
  });
  return digest({
    scopeId: catalogScopeIdentity(log, ctx, state.taskId),
    state,
    facts: [...new Set(semanticFacts)].sort(),
  });
}
function catalogPage(
  state: HarnessDeliveryState,
  facts: { id: string }[],
  catalogId: string,
  scopeId: string,
  evidenceEpoch: string,
  turnId: string | undefined,
  offset: number,
): ToolResult {
  const entries = (["factSets", "artifacts", "checks"] as const).flatMap((kind) =>
    (kind === "factSets"
      ? facts
      : kind === "artifacts"
        ? visibleArtifacts(state)
        : visibleChecks(state)
    ).map((value) => ({ kind, value: catalogItem(kind, value) })),
  );
  if (offset > entries.length) return rejected("交付目录分页位置无效，请重新 inspect。");
  const data = {
    action: "inspect",
    taskId: state.taskId,
    turnId,
    catalogId,
    scopeId,
    evidenceEpoch,
    offset,
    factSets: [] as { id: string }[],
    artifacts: [] as { id: string }[],
    checks: [] as { id: string }[],
    allowedOutcomes: state.allowedOutcomes,
    unverifiedObligationCount: state.unverifiedObligations.length,
    totalItems: entries.length,
    nextOffset: undefined as number | undefined,
  };
  for (let i = offset; i < entries.length; i++) {
    const entry = entries[i]!;
    data[entry.kind].push(entry.value);
    data.nextOffset = i + 1 < entries.length ? i + 1 : undefined;
    if (JSON.stringify({ status: "ok", data }).length >= 12000) {
      data[entry.kind].pop();
      data.nextOffset = i;
      break;
    }
  }
  return { status: "ok", data };
}
/** Only authentic, still-visible current-turn typed catalog entries confer selection. */
function wasInspected(
  log: SessionLog,
  ctx: ToolContext,
  kind: CatalogKind,
  current: { id: string },
  catalogId: string,
  scopeId: string,
  evidenceEpoch: string,
): "current" | "stale" | "invalid" {
  const rows = log.dbHandle
    .prepare(
      "SELECT c.from_seq,c.item,l.data FROM agent_context c CROSS JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' AND json_extract(c.item,'$.toolName') IN ('deliver','workbook_check') ORDER BY c.idx DESC",
    )
    .all(ctx.sessionId, ctx.agentId, ctx.agentId) as {
    from_seq: number;
    item: string;
    data: string;
  }[];
  let stale = false;
  for (const row of rows) {
    const shown = object(JSON.parse(row.item)),
      recorded = object(JSON.parse(row.data));
    const output = object(shown.output),
      result = object(recorded.result);
    if (
      shown.isError === true ||
      (recorded.toolName !== "deliver" && recorded.toolName !== "workbook_check") ||
      shown.toolName !== recorded.toolName ||
      shown.toolCallId !== recorded.toolCallId ||
      !["ok", "partial"].includes(String(recorded.status)) ||
      result.status !== recorded.status ||
      output.status !== recorded.status
    )
      continue;
    if (
      JSON.stringify(shown.output) !==
      JSON.stringify(capToolOutput(result as ToolResult, row.from_seq))
    )
      continue;
    const visible = object(output.data),
      actual = object(result.data);
    if (recorded.toolName === "workbook_check") {
      if (kind !== "checks") continue;
      const stamp = object(actual.evidenceScope);
      if (
        stamp.scopeId !== scopeId ||
        stamp.turnId !== ctx.turnId ||
        !Array.isArray(actual.checks) ||
        !Array.isArray(visible.checks)
      )
        continue;
      const raw = actual.checks.find(
        (value) =>
          object(value).id === current.id &&
          (visible.checks as unknown[]).some(
            (item) => JSON.stringify(item) === JSON.stringify(value),
          ),
      );
      const parsed = ReceiptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.taskId !== stamp.taskId) continue;
      const mapped = visibleChecks({ checks: [parsed.data] })[0]!;
      if (JSON.stringify(catalogItem(kind, mapped)) === JSON.stringify(catalogItem(kind, current)))
        return "current";
      stale = true;
      continue;
    }
    if (
      recorded.status !== "ok" ||
      actual.action !== "inspect" ||
      visible.action !== "inspect" ||
      actual.scopeId !== scopeId ||
      actual.turnId !== ctx.turnId ||
      typeof actual.catalogId !== "string"
    )
      continue;
    if (!Array.isArray(actual[kind]) || !Array.isArray(visible[kind])) continue;
    const expected = JSON.stringify(catalogItem(kind, current));
    const witnessed = (actual[kind] as unknown[]).find(
      (value) =>
        object(value).id === current.id &&
        (visible[kind] as unknown[]).some((item) => JSON.stringify(item) === JSON.stringify(value)),
    );
    if (!witnessed) continue;
    if (
      (actual.evidenceEpoch === evidenceEpoch ||
        (actual.evidenceEpoch === undefined && actual.catalogId === catalogId)) &&
      JSON.stringify(witnessed) === expected
    )
      return "current";
    if (actual.catalogId !== catalogId || actual.evidenceEpoch !== evidenceEpoch) stale = true;
  }
  return stale ? "stale" : "invalid";
}

/** Preserve successful names-only observations in host-rendered answers, not model prose. */
function rootEnumerationText(log: SessionLog, ctx: ToolContext): string {
  const access = currentToolAccess();
  if (!access || !ctx.turnId || !access.binding().contractRef) return "";
  const row = log.dbHandle.prepare(
    `SELECT r.data FROM session_log r
     JOIN session_log i ON i.session_id=r.session_id AND i.agent_id=r.agent_id
       AND i.type='tool.intent' AND i.seq<r.seq
       AND json_extract(i.data,'$.toolCallId')=json_extract(r.data,'$.toolCallId')
     WHERE r.session_id=? AND r.agent_id=? AND r.type='tool.result'
       AND json_extract(r.data,'$.toolName')='find'
       AND json_extract(r.data,'$.status')='ok'
       AND json_extract(r.data,'$.result.status')='ok'
       AND json_extract(i.data,'$.toolName')='find'
       AND json_extract(i.data,'$.args.namesOnly')=1
       AND COALESCE(json_extract(i.data,'$.args.path'),'.')='.'
       AND EXISTS (SELECT 1 FROM session_log f
         WHERE f.session_id=r.session_id AND f.agent_id=r.agent_id
           AND f.type='access.fact' AND f.seq>i.seq AND f.seq<r.seq
           AND json_extract(f.data,'$.toolCallId')=json_extract(r.data,'$.toolCallId')
           AND json_extract(f.data,'$.turnId')=?
           AND json_extract(f.data,'$.kind')='directory-enumeration'
           AND json_extract(f.data,'$.path')='.'
           AND json_extract(f.data,'$.outcome')='succeeded')
     ORDER BY r.seq DESC LIMIT 1`,
  ).get(ctx.sessionId, ctx.agentId, ctx.turnId) as { data: string } | undefined;
  if (!row) return "";
  const data = object(object(JSON.parse(row.data)).result).data;
  const observation = object(data);
  if (!Array.isArray(observation.entries)) return "";
  const names = observation.entries.map(entry => object(entry).path);
  if (!names.every((name): name is string => typeof name === "string")) return "";
  // Reuse the exact confirmed-root identity/permission guard; no child metadata or content reads.
  const current = new Set(listWorkspaceRootNamesSync(access.workspaceRoot));
  if (names.some(name => !current.has(name)))
    throw new Error("根目录枚举结果已变化，请重新枚举后交付。");
  return `工作区根目录名称枚举结果（${observation.truncated === true ? "当前返回页，尚有未展示条目" : "本次查询返回的条目"}）：\n${names.length ? names.map(name => "- " + JSON.stringify(name)).join("\n") : "无匹配条目。"}`;
}

function renderState(
  state: HarnessDeliveryState,
  outcome: FinalizeArgs["outcome"],
  selected: ReadonlySet<string>,
): string {
  const outcomes = {
    completed: "任务已完成。",
    findings: "调查已完成，以下保留实际发现。",
    partial: "任务部分完成，仍有未解决事项。",
    blocked: "任务受阻，未宣称完成。",
  };
  const parts = [outcomes[outcome], "执行、保存、检查与任务结果分别报告；通过仅适用于列出的范围。"];
  if (hasHostEffectRegistrationGap(state))
    parts.push("实际效果已报告，但效果登记缺失，相关义务仍未核实，不能确认完整交付。");
  if (state.plan || state.checks.length) parts.push(limitationText.declared_scope_only);
  for (const artifact of state.artifacts) {
    parts.push(
      `文件 ${JSON.stringify(artifact.path)}：执行=${artifact.execution}；保存=${artifact.persistence}；验证=${artifact.validation}；已记录依赖缺口=${artifact.dependencyGaps?.length ?? 0}${artifact.revision === undefined ? "" : `；修订=${artifact.revision}`}${artifact.sha256 ? `；SHA256=${artifact.sha256}` : ""}。`,
    );
    if (artifact.capture)
      parts.push(
        `PNG 模式=${artifact.capture.mode}；覆盖=${artifact.capture.fullyVisible ? "complete" : "partial"}；请求范围=${artifact.capture.requestedRange}；实际可见范围=${artifact.capture.visibleRange}；源文档=${artifact.capture.sourceDocId}；源修订=${artifact.capture.sourceRevision}${artifact.capture.chart ? `；chart-only 原对象=${artifact.capture.chart.id}；对象定义SHA256=${artifact.capture.chart.definitionSha256}` : ""}。`,
      );
    if (artifact.effect === "format")
      parts.push(
        "格式类验证仅证明已持久化的结构与呈现，不证明业务规则、图表含义、批注内容真实性或既有数值正确性。",
      );
  }
  for (const check of state.checks) {
    parts.push(
      `检查回执 ${JSON.stringify(check.id)}：${check.status}；用途=${check.purpose}；保证类别=${check.assurance}。`,
    );
    if (check.planId === "host.byte_transfer")
      parts.push(
        "字节传输验证只证明目标保存的字节与移动或复制前的来源相同，不证明来源内容或整个工作簿的业务正确性。",
      );
    if (check.status !== "passed" && check.status !== "failed") {
      parts.push("当前检查未获有效验证，不复述历史原始值、计数或模型解释。");
      continue;
    }
    if (!selected.has(check.id)) {
      parts.push("该检查的完整状态已计入任务结果；未选择已查看的明细标识，不复述原始观测值。");
      continue;
    }
    parts.push(
      `已发现失败=${check.failedCount}；不可验证=${check.unverifiedCount}；实际检查来源（historicalInputSha256 仅表示移动前输入摘要）=${JSON.stringify(check.bindings.map(visibleBinding))}；未覆盖字段数=${check.uncoveredFields.length}。`,
    );
    if (check.uncoveredFields.length)
      parts.push("存在未覆盖字段；检查结论不涵盖这些字段，修复明细保留在原始检查回执中。");
    for (const finding of visibleFindings(check))
      parts.push(
        `检查观测与预期（declared_check_parameter 是声明参数，host_contract 是宿主规则，均不认证为来源单元格事实）：${JSON.stringify(finding)}`,
      );
    if (check.findingsTruncated)
      parts.push("仅展示部分反例，完整计数仍如上；未把截断反例当成全部记录。");
  }
  if (state.unverifiedObligations.length)
    parts.push(
      `仍有 ${state.unverifiedObligations.length} 项未解决或未验证义务。模型提出的义务说明不是已验证事实，不据其措辞认证完成。`,
    );
  return parts.join("\n\n");
}

async function finish(
  options: HarnessDeliveryOptions,
  ctx: ToolContext,
  args: FinalizeArgs,
  evidence: () => Promise<ToolResult | undefined>,
  initial?: HarnessDeliveryState,
  legacyAutoCards = false,
): Promise<ToolResult> {
  if (needsFreshInspection(options.log, ctx))
    return rejected(
      "上次宿主交付目录发生并发变化，请先重新 inspect；不能复用旧目录或省略标识直接重试。",
    );
  const accessBefore = accessIdentity(options.log, ctx);
  const state = initial ?? (await options.deliveryState(ctx));
  if (
    harnessProgress(options.log.dbHandle, ctx.sessionId, state.taskId).exhausted &&
    options.log.dbHandle
      .prepare(
        "WITH RECURSIVE descendants(id,status) AS (SELECT id,status FROM agents WHERE session_id=? AND parent_id=? UNION ALL SELECT a.id,a.status FROM agents a JOIN descendants d ON a.parent_id=d.id WHERE a.session_id=?) SELECT 1 FROM descendants WHERE status IN ('running','waiting') LIMIT 1",
      )
      .get(ctx.sessionId, ctx.agentId, ctx.sessionId)
  )
    return rejected("无进展止损正在等待已启动的子任务收口；此时不能发卡或提前结束整个任务。");
  if (!state.allowedOutcomes.includes(args.outcome))
    return rejected(
      "当前任务存在未通过、过期或未验证的必需输出义务，不能通过改写结果或省略引用宣称完成。请修复或交付 partial/blocked。",
    );
  const result = await evidence();
  if (result && result.status !== "ok") return result;
  const data = object(result?.data);
  if (
    (args.outcome === "completed" || args.outcome === "findings") &&
    result &&
    data.finalizationStatus !== "complete"
  )
    return rejected("真实来源或访问核验尚未完成，不能确认任务完成。");
  const files = new Map<string, Awaited<ReturnType<typeof verifiedDeliveryFile>>>();
  for (const artifact of state.artifacts) {
    if (artifact.persistence !== "saved" || artifact.validation === "stale") continue;
    const file = await verifiedDeliveryFile(options.log, options.documents, artifact.path, ctx);
    if (
      file.sha256 !== artifact.sha256 ||
      (artifact.docId !== undefined &&
        (file.docId !== artifact.docId || file.rev !== artifact.revision))
    )
      return rejected("交付文件已发生变化，请重新检查。");
    files.set(file.path, file);
  }
  for (const value of Array.isArray(data.deliveredFiles) ? data.deliveredFiles : []) {
    const expected = object(value);
    if (typeof expected.path !== "string") return rejected("文件事实缺少路径。");
    const file = await verifiedDeliveryFile(options.log, options.documents, expected.path, ctx);
    if (
      file.sha256 !== expected.sha256 ||
      file.rev !== expected.rev ||
      file.docId !== expected.docId
    )
      return rejected("数值来源文件已发生变化，请重新检查。");
    files.set(file.path, file);
  }
  const after = await options.deliveryState(ctx);
  if (fingerprint(after) !== fingerprint(state) || !after.allowedOutcomes.includes(args.outcome))
    return stateChanged("交付核验期间来源、文件、权限或检查状态改变，请重新检查交付目录。");
  const dependencies = Array.isArray(data.sourceDependencies)
    ? (data.sourceDependencies as NumericSource[])
    : [];
  assertDeliveryBindings(
    options.documents,
    [
      ...currentBindings(after),
      ...dependencies.map((source) => ({
        path: source.path,
        docId: source.docId,
        rev: source.rev,
        sha256: source.sourceFile.currentSha256,
      })),
      ...[...files.values()].map((file) => ({
        path: file.path,
        ...(file.docId ? { docId: file.docId } : {}),
        ...(file.rev === undefined ? {} : { rev: file.rev }),
        sha256: file.sha256,
      })),
    ],
    ctx,
  );
  const selectedChecks = new Set([
    ...(args.checkIds ?? []),
    ...(args.explanations ?? []).flatMap((item) =>
      item.kind === "rule" || item.kind === "finding" ? [item.checkId] : [],
    ),
  ]);
  const conciseReadonly = args.outcome === "completed" &&
    after.artifacts.length === 0 && after.checks.length === 0 &&
    after.unverifiedObligations.length === 0 && typeof data.answerText === "string";
  const text = conciseReadonly ? [data.answerText as string] : [
    renderState(after, args.outcome, selectedChecks),
    typeof data.finalText === "string" ? data.finalText : "",
    rootEnumerationText(options.log, ctx),
  ];
  for (const item of conciseReadonly ? [] : args.explanations ?? []) {
    if (
      item.kind === "limitation" &&
      (item.code !== "declared_scope_only" || (!after.plan && !after.checks.length))
    )
      text.push(limitationText[item.code]);
    if (item.kind === "method")
      text.push("计算方法与实际来源随所选事实列出；表达式执行成功不是业务规则独立验证。");
    if (item.kind === "rule")
      text.push(
        "规则引用仅标识以上实际运行的检查及其用途，不将模型提出的需求解释认证为用户原文或业务证明。",
      );
  }
  const selectedPaths = new Set(
    after.artifacts
      .filter((artifact) => args.artifactIds?.includes(artifact.id))
      .map((artifact) => artifact.path),
  );
  const deliveredFiles = [...files.values()].filter(
    (file) => legacyAutoCards || selectedPaths.has(file.path),
  );
  ctx.signal.throwIfAborted();
  if (accessBefore !== accessIdentity(options.log, ctx))
    return stateChanged("交付期间授权发生变化，请重新 inspect。");
  for (const file of deliveredFiles)
    assertDeliveryArtifactAllowed(
      file.path,
      ctx.access?.binding() ??
        turnAccessBinding(options.log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId ?? "legacy"),
    );
  if (deliveredFiles.length)
    options.log.append(
      ctx.sessionId,
      ctx.agentId,
      deliveredFiles.map((file) => ({
        type: "ui.present" as const,
        data: {
          kind: "file" as const,
          path: file.path,
          note: `已保存文件 · SHA256 ${file.sha256}；验证状态见任务回执。${after.artifacts
            .filter((a) => a.path === file.path && a.capture)
            .map(
              (a) =>
                ` PNG 模式=${a.capture!.mode}；覆盖=${a.capture!.fullyVisible ? "complete" : "partial"}；请求范围=${a.capture!.requestedRange}；实际可见范围=${a.capture!.visibleRange}${a.capture!.chart ? `；chart-only 原对象=${a.capture!.chart.id}；对象定义SHA256=${a.capture!.chart.definitionSha256}` : ""}。`,
            )
            .join("")}`,
        },
      })),
    );
  return {
    status: "ok",
    data: {
      outcome: args.outcome,
      finalizationStatus:
        args.outcome === "completed" || args.outcome === "findings" ? "complete" : "incomplete",
      finalText: text.filter(Boolean).join("\n\n"),
      ...(conciseReadonly ? { auditText: data.finalText } : {}),
      artifacts: visibleArtifacts(after),
      checks: visibleChecks(after, selectedChecks),
      unverifiedObligationCount: after.unverifiedObligations.length,
      deliveredFiles,
    },
  };
}

/** Hidden historical calls traverse the identical whole-task guard and numeric provenance path. */
export async function finalizeLegacyHarness(
  options: HarnessDeliveryOptions,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = numericFinalization.safeParse(args);
  if (!parsed.success) return rejected("历史交付参数无效。");
  try {
    return await finish(
      options,
      ctx,
      { action: "finalize", outcome: parsed.data.status === "complete" ? "completed" : "partial" },
      () =>
        finalizeNumeric(options.log, options.documents, parsed.data, ctx, { suppressCards: true }),
      undefined,
      true,
    );
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      throw error;
    return rejected(error instanceof Error ? error.message : "交付核验失败。");
  }
}

export function harnessDeliveryTool(options: HarnessDeliveryOptions): ToolDefinition {
  return {
    name: "deliver",
    title: "交付结果",
    description:
      "先完成任务需要的全部计算事实（包括要求的分组与总体），再 inspect→finalize；当前证据已齐时直接收尾，不为同一已回答问题继续探查。确实缺少事实时可继续查询，新证据产生后重新 inspect，不能复用旧目录。inspect 返回有界类型化目录页；用 catalogId 和 nextOffset 继续 inspect，单项过大时返回宿主摘要。finalize 必须显式 artifactIds 选择发卡文件（空数组不发卡），只引用当前目录标识并选择任务结果；宿主重验所有依赖和整项任务义务后生成结果。未通过的必需输出检查不能改称 findings；源诊断发现可在任务允许时作为 findings 完成。不得填写数值、标签、单位、指针或自由说明。只读查询会按所选 SQL 结果逐行直接给出结论；查询请使用用户能理解的列别名和分组标签（优先用户原文），不要使用缩写别名或猜测单位。",
    input: HarnessDeliveryInput,
    inputJsonSchema: z.toJSONSchema(HarnessDeliveryInput, { io: "input" }),
    output: z.unknown(),
    effect: "interactive",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    finalizesTurn: (args) => object(args).action === "finalize",
    isHostFinalizationConflict,
    finalReply: (_args, result) =>
      result.status === "ok" && typeof object(result.data).finalText === "string"
        ? (object(result.data).finalText as string)
        : undefined,
    async execute(raw, ctx) {
      const parsed = HarnessDeliveryInput.safeParse(raw);
      if (!parsed.success)
        return rejected("交付仅接受 inspect 或由可见目录标识组成的 finalize，不能提交自由内容。");
      try {
        const args = parsed.data,
          state = await options.deliveryState(ctx);
        const facts = await numericFactSets(options.log, options.documents, ctx);
        ctx.signal.throwIfAborted();
        const catalogId = catalogIdentity(options.log, ctx, state, facts);
        const scopeId = catalogScopeIdentity(options.log, ctx, state.taskId);
        const evidenceEpoch = catalogEvidenceEpoch(options.log, ctx, state, facts);
        if (args.action === "inspect") {
          const after = await options.deliveryState(ctx);
          if (fingerprint(after) !== fingerprint(state))
            return stateChanged("生成交付目录期间来源、权限或检查发生变化，请重新 inspect。");
          assertDeliveryBindings(
            options.documents,
            [
              ...currentBindings(after),
              ...facts.flatMap((fact) =>
                fact.provenance.map((source) => ({
                  path: source.path,
                  docId: source.docId,
                  rev: source.rev,
                  sha256: source.sourceFile.currentSha256,
                })),
              ),
            ],
            ctx,
          );
          if (catalogIdentity(options.log, ctx, after, facts) !== catalogId)
            return stateChanged("生成交付目录期间授权发生变化，请重新 inspect。");
          if (args.catalogId !== undefined && args.catalogId !== catalogId)
            return stateChanged("交付目录已过期，请从首个 inspect 页面重新获取。");
          if ((args.offset ?? 0) > 0 && !args.catalogId)
            return rejected("后续目录页必须提供 catalogId。");
          return catalogPage(
            after,
            facts,
            catalogId,
            scopeId,
            evidenceEpoch,
            ctx.turnId,
            args.offset ?? 0,
          );
        }
        if (
          harnessProgress(options.log.dbHandle, ctx.sessionId, state.taskId).exhausted &&
          (args.outcome === "completed" || args.outcome === "findings")
        )
          return rejected("宿主已检测到无进展，只能诚实交付 partial 或 blocked。");
        if (state.artifacts.length && args.artifactIds === undefined)
          return rejected("请显式提供 artifactIds 选择交付文件；空数组表示不发文件卡。");
        const factIds = [
          ...new Set([
            ...(args.factSetIds ?? []),
            ...(args.explanations ?? []).flatMap((item) =>
              item.kind === "method" ? [item.factSetId] : [],
            ),
          ]),
        ];
        const checkIds = [
          ...new Set([
            ...(args.checkIds ?? []),
            ...(args.explanations ?? []).flatMap((item) =>
              item.kind === "rule" || item.kind === "finding" ? [item.checkId] : [],
            ),
          ]),
        ];
        let catalogStale = false;
        for (const [kind, ids, available] of [
          ["factSets", factIds, facts],
          ["artifacts", args.artifactIds ?? [], visibleArtifacts(state)],
          ["checks", checkIds, visibleChecks(state)],
        ] as const) {
          for (const id of ids) {
            const current = available.find((value) => value.id === id);
            const inspected = current
              ? wasInspected(options.log, ctx, kind, current, catalogId, scopeId, evidenceEpoch)
              : "invalid";
            if (inspected === "stale") catalogStale = true;
            if (inspected === "invalid")
              return rejected(
                "所选标识尚未在当前可见交付目录中出现，或已过期、不可用；请先 inspect 并重新获取所需来源。",
              );
          }
        }
        if (catalogStale)
          return needsFreshInspection(options.log, ctx)
            ? rejected("上次交付冲突后必须重新 inspect，不能复用旧目录。")
            : stateChanged("交付核验期间来源、文件、权限或检查状态改变，请重新检查交付目录。");
        if (
          (args.outcome === "completed" || args.outcome === "findings") &&
          !factIds.length &&
          ctx.turnId &&
          numericDeliveryState(options.log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId)
            .required
        )
          return rejected("本轮需报告的数值结果尚未引用当前事实集；请先读取结果并 inspect。");
        return await finish(
          options,
          ctx,
          args,
          () =>
            factIds.length
              ? finalizeNumericFactSets(options.log, options.documents, factIds, ctx)
              : Promise.resolve(undefined),
          state,
        );
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
          throw error;
        return rejected(error instanceof Error ? error.message : "交付核验失败。");
      }
    },
  };
}
