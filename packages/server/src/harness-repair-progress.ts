import { indexToCol, parseRange } from "@excelmanus/core";
import { stableHarnessHash } from "@excelmanus/kernel";
import type {
  HarnessArtifactReceipt,
  HarnessBinding,
  HarnessCheckReceipt,
  HarnessEvent,
} from "@excelmanus/protocol";

const scope = (b: HarnessBinding) => ({
  path: b.path,
  docId: b.docId,
  sheet: b.sheet,
  range: b.range,
  authorizationKey: b.authorizationKey,
  expectedAbsent: b.expectedAbsent,
});
const ordered = (values: unknown[]) =>
  values.sort((a, b) => stableHarnessHash(a).localeCompare(stableHarnessHash(b)));
const scopes = (receipt: HarnessCheckReceipt) => ordered(receipt.bindings.map(scope));
const location = (value: HarnessCheckReceipt["findings"][number]["location"]) => {
  if (!value) return undefined;
  const { domainId: _alias, ...physical } = value;
  return physical;
};
function failureKey(receipt: HarnessCheckReceipt): string {
  return stableHarnessHash({
    taskId: receipt.taskId,
    obligationId: receipt.obligationId,
    definitionHash: receipt.definitionHash,
    semanticRuleKey: receipt.semanticRuleKey,
    scope: scopes(receipt),
    findings: ordered(
      receipt.findings.map((f) => ({
        code: f.code,
        location: location(f.location),
        sourceLocation: location(f.sourceLocation),
        actual: f.actual,
        expected: f.expected,
      })),
    ),
  });
}
function contains(footprint: string, sheet: string, range: string): boolean {
  try {
    const outer = parseRange(footprint),
      inner = parseRange(range);
    return (
      outer.sheet === sheet &&
      (!inner.sheet || inner.sheet === sheet) &&
      outer.startRow <= inner.startRow &&
      outer.endRow >= inner.endRow &&
      outer.startCol <= inner.startCol &&
      outer.endCol >= inner.endCol
    );
  } catch {
    return false;
  }
}
/**
 * Bounded host evidence of a repair opportunity, not a general business-causality proof.
 * All inputs are host receipts, never model claims. Caller must perform its final current-binding
 * sweep before calling. Keys grant at most one retry per structured failure; no debt is removed.
 */
export function resolvedFailureKeys(input: {
  history: readonly HarnessEvent[];
  receipts: readonly HarnessCheckReceipt[];
  artifacts: readonly HarnessArtifactReceipt[];
  allBindingsCurrent: boolean;
}): string[] {
  if (!input.allBindingsCurrent) return [];
  const keys = new Set<string>();
  for (let i = 0; i < input.history.length; i++) {
    const event = input.history[i];
    if (event?.kind !== "check") continue;
    const old = event.check;
    if (
      old.status !== "failed" ||
      old.purpose !== "required_output" ||
      old.assurance === "unsupported" ||
      !old.semanticRuleKey ||
      old.findingsTruncated ||
      old.failedCount < 1 ||
      !old.findings.length ||
      old.unverifiedCount > 0
    )
      continue;
    for (const current of input.receipts) {
      if (
        current.status !== "passed" ||
        current.purpose !== "required_output" ||
        current.assurance === "unsupported" ||
        current.failedCount !== 0 ||
        current.unverifiedCount !== 0 ||
        current.findingsTruncated ||
        current.taskId !== old.taskId ||
        current.obligationId !== old.obligationId ||
        current.definitionHash !== old.definitionHash ||
        current.semanticRuleKey !== old.semanticRuleKey ||
        stableHarnessHash(scopes(current)) !== stableHarnessHash(scopes(old))
      )
        continue;
      const repairs = input.artifacts.filter(
        (effect) =>
          effect.taskId === old.taskId &&
          effect.effect === "data" &&
          effect.execution === "succeeded" &&
          effect.persistence === "saved" &&
          Boolean(effect.sha256) &&
          current.coveredEffectIds?.includes(effect.id) &&
          input.history
            .slice(i + 1)
            .some(
              (e) =>
                e.kind === "artifact" &&
                e.artifact.id === effect.id &&
                e.artifact.taskId === effect.taskId &&
                e.artifact.sha256 === effect.sha256,
            ),
      );
      // Require each reported physical failure location to have a covered, changed, saved data
      // effect. Missing/opaque locations are deliberately not promoted into repair credit.
      const covered = old.findings.every((f) => {
        const loc = f.location;
        if (
          !loc ||
          !loc.column ||
          !loc.worksheetRow ||
          !loc.worksheetColumn ||
          !Number.isInteger(loc.worksheetColumn) ||
          loc.worksheetColumn < 1 ||
          loc.worksheetColumn > 16384
        )
          return false;
        return current.bindings.some((binding) => {
          if (binding.path !== loc.path || binding.sheet !== loc.sheet || binding.expectedAbsent)
            return false;
          const previous = old.bindings.find(
            (b) => stableHarnessHash(scope(b)) === stableHarnessHash(scope(binding)),
          );
          if (!previous || previous.sha256 === binding.sha256) return false;
          const matched = (current.coveredCells ?? []).filter(
            (cell) => cell.domainId === binding.domainId && cell.column === loc.column,
          );
          const match = matched[0];
          if (
            matched.length !== 1 ||
            !match ||
            match.worksheetColumn !== loc.worksheetColumn ||
            !match.worksheetRows.includes(loc.worksheetRow!)
          )
            return false;
          const range = indexToCol(loc.worksheetColumn!) + loc.worksheetRow;
          if (
            !binding.range ||
            !binding.sheet ||
            !contains(
              "'" + binding.sheet.replaceAll("'", "''") + "'!" + binding.range.replace(/^.*!/, ""),
              binding.sheet,
              range,
            )
          )
            return false;
          return repairs.some(
            (effect) =>
              effect.path === binding.path &&
              effect.sha256 === binding.sha256 &&
              (!binding.docId || effect.docId === binding.docId) &&
              effect.footprint.some((part) => contains(part, binding.sheet!, range)),
          );
        });
      });
      if (covered) keys.add(failureKey(old));
    }
  }
  return [...keys].sort();
}
