import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { harnessState, harnessTaskId } from "../src/harness-state.ts";
const opened: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  db.exec(
    "CREATE TABLE session_log(seq INTEGER PRIMARY KEY,session_id TEXT,agent_id TEXT,type TEXT,data TEXT)",
  );
  return {
    db,
    add(event: unknown, agent = "main") {
      db.prepare(
        "INSERT INTO session_log(session_id,agent_id,type,data) VALUES('s',?,'harness.event',?)",
      ).run(agent, JSON.stringify(event));
    },
  };
}
const binding = { path: "out.xlsx", sha256: "a".repeat(64), authorizationKey: "auth" };
const check = {
  kind: "legacy_rules",
  obligationId: "identity",
  requirement: "身份完整",
  purpose: "required_output",
  sourceIds: [],
  target: "out",
  config: { checks: [] },
};
const plan = {
  id: "p1",
  version: 1,
  taskId: "s:main:t1",
  hash: "h1",
  sources: [],
  outputs: [{ id: "out", path: "out.xlsx", sheet: "Data", range: "A1:B3", headerRows: [1] }],
  checks: [check],
  unverifiedObligations: [],
  bindings: [],
  createdAt: "2026-10-22T00:00:00.000Z",
};
const artifact = {
  id: "a1",
  taskId: plan.taskId,
  toolCallId: "w1",
  path: "out.xlsx",
  effect: "data",
  execution: "succeeded",
  persistence: "saved",
  revision: 1,
  sha256: "a".repeat(64),
  footprint: ["Data!A1:B3"],
  validation: "unverified",
  bindings: [binding],
};
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    taskId: plan.taskId,
    planId: "p1",
    planVersion: 1,
    obligationId: "identity",
    definitionHash: "def1",
    purpose: "required_output",
    status: "failed",
    assurance: "source_derived",
    bindings: [binding],
    findings: [],
    coveredDomains: ["out"],
    uncoveredFields: [],
    failedCount: 1,
    unverifiedCount: 0,
    findingsTruncated: false,
    ...overrides,
  };
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
describe("log-backed harness task state", () => {
  it("uses the authenticated origin task across descendants", () => {
    expect(
      harnessTaskId({
        sessionId: "s",
        agentId: "child",
        turnId: "ct",
        originAgentId: "main",
        originTurnId: "t1",
      }),
    ).toBe("s:main:t1");
  });
  it("gates nonnumeric data effects even without a plan", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.required).toBe(true);
    expect(state.allowedOutcomes).not.toContain("completed");
    expect(state.unverifiedObligations.length).toBeGreaterThan(0);
  });
  it("inherits failed required obligations across plans, renamed outputs and agents", () => {
    const f = fixture();
    f.add({ kind: "plan", plan });
    f.add({ kind: "artifact", artifact });
    f.add({ kind: "check", check: receipt() });
    f.add(
      {
        kind: "plan",
        plan: {
          ...plan,
          id: "p2",
          hash: "h2",
          checks: [],
          outputs: [{ ...plan.outputs[0], path: "clean.xlsx" }],
        },
      },
      "child",
    );
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.checks.some((c) => c.id === "c1")).toBe(true);
    expect(state.allowedOutcomes).not.toContain("findings");
    expect(state.allowedOutcomes).not.toContain("completed");
  });
  it("does not let a new definition or purpose downgrade erase failed required output", () => {
    const f = fixture();
    f.add({ kind: "plan", plan });
    f.add({ kind: "check", check: receipt() });
    f.add({
      kind: "check",
      check: receipt({
        id: "c2",
        definitionHash: "shrunken",
        status: "passed",
        purpose: "diagnostic",
      }),
    });
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.allowedOutcomes).not.toContain("completed");
  });
  it("repairs the same obligation only with a later actual pass of its definition", () => {
    const f = fixture();
    f.add({ kind: "plan", plan });
    f.add({ kind: "check", check: receipt() });
    f.add({ kind: "check", check: receipt({ id: "c2", status: "passed", failedCount: 0 }) });
    expect(harnessState(f.db, "s", plan.taskId).checks).toHaveLength(1);
    expect(harnessState(f.db, "s", plan.taskId).checks[0]?.id).toBe("c2");
  });
  it("allows source-only findings without manufacturing a clean source", () => {
    const f = fixture();
    f.add({
      kind: "plan",
      plan: { ...plan, outputs: [], checks: [{ ...check, purpose: "diagnostic", target: "raw" }] },
    });
    f.add({ kind: "check", check: receipt({ purpose: "diagnostic" }) });
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.allowedOutcomes).toContain("findings");
    expect(state.allowedOutcomes).not.toContain("completed");
  });
  it("does not expose a different authenticated user task or require basic chat delivery", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    expect(harnessState(f.db, "s", "s:main:t2")).toMatchObject({
      required: false,
      artifacts: [],
      checks: [],
    });
  });
  it("never lets a same-path formatting receipt erase an unresolved data effect", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    f.add({
      kind: "artifact",
      artifact: {
        ...artifact,
        id: "a2",
        toolCallId: "w2",
        effect: "format",
        revision: 2,
        validation: "passed",
      },
    });
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.allowedOutcomes).not.toContain("completed");
    expect(state.unverifiedObligations.length).toBeGreaterThan(0);
  });
  it.each(["structure", "copy", "move", "export"])(
    "does not wash immutable data effects with a passed %s artifact",
    (effect) => {
      const f = fixture();
      f.add({ kind: "artifact", artifact });
      f.add(
        { kind: "artifact", artifact: { ...artifact, id: "a2", effect, validation: "passed" } },
        "child",
      );
      f.add(
        {
          kind: "artifact",
          artifact: {
            ...artifact,
            id: "a3",
            path: "clean.xlsx",
            effect: "format",
            validation: "passed",
          },
        },
        "child",
      );
      expect(harnessState(f.db, "s", plan.taskId).allowedOutcomes).not.toContain("completed");
    },
  );
  it("rejects arbitrary same-file local check pass without actual effect coverage", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    f.add({ kind: "check", check: receipt({ status: "passed", failedCount: 0 }) });
    expect(harnessState(f.db, "s", plan.taskId).allowedOutcomes).not.toContain("completed");
  });
  it("retains the original actual read dependency gaps after later metadata and unrelated coverage", () => {
    const f = fixture();
    f.add({
      kind: "artifact",
      artifact: {
        ...artifact,
        dependencyGaps: ["ACTUAL_READ_DEPENDENCY_UNBOUND"],
        bindings: [binding, { ...binding, path: "A.xlsx" }],
      },
    });
    f.add({
      kind: "artifact",
      artifact: { ...artifact, id: "a2", effect: "format", validation: "passed" },
    });
    f.add({
      kind: "check",
      check: receipt({
        status: "passed",
        failedCount: 0,
        coveredEffectIds: ["a1"],
        bindings: [binding, { ...binding, path: "B.xlsx" }],
      }),
    });
    const state = harnessState(f.db, "s", plan.taskId);
    expect(state.allowedOutcomes).not.toContain("completed");
    expect(state.unverifiedObligations.join(" ")).toContain("实际读取依赖");
  });
  it("historical effect refresh never replaces the later artifact at the same path", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    f.add({
      kind: "artifact",
      artifact: {
        ...artifact,
        id: "a2",
        effect: "format",
        validation: "passed",
        sha256: "b".repeat(64),
      },
    });
    f.add({
      kind: "artifact",
      artifact: { ...artifact, dependencyGaps: ["ACTUAL_READ_DEPENDENCY_STALE"] },
    });
    expect(harnessState(f.db, "s", plan.taskId).artifacts[0]?.id).toBe("a2");
  });
  it("requires every effect ID and a current target binding, not any one covered effect", () => {
    const f = fixture();
    f.add({ kind: "artifact", artifact });
    f.add({ kind: "artifact", artifact: { ...artifact, id: "a2", footprint: ["Data!D1:D3"] } });
    f.add({
      kind: "check",
      check: receipt({ status: "passed", failedCount: 0, coveredEffectIds: ["a2"] }),
    });
    expect(harnessState(f.db, "s", plan.taskId).allowedOutcomes).not.toContain("completed");
    f.add({
      kind: "check",
      check: receipt({ status: "passed", failedCount: 0, coveredEffectIds: ["a1", "a2"] }),
    });
    expect(harnessState(f.db, "s", plan.taskId).allowedOutcomes).toContain("completed");
    f.add({
      kind: "artifact",
      artifact: {
        ...artifact,
        id: "a3",
        effect: "format",
        validation: "passed",
        sha256: "b".repeat(64),
      },
    });
    expect(harnessState(f.db, "s", plan.taskId).allowedOutcomes).not.toContain("completed");
  });
});
