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
