import { stableHarnessHash } from "@excelmanus/kernel";
import type { HarnessPlan } from "@excelmanus/protocol";

type Declaration = Pick<HarnessPlan, "sources" | "outputs" | "checks" | "unverifiedObligations">;
/** Bump whenever supported checker semantics change. No natural-language equivalence. */
export const CHECKER_SEMANTICS_VERSION = 1;
/** Host rule identity excludes display aliases and consumption strength, never checker semantics. */
export function semanticRuleKey(plan: Declaration, check: Declaration["checks"][number]): string {
  const { obligationId: _id, requirement: _text, purpose: _purpose, ...rule } = check;
  const domains = new Map([...plan.sources, ...plan.outputs].map(({id, ...domain}) => [id, domain]));
  const resolved = { ...rule } as Record<string, unknown>;
  for (const field of ["target", "sourceId", "dictionary"]) {
    const value = resolved[field];
    if (typeof value === "string" && domains.has(value)) resolved[field] = domains.get(value);
  }
  return stableHarnessHash({ checkerVersion: CHECKER_SEMANTICS_VERSION, rule: resolved });
}
/** Equality for bounded retry accounting only, never authorizes execution/cache reuse. */
export function semanticAttemptKey(plan: Declaration): string {
  const domains = (items: Declaration["sources"]) => items.map(({id:_id,...domain})=>domain)
    .sort((a,b)=>stableHarnessHash(a).localeCompare(stableHarnessHash(b)));
  return stableHarnessHash({
    checkerVersion:CHECKER_SEMANTICS_VERSION, sources:domains(plan.sources), outputs:domains(plan.outputs),
    rules:plan.checks.map(check=>semanticRuleKey(plan,check)).sort(),
  });
}
export function semanticPlanKey(plan: Declaration): string | undefined {
  const withoutId = ({ id: _id, ...domain }: Declaration["sources"][number]) => domain;
  const domains = new Map([...plan.sources, ...plan.outputs].map(d => [d.id, withoutId(d)]));
  const checks: unknown[] = [];
  for (const check of plan.checks) {
    const { obligationId: _id, requirement: _text, ...definition } = check;
    if (check.kind === "typed_lookup" && !check.eventScope) {
      if (!domains.has(check.dictionary) || !domains.has(check.target)) return undefined;
      checks.push({ ...definition, dictionary: domains.get(check.dictionary), target: domains.get(check.target) });
    } else if (check.kind === "typed_aggregate") {
      if (!domains.has(check.sourceId) || !domains.has(check.target)) return undefined;
      checks.push({ ...definition, sourceId: domains.get(check.sourceId), target: domains.get(check.target) });
    } else {
      // Domain IDs can be actual lineage cell values; legacy source strings also have
      // their own meaning. Do not normalize those adapters by recursive text replacement.
      return undefined;
    }
  }
  if (!checks.length) return undefined;
  const ordered = (values: unknown[]) => values.sort((a,b)=>stableHarnessHash(a).localeCompare(stableHarnessHash(b)));
  return stableHarnessHash({
    checkerVersion: CHECKER_SEMANTICS_VERSION,
    sources: ordered(plan.sources.map(withoutId)),
    outputs: ordered(plan.outputs.map(withoutId)),
    checks: ordered(checks),
    unverifiedObligations: plan.unverifiedObligations,
  });
}
