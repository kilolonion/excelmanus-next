import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  HarnessArtifactReceipt,
  HarnessCheckReceipt,
  HarnessDeliveryState,
  HarnessEvent,
  HarnessPlan,
  SourceCheckDeclaration,
} from "@excelmanus/protocol";
export function harnessTaskId(input: {
  sessionId: string;
  agentId: string;
  turnId: string;
  originAgentId?: string;
  originTurnId?: string;
}): string {
  return [
    input.sessionId,
    input.originAgentId ?? input.agentId,
    input.originTurnId ?? input.turnId,
  ].join(":");
}
export function stableHarnessHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function harnessCheckDefinitionHash(
  plan: Pick<HarnessPlan, "sources" | "outputs">,
  check: SourceCheckDeclaration,
): string {
  const { requirement: _quotedInterpretation, ...definition } = check;
  return stableHarnessHash({ definition, sources: plan.sources, outputs: plan.outputs });
}
export function harnessEvents(db: DatabaseSync, sessionId: string, taskId: string): HarnessEvent[] {
  const rows = db
    .prepare(
      "SELECT data FROM session_log WHERE session_id=? AND type='harness.event' ORDER BY seq",
    )
    .all(sessionId) as { data: string }[];
  return rows.flatMap((row) => {
    try {
      const e = JSON.parse(row.data) as HarnessEvent;
      const own =
        e.kind === "plan"
          ? e.plan
          : e.kind === "artifact"
            ? e.artifact
            : e.kind === "check"
              ? e.check
              : undefined;
      return own?.taskId === taskId ? [e] : [];
    } catch {
      return [];
    }
  });
}
export function harnessState(
  db: DatabaseSync,
  sessionId: string,
  taskId: string,
): HarnessDeliveryState {
  const events = harnessEvents(db, sessionId, taskId),
    plans = new Map<string, HarnessPlan>(),
    artifacts = new Map<string, HarnessArtifactReceipt>(),
    history = new Map<string, HarnessArtifactReceipt>(),
    checks = new Map<string, HarnessCheckReceipt>(),
    semanticGaps = new Map<string, HarnessArtifactReceipt>();
  for (const e of events) {
    if (e.kind === "plan") plans.set(e.plan.id + ":" + e.plan.version, e.plan);
    if (e.kind === "artifact") {
      history.set(e.artifact.id, e.artifact);
      if (e.artifact.effect !== "format" && e.artifact.persistence !== "not_written")
        semanticGaps.set(e.artifact.id, e.artifact);
    }
    if (e.kind === "check") {
      const key = e.check.obligationId + ":" + e.check.definitionHash;
      const previous = checks.get(key);
      checks.set(
        key,
        previous?.purpose === "required_output"
          ? { ...e.check, purpose: "required_output" }
          : e.check,
      );
    }
  }
  // Updating an old receipt must not reorder its original effect or replace a later target receipt.
  for (const a of history.values()) artifacts.set(a.path, a);
  const ps = [...plans.values()],
    as = [...artifacts.values()],
    cs = [...checks.values()],
    gaps = new Set<string>();
  for (const p of ps) {
    if (!p.checks.length) gaps.add("计划未声明任何可执行检查：" + p.id + ":" + p.version);
    for (const output of p.outputs)
      if (!p.checks.some((c) => c.target === output.id)) gaps.add("输出域缺少检查：" + output.id);
    for (const gap of p.unverifiedObligations) gaps.add(gap);
    for (const c of p.checks) {
      if (
        !cs.some(
          (r) =>
            r.planId === p.id && r.planVersion === p.version && r.obligationId === c.obligationId,
        ) &&
        !cs.some(
          (r) =>
            r.obligationId === c.obligationId &&
            r.definitionHash === harnessCheckDefinitionHash(p, c),
        )
      )
        gaps.add("未执行声明检查：" + c.obligationId);
    }
  }
  const repaired = (a: HarnessArtifactReceipt) =>
    cs.some(
      (c) =>
        c.status === "passed" &&
        c.purpose === "required_output" &&
        c.repairedEffectIds?.includes(a.id) &&
        c.coveredEffectIds?.includes(a.id) &&
        c.bindings.some((b) => b.path === a.path && b.sha256 === artifacts.get(a.path)?.sha256),
    );
  for (const a of history.values())
    if (a.persistence !== "not_written" && a.dependencyGaps?.length && !repaired(a))
      gaps.add("实际读取依赖尚未完整绑定：" + a.id + " (" + a.path + ")");
  for (const a of as) {
    if (a.persistence !== "saved") gaps.add("文件尚未确认保存：" + a.path);
    if (a.execution !== "succeeded") gaps.add("文件执行结果未完整确认：" + a.path);
    if (a.effect === "format" && a.validation !== "passed")
      gaps.add("格式变更缺少当前结构校验：" + a.path);
  }
  for (const [effectId, effect] of semanticGaps) {
    const current = artifacts.get(effect.path);
    if (
      !cs.some(
        (c) =>
          c.purpose === "required_output" &&
          c.status === "passed" &&
          c.coveredEffectIds?.includes(effectId) &&
          c.bindings.some((b) => b.path === effect.path && b.sha256 === current?.sha256),
      )
    )
      gaps.add("数据变更仍缺少当前范围校验：" + effectId + " (" + effect.path + ")");
  }
  const requiredFailure = cs.some((c) => c.purpose === "required_output" && c.status !== "passed"),
    unknown = cs.some((c) => c.status === "unverified" || c.status === "stale"),
    findings = cs.some((c) => c.purpose === "diagnostic" && c.status === "failed");
  const allowedOutcomes: HarnessDeliveryState["allowedOutcomes"] = ["partial", "blocked"];
  if (gaps.size === 0 && !requiredFailure && !unknown) {
    allowedOutcomes.unshift(findings ? "findings" : "completed");
    if (!findings) allowedOutcomes.push("findings");
  }
  return {
    taskId,
    required: events.length > 0,
    ...(ps.length ? { plan: ps.at(-1)! } : {}),
    artifacts: as,
    checks: cs,
    unverifiedObligations: [...gaps],
    allowedOutcomes,
  };
}
export function harnessContext(state: HarnessDeliveryState): string {
  if (!state.required) return "";
  return [
    "宿主任务状态：工具执行、文件保存与业务校验分别记录。",
    ...state.unverifiedObligations,
    ...state.checks
      .filter((c) => c.status !== "passed")
      .map((c) => "检查 " + c.obligationId + "：" + c.status + "（" + c.purpose + "）"),
    "通过 deliver.inspect 获取当前可见回执；修复 required_output 失败或缺失检查，不得改写措辞、计划或输出路径绕过。",
  ].join("\n");
}

export interface HarnessProgressEvent {
  kind: "attempt" | "termination" | "drain";
  attemptKey?: string;
  progressKey?: string;
  proofKeys?: string[];
  resolvedFailureKeys?: string[];
  nonproductivePreflight?: boolean;
}
function progressAccumulator() {
  return { attempts:new Set<string>(), proofs:new Set<string>(), repairs:new Set<string>(),
    repeated:0, invalidExplorations:0, terminationSteps:0, drainSteps:0, lastSeq:0 };
}
type ProgressAccumulator = ReturnType<typeof progressAccumulator>;
function applyProgress(state: ProgressAccumulator, event: HarnessProgressEvent) {
  if (event.kind === "termination") { state.terminationSteps++; return; }
  if (event.kind === "drain") { state.drainSteps++; return; }
  if (!event.attemptKey || !event.progressKey) return;
  let useful = false;
  for (const proof of event.proofKeys ?? [event.progressKey]) {
    if (!state.proofs.has(proof)) useful = true;
    state.proofs.add(proof);
  }
  for (const repair of event.resolvedFailureKeys ?? []) {
    if (!state.repairs.has(repair)) useful = true;
    state.repairs.add(repair);
  }
  if (useful) {
    state.repeated = 0; state.invalidExplorations = 0; state.terminationSteps = 0; state.drainSteps = 0;
  } else if (state.attempts.has(event.attemptKey)) state.repeated++;
  if (event.nonproductivePreflight) state.invalidExplorations++;
  state.attempts.add(event.attemptKey);
}
function progressView(state: ProgressAccumulator) {
  return { repeated:state.repeated, invalidExplorations:state.invalidExplorations,
    exhausted:state.repeated >= 3 || state.invalidExplorations >= 12,
    reason:state.invalidExplorations >= 12 ? "invalid_exploration_budget" : state.repeated >= 3 ? "repeated_computation" : undefined,
    terminationSteps:state.terminationSteps, drainSteps:state.drainSteps };
}
/** Completed duplicate computations and invalid exploration have distinct fixed host budgets. */
export function reduceHarnessProgress(events: readonly HarnessProgressEvent[]) {
  const state = progressAccumulator();
  for (const event of events) applyProgress(state,event);
  return progressView(state);
}
const progressCache = new WeakMap<DatabaseSync, Map<string, ProgressAccumulator>>();
export function harnessProgress(db: DatabaseSync, sessionId: string, taskId: string) {
  let cache = progressCache.get(db);
  if (!cache) { cache = new Map(); progressCache.set(db,cache); }
  const key = JSON.stringify([sessionId,taskId]);
  let state = cache.get(key);
  if (!state) {
    state = progressAccumulator();
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key,state);
  }
  const rows = db.prepare("SELECT data,seq FROM session_log WHERE session_id=? AND type='harness.progress' AND json_extract(data,'$.taskId')=? AND seq>? ORDER BY seq")
    .all(sessionId,taskId,state.lastSeq) as {seq:number;data:string}[];
  for (const row of rows) {
    applyProgress(state, JSON.parse(row.data) as HarnessProgressEvent);
    state.lastSeq = row.seq;
  }
  return progressView(state);
}
/** Monotonic certified coverage, not receipt aliases, current-set removal, or byte churn. */
export function harnessUsefulProofs(state: HarnessDeliveryState): string[] {
  const proofs = state.checks.filter(c => c.status === "passed" && c.purpose === "required_output")
    .map(c => ({
      rule:c.semanticRuleKey ?? c.definitionHash,
      assurance:c.assurance,
      bindings:c.bindings.map(({path,sheet,range,authorizationKey})=>({path,sheet,range,authorizationKey})),
      cells:c.coveredCells?.map(({domainId,...cell})=>({
        ...cell, domain:c.bindings.filter(b=>b.domainId===domainId).map(({path,sheet,range})=>({path,sheet,range})),
      })),
    })).map(stableHarnessHash);
  return [...new Set(proofs)].sort();
}
export function harnessUsefulProgress(state: HarnessDeliveryState): string {
  return stableHarnessHash(harnessUsefulProofs(state));
}
