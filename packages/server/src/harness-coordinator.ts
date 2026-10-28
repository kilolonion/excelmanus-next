import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToControlPlane } from "node:timers/promises";
import { indexToCol, parseRange } from "@excelmanus/core";
import {
  assertToolAccess,
  assertToolReadAccess,
  classifyWorkbookEffect,
  harnessCheckDefinitionHash,
  harnessEvents,
  harnessState,
  harnessTaskId,
  isInternalName,
  listCommittedCreatedDocuments,
  literalReplacementRanges,
  lookupCommittedCreatedDocument,
  lookupHostCreatedOutput,
  normalizeAccessPath,
  pathVersion,
  readVerifiedResourceSync,
  readVerifiedResourceObservationSync,
  resolveWorkspacePath,
  type SessionLog,
  sha256,
  stableHarnessHash,
  type ToolContext,
  type ToolDefinition,
  turnAccessBinding,
  withFileAccessSync,
} from "@excelmanus/kernel";
import {
  type HarnessArtifactReceipt,
  type HarnessBinding,
  type HarnessCheckReceipt,
  type HarnessDeliveryState,
  type HarnessEvent,
  HarnessPlan,
  numericReadSources,
  type SourceCheckDeclaration,
  type ToolResult,
  VerificationInput,
} from "@excelmanus/protocol";
import {
  type DocumentService,
  extractSourceCheckDomain,
  runSourceChecks,
  type SheetDomain,
} from "@excelmanus/workbook";
import { z } from "zod";
import { assertOriginalChartLineage } from "./harness-chart-lineage.ts";
import {
  CHECKER_SEMANTICS_VERSION,
  semanticPlanKey,
  semanticRuleKey,
} from "./harness-computation.ts";
import { type PreparationDiagnostic, preflightCheckFields } from "./harness-preflight.ts";
import { resolvedFailureKeys } from "./harness-repair-progress.ts";
import { assertDeliveryBindings } from "./numeric-finalizer.ts";

const hostRegistrationStates = new WeakMap<
  HarnessDeliveryState,
  {
    taskId: string;
    sessionId: string;
    sourceKeys: string[];
    fingerprint: string;
  }
>();
/** Read-only identity check; serialized/model-created state objects cannot acquire this provenance. */
export function hasHostEffectRegistrationGap(state: HarnessDeliveryState): boolean {
  const provenance = hostRegistrationStates.get(state);
  return (
    !!provenance &&
    state.taskId === provenance.taskId &&
    state.taskId.startsWith(provenance.sessionId + ":") &&
    stableHarnessHash(state) === provenance.fingerprint &&
    provenance.sourceKeys.every((key) =>
      state.checks.some(
        (check) => check.id === "hcheck_registration_" + key && check.definitionHash === key,
      ),
    )
  );
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const deny = (message: string): ToolResult => ({
  status: "error",
  error: { code: "INVALID_ARGUMENT", message, retryable: false },
});
const id = (prefix: string) => prefix + "_" + randomUUID();
const workbookPath = (p: string) => /\.(xlsx|xlsm|xls|csv|tsv)$/i.test(p);
const savedEffects = new Set([
  "workbook_edit",
  "workbook_analyze",
  "workbook_export",
  "workbook_render",
  "run_script",
  "files",
  "write",
  "edit",
]);
function contained(outer: string, inner: string): boolean {
  try {
    const a = parseRange(outer),
      b = parseRange(inner);
    return (
      (!a.sheet || !b.sheet || a.sheet === b.sheet) &&
      a.startRow <= b.startRow &&
      a.endRow >= b.endRow &&
      a.startCol <= b.startCol &&
      a.endCol >= b.endCol
    );
  } catch {
    return false;
  }
}
function physicalContainment(outer: string, inner: string): boolean {
  try {
    const a = parseRange(outer),
      b = parseRange(inner);
    return Boolean(a.sheet && b.sheet && a.sheet === b.sheet && contained(outer, inner));
  } catch {
    return false;
  }
}
function strip(input: unknown): Json {
  const { verification: _v, ...args } = obj(input);
  return args;
}
export function createHarnessCoordinator(deps: {
  db: DatabaseSync;
  log: SessionLog;
  documents: DocumentService;
  tools: Map<string, ToolDefinition>;
}) {
  const { db, log, documents } = deps;
  const legacyAnalyze = deps.tools.get("workbook_analyze");
  function rethrowCancellation(error: unknown, ctx: ToolContext): void {
    ctx.signal.throwIfAborted();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      throw error;
  }
  async function cooperate(ctx: ToolContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await yieldToControlPlane();
    ctx.signal.throwIfAborted();
  }
  async function bindingsCurrent(bindings: HarnessBinding[], ctx: ToolContext): Promise<boolean> {
    let current = true;
    for (const b of bindings) {
      await cooperate(ctx);
      if (!(await isCurrent(b, ctx))) current = false;
      ctx.signal.throwIfAborted();
    }
    return current;
  }
  function task(ctx: ToolContext) {
    const turnId = ctx.turnId ?? "legacy";
    const binding =
      ctx.access?.binding() ?? turnAccessBinding(db, ctx.sessionId, ctx.agentId, turnId);
    return harnessTaskId({
      ...ctx,
      turnId,
      ...(binding
        ? { originAgentId: binding.originAgentId, originTurnId: binding.originTurnId }
        : {}),
    });
  }
  function auth(ctx: ToolContext) {
    const binding =
      ctx.access?.binding() ??
      turnAccessBinding(db, ctx.sessionId, ctx.agentId, ctx.turnId ?? "legacy");
    return stableHarnessHash(
      binding
        ? {
            originAgentId: binding.originAgentId,
            originTurnId: binding.originTurnId,
            decision: binding.decision,
          }
        : { legacy: true, sessionId: ctx.sessionId },
    );
  }
  function append(ctx: ToolContext, event: HarnessEvent) {
    log.append(ctx.sessionId, ctx.agentId, [{ type: "harness.event", data: event }]);
  }
  function currentPlan(ctx: ToolContext) {
    return harnessState(db, ctx.sessionId, task(ctx)).plan;
  }
  function normalizedReads(raw: unknown): Json[] {
    const r = obj(raw),
      parts = numericReadSources(r);
    return parts
      ? parts.map((p) => ({ ...p, ...(typeof r.sheet === "string" ? { sheet: r.sheet } : {}) }))
      : [{ ...r, unsupportedRead: true }];
  }
  function readsOf(result: ToolResult, toolName: string): Json[] {
    const data = obj(result.data),
      reads: Json[] = [];
    const direct = numericReadSources({
      ...data,
      toolName,
      docRevs: result.docRevs ?? data.docRevs,
    });
    if (direct) reads.push(...(direct as unknown as Json[]));
    for (const raw of array(obj(data.provenance).reads)) reads.push(...normalizedReads(raw));
    return reads;
  }
  function visibleReads(ctx: ToolContext): Json[] {
    const rows = db
      .prepare(
        "SELECT c.item,l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result'",
      )
      .all(ctx.sessionId, ctx.agentId, ctx.agentId) as { item: string; data: string }[];
    const reads: Json[] = [];
    for (const row of rows) {
      try {
        const visible = obj(JSON.parse(row.item)),
          record = obj(JSON.parse(row.data));
        const result = obj(record.result) as ToolResult,
          output = obj(visible.output) as ToolResult;
        if (
          record.status !== "ok" ||
          result.status !== "ok" ||
          output.status !== "ok" ||
          visible.isError === true ||
          visible.toolName !== record.toolName
        )
          continue;
        const actual = readsOf(result, String(record.toolName)),
          shown = readsOf(output, String(record.toolName));
        if (stableHarnessHash(actual) === stableHarnessHash(shown)) reads.push(...actual);
      } catch {
        /* invalid historical receipts are not evidence */
      }
    }
    return reads;
  }
  async function binding(
    path: string,
    ctx: ToolContext,
    domain?: { id: string; sheet: string; range: string },
    rawBytesOnly = false,
  ): Promise<HarnessBinding> {
    assertToolAccess(path, ctx.workspaceRoot);
    const p = resolveWorkspacePath(ctx.workspaceRoot, path);
    if (workbookPath(p.rel))
      documents.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, { path: p.rel });
    if (workbookPath(p.rel) && !rawBytesOnly) {
      const { meta } = await documents.open(ctx.workspaceId, ctx.workspaceRoot, p.rel);
      const state = await documents.sourceStatus(meta.id, ctx.workspaceRoot);
      const current = documents.meta(meta.id);
      if (
        !current ||
        current.externalConflict ||
        current.checkpointError ||
        current.checkpointRev !== current.rev ||
        state.pendingWrite ||
        state.calculation === "computed-in-memory-not-persisted"
      )
        throw new Error("PENDING_OR_UNPERSISTED_SOURCE");
      return {
        path: p.rel,
        docId: meta.id,
        rev: meta.rev,
        savedRev: meta.rev,
        sha256: state.currentSha256,
        authorizationKey: auth(ctx),
        ...(domain ? { domainId: domain.id, sheet: domain.sheet, range: domain.range } : {}),
      };
    }
    const bytes = withFileAccessSync(
      { kind: "file-bytes", path: p.abs, purpose: "harness-saved-read" },
      () => readFileSync(p.abs),
    );
    return {
      path: p.rel,
      sha256: sha256(bytes),
      authorizationKey: auth(ctx),
      ...(domain ? { domainId: domain.id, sheet: domain.sheet, range: domain.range } : {}),
    };
  }
  async function byteProducerBinding(path: string, ctx: ToolContext) {
    const canonical = resolveWorkspacePath(ctx.workspaceRoot, path).rel;
    const registered = db
      .prepare("SELECT id FROM documents WHERE workspace_id=? AND path=?")
      .get(ctx.workspaceId, canonical);
    return binding(canonical, ctx, undefined, !registered);
  }
  async function isCurrent(b: HarnessBinding, ctx: ToolContext) {
    try {
      if (b.authorizationKey !== auth(ctx)) return false;
      if (b.expectedAbsent) {
        assertToolAccess(b.path, ctx.workspaceRoot);
        const p = resolveWorkspacePath(ctx.workspaceRoot, b.path);
        try {
          withFileAccessSync(
            { kind: "file-metadata", path: p.abs, purpose: "harness-move-source-absence" },
            () => lstatSync(p.abs),
          );
          return false;
        } catch (e) {
          return obj(e).code === "ENOENT";
        }
      }
      const now = await binding(b.path, ctx, undefined, !b.docId);
      return now.sha256 === b.sha256 && now.rev === b.rev && now.savedRev === b.savedRev;
    } catch (error) {
      rethrowCancellation(error, ctx);
      return false;
    }
  }
  function artifactHistory(ctx: ToolContext): HarnessArtifactReceipt[] {
    const byId = new Map<string, HarnessArtifactReceipt>();
    for (const e of harnessEvents(db, ctx.sessionId, task(ctx)))
      if (e.kind === "artifact") byId.set(e.artifact.id, e.artifact);
    return [...byId.values()];
  }
  async function scopedContains(
    docId: string | undefined,
    outer: { range: string; sheet?: string },
    inner: { range: string; sheet?: string },
    ctx: ToolContext,
  ): Promise<boolean> {
    if (!docId) return false;
    try {
      const { snapshot } = await documents.snapshot(docId, ctx.workspaceRoot);
      const resolve = (scope: { range: string; sheet?: string }) => {
        const range = parseRange(scope.range),
          selectors = [scope.sheet, range.sheet].filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          );
        if (!selectors.length) return;
        const matches = selectors.map((selector) =>
          Object.entries(snapshot.sheets).filter(
            ([id, sheet]) => id === selector || sheet.id === selector || sheet.name === selector,
          ),
        );
        if (
          matches.some((m) => m.length !== 1) ||
          matches.some((m) => m[0]![0] !== matches[0]![0]![0])
        )
          return;
        return { ...range, sheet: matches[0]![0]![0] };
      };
      const a = resolve(outer),
        b = resolve(inner);
      return (
        !!a &&
        !!b &&
        a.sheet === b.sheet &&
        a.startRow <= b.startRow &&
        a.endRow >= b.endRow &&
        a.startCol <= b.startCol &&
        a.endCol >= b.endCol
      );
    } catch (error) {
      rethrowCancellation(error, ctx);
      return false;
    }
  }
  async function captureDependencies(
    reads: Json[],
    ctx: ToolContext,
    dependencies: HarnessBinding[],
    gaps: string[],
  ) {
    for (const read of reads)
      try {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(read.path ?? "")).rel,
          file = obj(read.sourceFile);
        let captured: HarnessBinding;
        if (read.toolName === "files.readText" && typeof read.sha256 === "string") {
          captured = { path, sha256: read.sha256, authorizationKey: auth(ctx) };
          gaps.push("ACTUAL_READ_SCOPE_UNSUPPORTED");
          try {
            const now = await binding(path, ctx, undefined, true);
            if (read.staged || now.sha256 !== read.sha256)
              gaps.push("ACTUAL_READ_DEPENDENCY_STALE");
          } catch {
            gaps.push("ACTUAL_READ_DEPENDENCY_UNBOUND");
          }
        } else {
          if (
            read.unsupportedRead ||
            typeof read.docId !== "string" ||
            typeof read.rev !== "number" ||
            typeof file.currentSha256 !== "string"
          )
            throw new Error("unsupported read");
          captured = {
            path,
            docId: read.docId,
            rev: read.rev,
            savedRev: read.rev,
            sha256: file.currentSha256,
            authorizationKey: auth(ctx),
            ...(typeof obj(read.scope).range === "string"
              ? { range: String(obj(read.scope).range) }
              : {}),
            ...(typeof read.sheet === "string" ? { sheet: read.sheet } : {}),
          };
        }
        if (!dependencies.some((d) => stableHarnessHash(d) === stableHarnessHash(captured)))
          dependencies.push(captured);
      } catch {
        gaps.push("ACTUAL_READ_DEPENDENCY_UNBOUND");
      }
  }
  async function registerOrResolve(
    input: VerificationInput,
    ctx: ToolContext,
  ): Promise<HarnessPlan> {
    const parsed = VerificationInput.parse(input),
      taskId = task(ctx);
    if ("planId" in parsed) {
      const found = harnessEvents(db, ctx.sessionId, taskId).find(
        (e) =>
          e.kind === "plan" && e.plan.id === parsed.planId && e.plan.version === parsed.version,
      );
      if (found?.kind !== "plan") throw new Error("计划不存在于当前用户任务");
      return found.plan;
    }
    const old = parsed.previousPlanId
      ? harnessEvents(db, ctx.sessionId, taskId)
          .filter((e) => e.kind === "plan" && e.plan.id === parsed.previousPlanId)
          .at(-1)
      : undefined;
    if (parsed.previousPlanId && old?.kind !== "plan")
      throw new Error("不能替换其他任务或未知计划");
    const sources = parsed.sources.map((d) => ({
      ...d,
      path: resolveWorkspacePath(ctx.workspaceRoot, d.path).rel,
    }));
    const outputs = parsed.outputs.map((d) => ({
      ...d,
      path: resolveWorkspacePath(ctx.workspaceRoot, d.path).rel,
    }));
    const ids = [...sources, ...outputs].map((d) => d.id);
    if (new Set(ids).size !== ids.length) throw new Error("来源和输出域标识必须唯一");
    const checks = parsed.checks.map((c) => ({
      ...c,
      purpose: outputs.some((o) => o.id === c.target) ? ("required_output" as const) : c.purpose,
    }));
    const seen = visibleReads(ctx),
      bindings: HarnessBinding[] = [];
    for (const s of sources) {
      await cooperate(ctx);
      const b = await binding(s.path, ctx, s);
      let admitted = false;
      for (const r of seen) {
        if (
          r.path !== b.path ||
          r.docId !== b.docId ||
          r.rev !== b.rev ||
          obj(r.sourceFile).currentSha256 !== b.sha256
        )
          continue;
        if (
          obj(r.scope).kind === "document" ||
          (await scopedContains(
            b.docId,
            {
              range: String(obj(r.scope).range ?? r.range ?? ""),
              sheet: typeof r.sheet === "string" ? r.sheet : undefined,
            },
            s,
            ctx,
          ))
        ) {
          admitted = true;
          break;
        }
      }
      if (!admitted) throw new Error("来源必须先在当前可见、真实且当前的读取回执中出现：" + s.path);
      bindings.push(b);
    }
    const semanticKey = semanticPlanKey({ ...parsed, sources, outputs, checks });
    if (!parsed.previousPlanId && semanticKey) {
      const candidates = harnessEvents(db, ctx.sessionId, taskId).filter(
        (e): e is Extract<HarnessEvent, { kind: "plan" }> => e.kind === "plan",
      );
      for (const event of candidates) {
        if (semanticPlanKey(event.plan) !== semanticKey) continue;
        if (await bindingsCurrent(event.plan.bindings, ctx)) return event.plan;
      }
    }
    const plan = HarnessPlan.parse({
      ...parsed,
      sources,
      outputs,
      checks,
      id: old?.kind === "plan" ? old.plan.id : id("hplan"),
      version: old?.kind === "plan" ? old.plan.version + 1 : 1,
      taskId,
      hash: stableHarnessHash({
        sources,
        outputs,
        checks,
        unverifiedObligations: parsed.unverifiedObligations,
      }),
      bindings,
      createdAt: new Date().toISOString(),
    });
    append(ctx, { kind: "plan", plan });
    return plan;
  }
  async function domain(declaration: HarnessPlan["sources"][number], ctx: ToolContext) {
    const b = await binding(declaration.path, ctx, declaration);
    if (!b.docId) throw new Error("WORKBOOK_DOMAIN_REQUIRED");
    const { snapshot } = await documents.snapshot(b.docId, ctx.workspaceRoot);
    const extracted = extractSourceCheckDomain(snapshot, { ...declaration, path: b.path });
    return { ...extracted, binding: b };
  }
  async function prepare(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = VerificationInput.safeParse(input);
    if (!parsed.success)
      return {
        status: "ok",
        data: {
          action: "prepare",
          preparation: "invalid",
          executed: false,
          diagnostics: parsed.error.issues.map((issue) => ({
            status: "invalid",
            code: "DECLARATION_INVALID",
            path: issue.path,
            message: issue.message,
          })),
        },
      };
    let draft: HarnessPlan | Extract<VerificationInput, { sources: unknown }>;
    if ("planId" in parsed.data) {
      const reference = parsed.data;
      const event = harnessEvents(db, ctx.sessionId, task(ctx)).find(
        (e) =>
          e.kind === "plan" &&
          e.plan.id === reference.planId &&
          e.plan.version === reference.version,
      );
      if (event?.kind !== "plan")
        return {
          status: "ok",
          data: {
            action: "prepare",
            preparation: "invalid",
            executed: false,
            diagnostics: [{ status: "invalid", code: "PLAN_NOT_FOUND" }],
          },
        };
      draft = event.plan;
    } else draft = parsed.data;
    const diagnostics: PreparationDiagnostic[] = [],
      domains: SheetDomain[] = [],
      bindings: HarnessBinding[] = [];
    const all = [...draft.sources, ...draft.outputs],
      ids = all.map((d) => d.id);
    if (new Set(ids).size !== ids.length)
      diagnostics.push({ status: "invalid", code: "DUPLICATE_DOMAIN_ID" });
    const prior = artifactHistory(ctx);
    for (const d of all) {
      await cooperate(ctx);
      try {
        const x = await domain(d, ctx);
        domains.push(x.domain);
        bindings.push(x.binding);
        for (const code of x.limitations)
          diagnostics.push({
            status: /UNSUPPORTED|BUDGET|TRUNCATED/.test(code) ? "unsupported" : "invalid",
            code,
            domainId: d.id,
          });
        if (draft.sources.some((s) => s.id === d.id)) {
          const canonical = x.binding.path;
          if (
            draft.outputs.some(
              (o) => resolveWorkspacePath(ctx.workspaceRoot, o.path).rel === canonical,
            ) ||
            prior.some(
              (a) =>
                a.path === canonical && a.effect !== "format" && a.persistence !== "not_written",
            )
          )
            diagnostics.push({
              status: "unsupported",
              code: "SOURCE_NOT_INDEPENDENT",
              domainId: d.id,
            });
          let visible = false;
          for (const r of visibleReads(ctx)) {
            if (
              r.path !== canonical ||
              r.docId !== x.binding.docId ||
              r.rev !== x.binding.rev ||
              obj(r.sourceFile).currentSha256 !== x.binding.sha256
            )
              continue;
            if (
              obj(r.scope).kind === "document" ||
              (await scopedContains(
                x.binding.docId,
                {
                  range: String(obj(r.scope).range ?? r.range ?? ""),
                  sheet: typeof r.sheet === "string" ? r.sheet : undefined,
                },
                d,
                ctx,
              ))
            ) {
              visible = true;
              break;
            }
          }
          if (!visible)
            diagnostics.push({
              status: "invalid",
              code: "SOURCE_NOT_CURRENTLY_INSPECTED",
              domainId: d.id,
            });
        }
      } catch (error) {
        rethrowCancellation(error, ctx);
        diagnostics.push({
          status: "invalid",
          code: "DOMAIN_NOT_SAVED_OR_AUTHORIZED",
          domainId: d.id,
        });
      }
    }
    diagnostics.push(...preflightCheckFields(draft, domains));
    if (!draft.checks.length)
      diagnostics.push({ status: "unsupported", code: "NO_CHECKS_DECLARED" });
    for (const declaration of draft.checks) {
      if (declaration.kind !== "legacy_rules" && declaration.kind !== "source_alignment") continue;
      const target = all.find((d) => d.id === declaration.target);
      if (!target || !legacyAnalyze) continue;
      try {
        const rectangle = parseRange(target.range);
        const range =
          declaration.kind === "source_alignment"
            ? indexToCol(rectangle.startCol) +
              (rectangle.startRow + 1) +
              ":" +
              indexToCol(rectangle.endCol) +
              rectangle.endRow
            : target.range;
        const args = {
          path: target.path,
          sheet: target.sheet,
          range,
          mode: declaration.kind === "legacy_rules" ? "check" : "source_alignment",
          sources: declaration.sourceIds.map((id) => {
            const s = draft.sources.find((d) => d.id === id);
            return s ? { name: s.id, path: s.path, sheet: s.sheet, range: s.range } : {};
          }),
          ...(declaration.kind === "legacy_rules"
            ? { checks: declaration.config.checks }
            : { alignment: { ...declaration.config.alignment, headerRow: target.headerRows[0] } }),
        };
        if (!legacyAnalyze.input.safeParse(args).success)
          diagnostics.push({
            status: "invalid",
            code: "LEGACY_CONFIG_INVALID",
            obligationId: declaration.obligationId,
          });
      } catch {
        diagnostics.push({
          status: "invalid",
          code: "LEGACY_CONFIG_INVALID",
          obligationId: declaration.obligationId,
        });
      }
    }
    if (!(await bindingsCurrent(bindings, ctx)))
      diagnostics.push({ status: "invalid", code: "PREPARE_BINDINGS_CHANGED" });
    ctx.signal.throwIfAborted();
    return {
      status: "ok",
      data: {
        action: "prepare",
        preparation: diagnostics.some((d) => d.status === "invalid")
          ? "invalid"
          : diagnostics.length
            ? "unsupported"
            : "supported",
        executed: false,
        diagnostics,
      },
    };
  }

  function recordUnsupported(
    plan: HarnessPlan,
    ctx: ToolContext,
    diagnostics: unknown,
  ): ToolResult {
    const checks: HarnessCheckReceipt[] = plan.checks.map((declaration) => ({
      id: id("hcheck"),
      taskId: plan.taskId,
      planId: plan.id,
      planVersion: plan.version,
      obligationId: "host.unsupported." + declaration.obligationId,
      definitionHash: harnessCheckDefinitionHash(plan, declaration),
      purpose: plan.outputs.some((o) => o.id === declaration.target)
        ? "required_output"
        : declaration.purpose,
      status: "unverified",
      assurance: "unsupported",
      bindings: plan.bindings,
      findings: [
        { code: "PREPARATION_UNSUPPORTED", message: "声明超出当前受支持的验证范围，未执行检查。" },
      ],
      coveredDomains: [],
      uncoveredFields: [],
      failedCount: 0,
      unverifiedCount: 1,
      findingsTruncated: false,
    }));
    for (const check of checks) append(ctx, { kind: "check", check });
    return {
      status: "partial",
      data: { action: "execute", preparation: "unsupported", executed: false, diagnostics, checks },
    };
  }

  function cellKey(path: string, sheet: string, row: number, col: number) {
    return JSON.stringify([path, sheet, row, col]);
  }
  function checkedCells(outputs: SheetDomain[], checks: HarnessCheckReceipt[]): Set<string> {
    const cells = new Set<string>();
    for (const receipt of checks) {
      if (receipt.status !== "passed" || receipt.purpose !== "required_output") continue;
      for (const proof of receipt.coveredCells ?? []) {
        const domain = outputs.find((d) => d.id === proof.domainId && d.complete);
        if (!domain) continue;
        const column = domain.columnNames.indexOf(proof.column);
        if (column < 0) continue;
        const range = parseRange(domain.range);
        for (const row of proof.worksheetRows)
          if (Number.isSafeInteger(row) && row >= range.startRow && row <= range.endRow)
            cells.add(cellKey(domain.path, domain.sheet, row, range.startCol + column));
      }
    }
    return cells;
  }
  function footprintsCovered(
    effect: HarnessArtifactReceipt,
    _plan: HarnessPlan,
    outputs: SheetDomain[],
    checks: HarnessCheckReceipt[],
  ): boolean {
    if (effect.effect === "external" || !effect.footprint.length || effect.footprint.includes("*"))
      return false;
    const domains = outputs.filter((o) => o.path === effect.path && o.complete);
    if (
      !domains.length ||
      checks.some((c) => c.purpose === "required_output" && c.status !== "passed")
    )
      return false;
    const cells = checkedCells(domains, checks);
    let count = 0;
    return effect.footprint.every((fp) => {
      let r: ReturnType<typeof parseRange>;
      try {
        r = parseRange(fp);
      } catch {
        return false;
      }
      if (!r.sheet) return false;
      for (let row = r.startRow; row <= r.endRow; row++)
        for (let col = r.startCol; col <= r.endCol; col++) {
          if (++count > 200000 || !cells.has(cellKey(effect.path, r.sheet, row, col))) return false;
        }
      return true;
    });
  }
  async function check(
    plan: HarnessPlan,
    ctx: ToolContext,
    additionalReads: Json[] = [],
  ): Promise<ToolResult> {
    const receipts: HarnessCheckReceipt[] = [];
    try {
      await cooperate(ctx);
      if (plan.taskId !== task(ctx)) return deny("验证计划不属于当前用户请求");
      await recoverSqlOutputBindings(ctx);
      const sources: SheetDomain[] = [],
        outputs: SheetDomain[] = [],
        bindings: HarnessBinding[] = [],
        limitations: string[] = [];
      const checkHistory = harnessEvents(db, ctx.sessionId, plan.taskId);
      const priorEffects = checkHistory.filter(
        (e): e is Extract<HarnessEvent, { kind: "artifact" }> => e.kind === "artifact",
      );
      for (const source of plan.sources) {
        if (plan.outputs.some((output) => output.path === source.path))
          limitations.push("IN_PLACE_SOURCE_VERSION_UNAVAILABLE:" + source.id);
        if (
          priorEffects.some(
            (e) =>
              e.artifact.path === source.path &&
              e.artifact.effect !== "format" &&
              e.artifact.persistence !== "not_written",
          )
        )
          limitations.push("SOURCE_NOT_INDEPENDENT_TASK_ARTIFACT:" + source.id);
      }
      for (const declaration of [...plan.sources, ...plan.outputs]) {
        await cooperate(ctx);
        try {
          const x = await domain(declaration, ctx);
          bindings.push(x.binding);
          limitations.push(...x.limitations.map((code) => declaration.id + ":" + code));
          (plan.outputs.some((o) => o.id === declaration.id) ? outputs : sources).push(x.domain);
          const original = plan.bindings.find((b) => b.domainId === declaration.id);
          if (original && !(await isCurrent(original, ctx)))
            limitations.push("SOURCE_CHANGED:" + declaration.id);
        } catch (error) {
          rethrowCancellation(error, ctx);
          limitations.push("DOMAIN_NOT_SAVED_OR_AUTHORIZED:" + declaration.id);
        }
      }
      const semanticKey = semanticPlanKey(plan);
      const computationKey =
        semanticKey && additionalReads.length === 0 && limitations.length === 0
          ? stableHarnessHash({
              checkerVersion: CHECKER_SEMANTICS_VERSION,
              semanticKey,
              bindings,
              priorEffects,
            })
          : undefined;
      if (computationKey) {
        const current = harnessState(db, ctx.sessionId, plan.taskId);
        const cached = current.checks.filter(
          (c) =>
            c.planId === plan.id &&
            c.planVersion === plan.version &&
            c.computationKey === computationKey,
        );
        if (
          plan.checks.every((c) => cached.some((r) => r.obligationId === c.obligationId)) &&
          cached.length > 0 &&
          (await bindingsCurrent(
            cached.flatMap((c) => c.bindings),
            ctx,
          ))
        ) {
          const state = finalCurrentState(ctx);
          return {
            status: "ok",
            data: {
              planId: plan.id,
              planVersion: plan.version,
              reused: true,
              computationKey,
              checks: state.checks,
              artifacts: state.artifacts,
              unverifiedObligations: state.unverifiedObligations,
              scope: "declared domains only; not full natural-language requirement coverage",
            },
          };
        }
      }
      // Real script/query dependencies are compared before any output can be certified.
      for (const read of additionalReads) {
        await cooperate(ctx);
        const path = String(read.path ?? "");
        if (!path || read.unsupportedRead) {
          limitations.push("UNBOUND_READ_DEPENDENCY");
          continue;
        }
        try {
          const b = await binding(path, ctx);
          if (!bindings.some((x) => x.path === b.path)) bindings.push(b);
          let declared = false;
          if (obj(read.scope).kind !== "document")
            for (const d of [...plan.sources, ...plan.outputs])
              if (
                d.path === b.path &&
                (await scopedContains(
                  b.docId,
                  d,
                  {
                    range: String(obj(read.scope).range ?? read.range ?? ""),
                    sheet: typeof read.sheet === "string" ? read.sheet : undefined,
                  },
                  ctx,
                ))
              ) {
                declared = true;
                break;
              }
          if (!declared) limitations.push("UNBOUND_READ_SCOPE:" + path);
          if (read.rev !== undefined && read.rev !== b.rev)
            limitations.push("READ_REVISION_CHANGED:" + path);
        } catch (error) {
          rethrowCancellation(error, ctx);
          limitations.push("READ_NOT_CURRENT:" + path);
        }
      }
      await cooperate(ctx);
      const computed = runSourceChecks({ checks: plan.checks, sources, outputs });
      for (let index = 0; index < plan.checks.length; index++) {
        await cooperate(ctx);
        const declaration = plan.checks[index]!,
          pure = computed[index]!;
        let status: HarnessCheckReceipt["status"] = pure.status,
          assurance: HarnessCheckReceipt["assurance"] = pure.assurance,
          findings = pure.findings,
          failedCount = pure.failedCount,
          unverifiedCount = pure.unverifiedCount,
          coveredCells = pure.coveredCells ?? [];
        if (declaration.kind === "legacy_rules" || declaration.kind === "source_alignment") {
          const target = [...plan.outputs, ...plan.sources].find(
            (d) => d.id === declaration.target,
          );
          if (target && legacyAnalyze && !limitations.length) {
            try {
              const config = obj(declaration.config);
              if (
                config.saveTo !== undefined ||
                config.docId !== undefined ||
                config.path !== undefined ||
                config.sources !== undefined ||
                config.right !== undefined
              )
                throw new Error("HOST_OWNS_CHECK_IDENTITIES");
              const declaredSources = declaration.sourceIds.map((sourceId) => {
                const s = plan.sources.find((d) => d.id === sourceId);
                if (!s) throw new Error("UNBOUND_CHECK_SOURCE");
                return { name: s.id, path: s.path, sheet: s.sheet, range: s.range };
              });
              const rectangle = parseRange(target.range);
              let targetRange = target.range;
              if (declaration.kind === "source_alignment") {
                if (
                  target.headerRows.length !== 1 ||
                  target.headerRows[0] !== rectangle.startRow ||
                  rectangle.endRow <= rectangle.startRow
                )
                  throw new Error("ALIGNMENT_HEADER_BODY_LAYOUT_UNSUPPORTED");
                targetRange =
                  indexToCol(rectangle.startCol) +
                  (rectangle.startRow + 1) +
                  ":" +
                  indexToCol(rectangle.endCol) +
                  rectangle.endRow;
              }
              const args = {
                ...(declaration.kind === "legacy_rules"
                  ? { checks: config.checks }
                  : { alignment: { ...obj(config.alignment), headerRow: target.headerRows[0] } }),
                sources: declaredSources,
                path: target.path,
                sheet: target.sheet,
                range: targetRange,
                mode: declaration.kind === "legacy_rules" ? "check" : "source_alignment",
              };
              const result = await legacyAnalyze.execute(legacyAnalyze.input.parse(args), ctx),
                data = obj(result.data),
                validation = obj(data.verification ?? data.validation);
              const rules = array(data.rules ?? data.checks ?? data.results ?? validation.checks);
              const known =
                rules.length > 0 && rules.every((r) => typeof obj(r).passed === "boolean");
              status =
                result.status !== "ok"
                  ? "unverified"
                  : known
                    ? rules.every((r) => obj(r).passed === true)
                      ? "passed"
                      : "failed"
                    : validation.status === "verified"
                      ? "passed"
                      : validation.status === "failed"
                        ? "failed"
                        : "unverified";
              assurance =
                declaration.kind === "legacy_rules" ? "declared_expression" : "source_derived";
              failedCount =
                status === "failed"
                  ? Math.max(1, rules.filter((r) => obj(r).passed === false).length)
                  : 0;
              unverifiedCount = status === "unverified" ? 1 : 0;
              findings =
                status === "passed"
                  ? []
                  : [
                      {
                        code:
                          status === "failed"
                            ? "DECLARED_CHECK_FAILED"
                            : "DECLARED_CHECK_UNVERIFIED",
                        message: "现有只读校验适配器没有给出完整通过。",
                      },
                    ];
              if (status === "passed" && declaration.kind === "source_alignment") {
                const d = outputs.find((d) => d.id === target.id);
                const selectors = new Set<string>();
                for (const binding of array(obj(config.alignment).bindings)) {
                  const b = obj(binding);
                  for (const field of [
                    "referenceColumn",
                    "rowColumn",
                    "sameColumnAs",
                    "yearReferenceColumn",
                    "monthReferenceColumn",
                    "valueReferenceColumn",
                  ])
                    if (typeof b[field] === "string") selectors.add(b[field] as string);
                  for (const key of array(b.keys))
                    if (typeof obj(key).targetColumn === "string")
                      selectors.add(obj(key).targetColumn as string);
                }
                coveredCells = d
                  ? array(validation.coveredColumns)
                      .filter((c): c is string => typeof c === "string" && !selectors.has(c))
                      .map((column) => ({
                        domainId: d.id,
                        column,
                        worksheetRows: d.rows
                          .filter((r) => !d.headerRows.includes(r.worksheetRow))
                          .map((r) => r.worksheetRow),
                      }))
                  : [];
              }
            } catch (error) {
              rethrowCancellation(error, ctx);
              status = "unverified";
              unverifiedCount = 1;
            }
          }
        }
        if (limitations.length) {
          status = "unverified";
          unverifiedCount += limitations.length;
          findings = [
            ...findings,
            ...limitations.map((code) => ({ code, message: "宿主保存、读取或绑定边界未满足。" })),
          ];
        }
        receipts.push({
          id: id("hcheck"),
          taskId: plan.taskId,
          planId: plan.id,
          planVersion: plan.version,
          obligationId: declaration.obligationId,
          definitionHash: harnessCheckDefinitionHash(plan, declaration),
          purpose: plan.outputs.some((o) => o.id === declaration.target)
            ? "required_output"
            : declaration.purpose,
          status,
          assurance,
          bindings,
          findings,
          coveredDomains: pure.coveredDomains,
          coveredCells: status === "passed" ? coveredCells : [],
          uncoveredFields: pure.uncoveredFields,
          failedCount,
          unverifiedCount,
          findingsTruncated: pure.findingsTruncated,
        });
      }
      const bodyCells = checkedCells(outputs, receipts);
      for (const output of outputs) {
        if (!output.complete || output.headerRows.length !== 1) continue;
        const rectangle = parseRange(output.range),
          bodyRows = output.rows.filter((r) => !output.headerRows.includes(r.worksheetRow));
        const columns = output.columnNames.filter(
          (column, index) =>
            bodyRows.length > 0 &&
            bodyRows.every((row) =>
              bodyCells.has(
                cellKey(output.path, output.sheet, row.worksheetRow, rectangle.startCol + index),
              ),
            ),
        );
        if (columns.length)
          receipts.push({
            id: id("hcheck"),
            taskId: plan.taskId,
            planId: plan.id,
            planVersion: plan.version,
            obligationId: "host.header." + output.id,
            definitionHash: stableHarnessHash({
              kind: "saved_header_structure",
              output: plan.outputs.find((d) => d.id === output.id),
            }),
            purpose: "required_output",
            status: "passed",
            assurance: "structural",
            bindings,
            findings: [],
            coveredDomains: [output.id],
            coveredCells: columns.map((column) => ({
              domainId: output.id,
              column,
              worksheetRows: output.headerRows,
            })),
            uncoveredFields: output.columnNames.filter((c) => !columns.includes(c)),
            failedCount: 0,
            unverifiedCount: 0,
            findingsTruncated: false,
          });
      }
      const covered: string[] = [],
        repaired: string[] = [],
        history = artifactHistory(ctx);
      for (const effect of history) {
        await cooperate(ctx);
        const dependencies = effect.bindings.filter((b) => b.path !== effect.path);
        if (
          effect.persistence !== "saved" ||
          effect.execution !== "succeeded" ||
          effect.dependencyGaps?.length ||
          !footprintsCovered(effect, plan, outputs, receipts)
        )
          continue;
        let allDependenciesBound = true;
        for (const b of dependencies) {
          let bound = false;
          for (const s of plan.sources)
            if (
              s.path === b.path &&
              (!b.range ||
                (await scopedContains(b.docId, s, { range: b.range, sheet: b.sheet }, ctx)))
            ) {
              bound = true;
              break;
            }
          if (!bound) {
            allDependenciesBound = false;
            break;
          }
        }
        if (!allDependenciesBound) continue;
        if (!(await bindingsCurrent(dependencies, ctx))) continue;
        covered.push(effect.id);
        for (const dependency of dependencies)
          if (!bindings.some((b) => stableHarnessHash(b) === stableHarnessHash(dependency)))
            bindings.push(dependency);
      }
      for (let i = 0; i < history.length; i++) {
        const old = history[i]!;
        if (covered.includes(old.id) || !old.footprint.length || old.footprint.includes("*"))
          continue;
        if (
          history
            .slice(i + 1)
            .some(
              (replacement) =>
                replacement.path === old.path &&
                replacement.effect === "data" &&
                covered.includes(replacement.id) &&
                old.footprint.every((range) =>
                  replacement.replacesDataRanges?.some((full) => physicalContainment(full, range)),
                ),
            )
        ) {
          covered.push(old.id);
          repaired.push(old.id);
        }
      }
      // The second full dependency sweep closes source changes during asynchronous extraction.
      const allCurrent = await bindingsCurrent(bindings, ctx);
      for (const receipt of receipts) {
        const physicalColumn = (domainId: string, column: string | undefined) => {
          const value = [...sources, ...outputs].find((domain) => domain.id === domainId);
          if (!value || column === undefined) return undefined;
          const indices = value.columnNames.flatMap((name, index) =>
            name === column ? [index] : [],
          );
          return indices.length === 1 ? parseRange(value.range).startCol + indices[0]! : undefined;
        };
        for (const finding of receipt.findings)
          for (const location of [finding.location, finding.sourceLocation])
            if (location)
              location.worksheetColumn = physicalColumn(location.domainId, location.column);
        for (const cell of receipt.coveredCells ?? [])
          cell.worksheetColumn = physicalColumn(cell.domainId, cell.column);
        if (!allCurrent) {
          receipt.status = "stale";
          receipt.coveredEffectIds = [];
          receipt.repairedEffectIds = [];
        } else if (receipt.status === "passed" && receipt.purpose === "required_output") {
          receipt.coveredEffectIds = covered;
          receipt.repairedEffectIds = repaired;
        }
        const declaration = plan.checks.find(
          (check) => check.obligationId === receipt.obligationId,
        );
        if (declaration) receipt.semanticRuleKey = semanticRuleKey(plan, declaration);
        if (computationKey && allCurrent) receipt.computationKey = computationKey;
        append(ctx, { kind: "check", check: receipt });
      }
      await deliveryState(ctx);
      const state = finalCurrentState(ctx);
      const repairedFailures = resolvedFailureKeys({
        history: checkHistory,
        receipts: state.checks.filter((check) =>
          receipts.some((receipt) => receipt.id === check.id),
        ),
        artifacts: state.artifacts,
        allBindingsCurrent: allCurrent && (await bindingsCurrent(bindings, ctx)),
      });
      return {
        status: "ok",
        data: {
          resolvedFailureKeys: repairedFailures,
          planId: plan.id,
          planVersion: plan.version,
          ...(computationKey ? { computationKey } : {}),
          checks: state.checks,
          artifacts: state.artifacts,
          unverifiedObligations: state.unverifiedObligations,
          scope: "declared domains only; not full natural-language requirement coverage",
        },
      };
    } catch (error) {
      if (
        ctx.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        // Only receipts from this unfinished attempt lose certification. Earlier evidence is retained.
        for (const receipt of receipts)
          append(ctx, {
            kind: "check",
            check: {
              ...receipt,
              status: "unverified",
              findings: [],
              coveredDomains: [],
              coveredCells: [],
              coveredEffectIds: [],
              repairedEffectIds: [],
              failedCount: 0,
              unverifiedCount: Math.max(1, receipt.unverifiedCount),
              findingsTruncated: false,
            },
          });
      }
      throw error;
    }
  }
  type RegistrationSource = {
    agentId: string;
    turnId: string;
    stepId: string;
    toolCallId: string;
    intentSeq: number;
    docId?: string;
    revision?: number;
    path: string;
    kind: "committed" | "published_partial";
    resultSeq?: number;
  };
  function producerBoundary(source: RegistrationSource, ctx: ToolContext): number {
    const row = db
      .prepare(
        "SELECT MIN(seq) AS seq FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND (type='step.started' OR (type='tool.intent' AND json_extract(data,'$.toolCallId')=?) OR (type IN ('turn.completed','turn.failed','turn.interrupted') AND json_extract(data,'$.turnId')=?))",
      )
      .get(ctx.sessionId, source.agentId, source.intentSeq, source.toolCallId, source.turnId) as {
      seq: number | null;
    };
    return row.seq ?? Number.MAX_SAFE_INTEGER;
  }
  function hasRegisteredEffect(source: RegistrationSource, ctx: ToolContext): boolean {
    const rows = db
      .prepare(
        "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND seq<? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' ORDER BY seq",
      )
      .all(
        ctx.sessionId,
        source.agentId,
        source.intentSeq,
        producerBoundary(source, ctx),
      ) as Array<{ seq: number; data: string }>;
    return rows.some((row) => {
      const artifact = obj(obj(JSON.parse(row.data)).artifact);
      if (
        artifact.taskId !== task(ctx) ||
        artifact.toolCallId !== source.toolCallId ||
        artifact.path !== source.path ||
        (source.docId !== undefined && artifact.docId !== source.docId) ||
        (source.revision !== undefined && artifact.revision !== source.revision)
      )
        return false;
      if (typeof artifact.id !== "string" || !artifact.id)
        throw new Error("EFFECT_REGISTRATION_ID_INVALID");
      const first = db
        .prepare(
          "SELECT MIN(seq) AS seq FROM session_log WHERE session_id=? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.artifact.id')=?",
        )
        .get(ctx.sessionId, artifact.id) as { seq: number | null };
      return first.seq === row.seq;
    });
  }
  function partialCreateSources(ctx: ToolContext): RegistrationSource[] {
    const ref = ctx.access?.binding().contractRef;
    if (!ref) return [];
    const rows = db
      .prepare(
        "SELECT seq,agent_id,data FROM session_log WHERE session_id=? AND type='tool.result' AND json_extract(data,'$.toolName')='workbook_edit' AND json_extract(data,'$.result.status')='partial' ORDER BY seq LIMIT 1001",
      )
      .all(ctx.sessionId) as Array<{ seq: number; agent_id: string; data: string }>;
    if (rows.length > 1000) throw new Error("CREATE_PARTIAL_SCAN_INCOMPLETE");
    const sources: RegistrationSource[] = [];
    for (const row of rows) {
      const record = obj(JSON.parse(row.data)),
        result = obj(record.result),
        data = obj(result.data);
      if (
        data.registration !== "incomplete" ||
        !Array.isArray(data.published) ||
        !data.published.length
      )
        continue;
      if (typeof record.toolCallId !== "string" || !record.toolCallId)
        throw new Error("CREATE_PARTIAL_CALL_INVALID");
      const intents = db
        .prepare(
          "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND seq<? AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 2",
        )
        .all(ctx.sessionId, row.agent_id, row.seq, record.toolCallId) as Array<{
        seq: number;
        data: string;
      }>;
      if (!intents.length) throw new Error("CREATE_PARTIAL_INTENT_MISSING");
      const intent = obj(JSON.parse(intents[0]!.data)),
        args = obj(intent.args);
      if (
        typeof intent.stepId !== "string" ||
        !intent.stepId ||
        (intents[1] && obj(JSON.parse(intents[1].data)).stepId === intent.stepId)
      )
        throw new Error("CREATE_PARTIAL_INTENT_AMBIGUOUS");
      if (intent.toolName !== "workbook_edit" || args.create !== true || args.dryRun === true)
        continue;
      const step = db
        .prepare(
          "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='step.started' AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(ctx.sessionId, row.agent_id, intents[0]!.seq) as { data: string } | undefined;
      const started = step ? obj(JSON.parse(step.data)) : {};
      if (started.stepId !== intent.stepId || typeof started.turnId !== "string" || !started.turnId)
        throw new Error("CREATE_PARTIAL_STEP_INVALID");
      const origin = turnAccessBinding(
        db,
        ctx.sessionId,
        row.agent_id,
        started.turnId,
      )?.contractRef;
      if (!origin) throw new Error("CREATE_PARTIAL_ORIGIN_MISSING");
      if (stableHarnessHash(origin) !== stableHarnessHash(ref)) continue;
      if (typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256))
        throw new Error("CREATE_PARTIAL_PUBLICATION_INVALID");
      const source = {
        agentId: row.agent_id,
        turnId: started.turnId,
        stepId: intent.stepId,
        toolCallId: record.toolCallId,
        intentSeq: intents[0]!.seq,
        kind: "published_partial" as const,
        resultSeq: row.seq,
      };
      const boundary = producerBoundary({ ...source, path: "" }, ctx);
      const latest = db
        .prepare(
          "SELECT MAX(seq) AS seq FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.result' AND seq>? AND seq<? AND json_extract(data,'$.toolCallId')=?",
        )
        .get(ctx.sessionId, row.agent_id, source.intentSeq, boundary, source.toolCallId) as {
        seq: number | null;
      };
      if (row.seq >= boundary || latest.seq !== row.seq) continue;
      for (const path of data.published) {
        if (
          typeof path !== "string" ||
          normalizeAccessPath(path) !== path ||
          path.split("/").some(isInternalName)
        )
          throw new Error("CREATE_PARTIAL_PUBLICATION_PATH_INVALID");
        sources.push({ ...source, path });
      }
    }
    return sources;
  }
  function ensureRegistrationObligations(ctx: ToolContext): string[] {
    if (!ctx.access?.binding().contractRef) return [];
    const committed = listCommittedCreatedDocuments({
      db,
      workspaceId: ctx.workspaceId,
      root: ctx.workspaceRoot,
    });
    const sources: RegistrationSource[] = [
      ...committed.map((proof) => ({
        agentId: proof.agentId,
        turnId: proof.turnId,
        stepId: proof.stepId,
        toolCallId: proof.toolCallId,
        intentSeq: proof.intentSeq,
        docId: proof.docId,
        revision: proof.revision,
        path: proof.path,
        kind: "committed" as const,
      })),
      ...partialCreateSources(ctx),
    ];
    const missing: string[] = [];
    for (const source of sources) {
      if (hasRegisteredEffect(source, ctx)) continue;
      const key = stableHarnessHash({
        sessionId: ctx.sessionId,
        taskId: task(ctx),
        contractRef: ctx.access!.binding().contractRef,
        ...source,
      });
      missing.push(key);
      const check: HarnessCheckReceipt = {
        id: "hcheck_registration_" + key,
        taskId: task(ctx),
        planId: "host.effect_registration",
        planVersion: 1,
        obligationId: "host.effect_registration." + key,
        definitionHash: key,
        purpose: "required_output",
        status: "unverified",
        assurance: "unsupported",
        bindings: [],
        coveredDomains: [],
        coveredEffectIds: [],
        uncoveredFields: [],
        failedCount: 0,
        unverifiedCount: 1,
        findingsTruncated: false,
        findings: [
          {
            code: "EFFECT_REGISTRATION_MISSING",
            message: "实际效果来源可关联，但效果登记缺失，相关义务仍未核实，不能确认完整交付。",
          },
        ],
      };
      const prior = db
        .prepare(
          "SELECT data FROM session_log WHERE session_id=? AND type='harness.event' AND json_extract(data,'$.kind')='check' AND (json_extract(data,'$.check.id')=? OR (json_extract(data,'$.check.obligationId')=? AND json_extract(data,'$.check.definitionHash')=?)) ORDER BY seq",
        )
        .all(ctx.sessionId, check.id, check.obligationId, key) as Array<{ data: string }>;
      if (
        prior.some(
          (row) => stableHarnessHash(obj(JSON.parse(row.data)).check) !== stableHarnessHash(check),
        )
      )
        throw new Error("EFFECT_REGISTRATION_CHECK_CONFLICT");
      if (!prior.length) append(ctx, { kind: "check", check });
    }
    return missing;
  }

  function finalCurrentState(ctx: ToolContext): HarnessDeliveryState {
    ctx.signal.throwIfAborted();
    const registrationKeys = ensureRegistrationObligations(ctx);
    const current = (bindings: HarnessBinding[]): boolean => {
      if (bindings.some((binding) => binding.authorizationKey !== auth(ctx))) return false;
      try {
        assertDeliveryBindings(documents, bindings, ctx);
        ctx.signal.throwIfAborted();
        return true;
      } catch (error) {
        rethrowCancellation(error, ctx);
        return false;
      }
    };
    const state = harnessState(db, ctx.sessionId, task(ctx));
    for (const check of state.checks) {
      if (check.status !== "stale" && current(check.bindings)) continue;
      if (
        check.status === "stale" &&
        !check.findings.length &&
        !check.coveredDomains.length &&
        !check.coveredCells?.length &&
        !check.coveredEffectIds?.length &&
        !check.repairedEffectIds?.length
      )
        continue;
      append(ctx, {
        kind: "check",
        check: {
          ...check,
          status: "stale",
          findings: [],
          coveredDomains: [],
          coveredCells: [],
          coveredEffectIds: [],
          repairedEffectIds: [],
          failedCount: 0,
          unverifiedCount: 1,
          findingsTruncated: false,
        },
      });
    }
    for (const artifact of artifactHistory(ctx)) {
      if (
        artifact.persistence === "not_written" ||
        artifact.dependencyGaps?.includes("ACTUAL_READ_DEPENDENCY_STALE")
      )
        continue;
      if (!current(artifact.bindings.filter((binding) => binding.path !== artifact.path)))
        append(ctx, {
          kind: "artifact",
          artifact: {
            ...artifact,
            dependencyGaps: [...(artifact.dependencyGaps ?? []), "ACTUAL_READ_DEPENDENCY_STALE"],
          },
        });
    }
    // Re-read latest receipts so validation never overwrites a newly retained dependency gap.
    for (const artifact of harnessState(db, ctx.sessionId, task(ctx)).artifacts) {
      if (
        artifact.persistence !== "saved" ||
        artifact.validation === "stale" ||
        !artifact.bindings.length
      )
        continue;
      if (!current(artifact.bindings))
        append(ctx, { kind: "artifact", artifact: { ...artifact, validation: "stale" } });
    }
    ctx.signal.throwIfAborted();
    const result = harnessState(db, ctx.sessionId, task(ctx));
    if (registrationKeys.length) {
      result.unverifiedObligations = [
        ...new Set([...result.unverifiedObligations, "实际效果登记缺失，相关义务仍未核实。"]),
      ];
      hostRegistrationStates.set(result, {
        taskId: result.taskId,
        sessionId: ctx.sessionId,
        sourceKeys: registrationKeys,
        fingerprint: stableHarnessHash(result),
      });
    }
    return result;
  }
  function requiresCreatedDocumentAnchor(
    artifact: HarnessArtifactReceipt,
    ctx: ToolContext,
  ): boolean {
    if (!ctx.access?.binding().contractRef || !artifact.docId) return false;
    const row = db
      .prepare(
        "SELECT inverse,source_id FROM doc_ops WHERE doc_id=? AND rev=1 AND base_rev=0 AND session_id=? AND tool_call_id=?",
      )
      .get(artifact.docId, ctx.sessionId, artifact.toolCallId) as
      | { inverse: string; source_id: string }
      | undefined;
    if (!row) return false;
    try {
      if (obj(JSON.parse(row.inverse))._hostCreatedDocument) return true;
    } catch {
      return true;
    }
    // Classification only: a typed attempt can require an anchor but cannot supply one.
    return !!db
      .prepare(
        "SELECT 1 FROM session_log WHERE session_id=? AND type='tool.intent' AND ?=session_id||'/'||agent_id AND json_extract(data,'$.toolCallId')=? AND json_extract(data,'$.toolName')='workbook_edit' AND json_extract(data,'$.args.create')=1 LIMIT 1",
      )
      .get(ctx.sessionId, row.source_id, artifact.toolCallId);
  }
  function createdDocumentBinding(
    artifact: HarnessArtifactReceipt,
    ctx: ToolContext,
  ): HarnessBinding {
    if (!artifact.docId || artifact.revision !== 1) throw new Error("CREATE_ANCHOR_MISSING");
    const request = {
      db,
      workspaceId: ctx.workspaceId,
      root: ctx.workspaceRoot,
      path: artifact.path,
      docId: artifact.docId,
      revision: artifact.revision,
      toolCallId: artifact.toolCallId,
    };
    const proof = lookupCommittedCreatedDocument(request);
    if (!proof) throw new Error("CREATE_ANCHOR_MISSING_OR_CHANGED");
    const { bytes } = readVerifiedResourceSync(
      ctx.workspaceRoot,
      artifact.path,
      { purpose: "harness-created-document-postimage" },
      proof.physical,
    );
    if (sha256(bytes) !== proof.sha256 || !lookupCommittedCreatedDocument(request))
      throw new Error("CREATE_POSTIMAGE_CHANGED");
    return {
      path: proof.path,
      docId: proof.docId,
      rev: 1,
      savedRev: 1,
      sha256: proof.sha256,
      authorizationKey: auth(ctx),
    };
  }
  /** Classify only the immutable producer step of this exact initial artifact. */
  function sqlOutputOrigin(artifact: HarnessArtifactReceipt, ctx: ToolContext) {
    const ref = ctx.access?.binding().contractRef;
    if (!ref) return;
    const first = db.prepare(
      "SELECT seq,agent_id,data FROM session_log WHERE session_id=? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.artifact.id')=? AND json_extract(data,'$.artifact.taskId')=? ORDER BY seq LIMIT 1",
    ).get(ctx.sessionId, artifact.id, artifact.taskId) as {seq: number; agent_id: string; data: string} | undefined;
    if (!first || first.agent_id !== ctx.agentId) return;
    const initial = obj(obj(JSON.parse(first.data)).artifact);
    if (initial.id !== artifact.id || initial.taskId !== artifact.taskId ||
        initial.toolCallId !== artifact.toolCallId || initial.path !== artifact.path ||
        initial.docId !== artifact.docId || initial.revision !== 0 ||
        initial.effect !== "data" || initial.execution !== "succeeded") return;
    const stepRow = db.prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='step.started' AND seq<? ORDER BY seq DESC LIMIT 1",
    ).get(ctx.sessionId, first.agent_id, first.seq) as {seq: number; data: string} | undefined;
    if (!stepRow) return;
    const step = obj(JSON.parse(stepRow.data));
    if (typeof step.turnId !== "string" || typeof step.stepId !== "string") return;
    const producerRef = turnAccessBinding(db, ctx.sessionId, first.agent_id, step.turnId)?.contractRef;
    if (!producerRef || producerRef.originTaskId !== artifact.taskId ||
        stableHarnessHash(producerRef) !== stableHarnessHash(ref)) return;
    const next = db.prepare(
      "SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type='step.started' AND seq>? ORDER BY seq LIMIT 1",
    ).get(ctx.sessionId, first.agent_id, stepRow.seq) as {seq: number} | undefined;
    if (!next || first.seq >= next.seq) return;
    const intents = db.prepare(
      "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND seq>? AND seq<? AND json_extract(data,'$.toolCallId')=? ORDER BY seq LIMIT 2",
    ).all(ctx.sessionId, first.agent_id, stepRow.seq, next.seq, artifact.toolCallId) as Array<{seq: number; data: string}>;
    if (intents.length !== 1 || intents[0]!.seq >= first.seq) return;
    const intent = obj(JSON.parse(intents[0]!.data)), args = obj(intent.args);
    if (intent.stepId !== step.stepId || intent.toolName !== "workbook_analyze" ||
        args.mode !== "sql" || obj(args.saveTo).path !== initial.path) return;
    return {first, stepRow, step, producerRef, next, intentRow: intents[0]!, intent};
  }

  /** Rev-zero SQL outputs may bind only after independently active reads of the original publication. */
  async function recoverSqlOutputBindings(ctx: ToolContext): Promise<void> {
    const access = ctx.access?.binding(), ref = access?.contractRef;
    if (!ref) return;
    const origin = { db, sessionId: ctx.sessionId, originAgentId: ref.originAgentId, originTurnId: ref.originTurnId };
    for (const artifact of artifactHistory(ctx)) {
      if (artifact.taskId !== task(ctx) || artifact.effect !== "data" ||
          artifact.execution !== "succeeded" || artifact.revision !== 0 ||
          !artifact.docId || !artifact.path.startsWith("outputs/") ||
          !["unknown", "saved"].includes(artifact.persistence)) continue;
      // Non-SQL, missing, ambiguous or unclosed origins are unsupported and untouched.
      let producer: ReturnType<typeof sqlOutputOrigin>;
      try { producer = sqlOutputOrigin(artifact, ctx); } catch { continue; }
      if (!producer) continue;
      const artifactKey = stableHarnessHash(artifact), docId = artifact.docId;
      const unchanged = () => {
        const current = artifactHistory(ctx).find(a => a.id === artifact.id);
        return current !== undefined && stableHarnessHash(current) === artifactKey;
      };
      try {
        await cooperate(ctx);
        const evidence = () => {
          const receipt = lookupHostCreatedOutput(origin, artifact.path);
          if (!receipt || receipt.operationId !== artifact.toolCallId ||
              receipt.originTaskId !== artifact.taskId ||
              receipt.contractId !== ref.contractId) throw new Error("SQL output publication origin unavailable");
          const currentProducer = sqlOutputOrigin(artifact, ctx);
          if (!currentProducer || stableHarnessHash(currentProducer) !== stableHarnessHash(producer))
            throw new Error("SQL output original producer changed");
          const results = db.prepare(
            "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.result' AND seq>? AND seq<? AND json_extract(data,'$.toolCallId')=? ORDER BY seq LIMIT 2",
          ).all(ctx.sessionId, producer.first.agent_id, producer.stepRow.seq, producer.next.seq, artifact.toolCallId) as Array<{seq: number; data: string}>;
          if (results.length !== 1 || results[0]!.seq <= producer.first.seq)
            throw new Error("SQL output original result is not unique in its producer step");
          const record = obj(JSON.parse(results[0]!.data)), result = obj(record.result), saved = obj(obj(result.data).saved);
          if (record.toolName !== "workbook_analyze" || record.status !== "ok" || result.status !== "ok" ||
              saved.path !== artifact.path || saved.docId !== docId || saved.rev !== 0)
            throw new Error("SQL output was not a successful revision zero creation");
          const row = db.prepare(
            "SELECT id,workspace_id,path,rev,head_rev,checkpoint_rev,checkpoint_hash,checkpoint_snapshot FROM documents WHERE id=?",
          ).get(docId) as {id: string; workspace_id: string; path: string; rev: number; head_rev: number; checkpoint_rev: number; checkpoint_hash: string; checkpoint_snapshot: string | null} | undefined;
          if (!row || row.workspace_id !== ctx.workspaceId || row.path !== artifact.path ||
              row.rev !== 0 || row.head_rev !== 0 || row.checkpoint_rev !== 0 || row.checkpoint_hash !== receipt.proof.sha256 ||
              row.checkpoint_snapshot === null || db.prepare("SELECT 1 FROM doc_checkpoints WHERE doc_id=?").get(docId))
            throw new Error("SQL output revision zero checkpoint changed");
          return {receipt, row, producer: currentProducer, resultSeq: results[0]!.seq, resultData: results[0]!.data};
        };
        documents.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, {docId, path: artifact.path});
        const before = evidence(), authorizationKey = auth(ctx);
        const coveredChecks = () => {
          const state = harnessState(db, ctx.sessionId, task(ctx));
          // One-way projection only: DATA validation is not an input to this reducer.
          if (!state.allowedOutcomes.includes("completed") && !state.allowedOutcomes.includes("findings")) return [];
          const checks = state.checks;
          if (checks.some(check => check.purpose === "required_output" && check.status !== "passed")) return [];
          return checks.filter(check => check.purpose === "required_output" && check.status === "passed" &&
            check.coveredEffectIds?.includes(artifact.id) &&
            check.bindings.some(item => item.path === artifact.path && item.docId === docId &&
              item.rev === 0 && item.savedRev === 0 && item.sha256 === before.receipt.proof.sha256));
        };
        // Initial persistence recovery cannot itself certify data. Only an already-saved
        // effect covered by actual current host checks may project the passed status.
        const checks = artifact.persistence === "saved" ? coveredChecks() : [];
        const checkBindings = checks.flatMap(check => check.bindings);
        assertToolReadAccess(artifact.path, "file-metadata", ctx.workspaceRoot);
        assertToolReadAccess(artifact.path, "file-bytes", ctx.workspaceRoot);
        const b = await binding(artifact.path, ctx);
        const dependencies = artifact.bindings.filter(item => item.path !== artifact.path);
        if (!(await bindingsCurrent([...dependencies, ...checkBindings], ctx))) throw new Error("SQL output dependencies changed");
        assertDeliveryBindings(documents, [b, ...dependencies, ...checkBindings], ctx);
        // No await from this final descriptor read through the append. A separate earlier
        // identity read cannot establish the physical observation used for this correction.
        const observation = readVerifiedResourceObservationSync(ctx.workspaceRoot, artifact.path, {purpose: "harness-sql-output-postimage"});
        const p = before.receipt.proof, stat = observation.stat;
        if (!stat.isFile() || stat.nlink !== 1 ||
            ![stat.dev, stat.ino, stat.size].every(Number.isSafeInteger) ||
            String(stat.dev) !== p.device || String(stat.ino) !== p.inode || stat.size !== p.size ||
            sha256(observation.bytes) !== p.sha256 ||
            b.docId !== docId || b.rev !== 0 || b.savedRev !== 0 || b.sha256 !== p.sha256 ||
            b.authorizationKey !== authorizationKey || auth(ctx) !== authorizationKey ||
            stableHarnessHash(evidence()) !== stableHarnessHash(before) || !unchanged() ||
            stableHarnessHash(ctx.access?.binding().contractRef) !== stableHarnessHash(ref) ||
            (artifact.persistence === "saved" && stableHarnessHash(coveredChecks()) !== stableHarnessHash(checks)))
          throw new Error("SQL output final physical binding changed");
        assertToolReadAccess(artifact.path, "file-metadata", ctx.workspaceRoot);
        assertToolReadAccess(artifact.path, "file-bytes", ctx.workspaceRoot);
        ctx.signal.throwIfAborted();
        const bindings = [b, ...dependencies], validation = checks.length ? "passed" as const : "unverified" as const;
        if (artifact.persistence !== "saved" || artifact.sha256 !== b.sha256 || artifact.validation !== validation ||
            stableHarnessHash(artifact.bindings) !== stableHarnessHash(bindings))
          append(ctx, {kind: "artifact", artifact: {...artifact, persistence: "saved", validation, sha256: b.sha256, bindings}});
      } catch (error) {
        rethrowCancellation(error, ctx);
        try {
          const clean = (value: string) => value.replaceAll(ctx.workspaceRoot, "<workspace>")
            .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 320);
          console.warn("[sql-output-recovery]", JSON.stringify({
            taskId: artifact.taskId, artifactId: artifact.id,
            errorName: clean(error instanceof Error ? error.name : "NonError"),
            errorMessage: clean(error instanceof Error ? error.message : "Non-Error exception"),
          }));
        } catch { /* Diagnostics must not alter refusal or mask the original error. */ }
        if (artifact.persistence === "saved" && unchanged())
          append(ctx, {kind: "artifact", artifact: {...artifact, persistence: "unknown", validation: "unverified"}});
      }
    }
  }

  async function deliveryState(ctx: ToolContext): Promise<HarnessDeliveryState> {
    await recoverSqlOutputBindings(ctx);
    const state = harnessState(db, ctx.sessionId, task(ctx));
    if (ctx.access?.binding().contractRef)
      for (const artifact of state.artifacts) {
        if (!requiresCreatedDocumentAnchor(artifact, ctx) || artifact.persistence === "not_written")
          continue;
        try {
          const b = createdDocumentBinding(artifact, ctx);
          const bindings = [b, ...artifact.bindings.filter((d) => d.path !== artifact.path)];
          if (
            artifact.persistence !== "saved" ||
            stableHarnessHash(bindings) !== stableHarnessHash(artifact.bindings)
          )
            append(ctx, {
              kind: "artifact",
              artifact: { ...artifact, persistence: "saved", bindings, sha256: b.sha256 },
            });
        } catch (error) {
          rethrowCancellation(error, ctx);
          if (artifact.persistence === "saved")
            append(ctx, {
              kind: "artifact",
              artifact: { ...artifact, persistence: "unknown", validation: "unverified" },
            });
        }
      }
    for (const c of state.checks) {
      if (c.status === "stale") continue;
      if (!(await bindingsCurrent(c.bindings, ctx)))
        append(ctx, { kind: "check", check: { ...c, status: "stale", coveredEffectIds: [] } });
    }
    // Preserve actual inputs of EVERY effect even after a later metadata receipt replaces its card.
    for (const a of artifactHistory(ctx)) {
      if (
        a.persistence === "not_written" ||
        a.dependencyGaps?.includes("ACTUAL_READ_DEPENDENCY_STALE")
      )
        continue;
      const dependencies = a.bindings.filter((b) => b.path !== a.path);
      if (!(await bindingsCurrent(dependencies, ctx)))
        append(ctx, {
          kind: "artifact",
          artifact: {
            ...a,
            dependencyGaps: [...(a.dependencyGaps ?? []), "ACTUAL_READ_DEPENDENCY_STALE"],
          },
        });
    }
    for (const a of harnessState(db, ctx.sessionId, task(ctx)).artifacts) {
      if (a.persistence !== "saved" || !a.bindings.length) continue;
      if (!(await bindingsCurrent(a.bindings, ctx)))
        append(ctx, { kind: "artifact", artifact: { ...a, validation: "stale" } });
    }
    return finalCurrentState(ctx);
  }
  async function recordEffect(
    input: NonNullable<ToolContext["reportArtifactEffect"]> extends (e: infer E) => unknown
      ? E
      : never,
    ctx: ToolContext,
    plan?: HarnessPlan,
    dependencies: HarnessBinding[] = [],
    dependencyGaps: string[] = [],
  ): Promise<HarnessArtifactReceipt> {
    const effectId = id("hartifact");
    const canonical = input.effect === "external" ? input.path : normalizeAccessPath(input.path);
    if (
      input.effect !== "external" &&
      (!canonical ||
        canonical === "." ||
        canonical !== input.path ||
        canonical.split("/").some(isInternalName))
    ) {
      // An unresolved identifier is diagnostic data only, never an artifact/FS path.
      append(ctx, {
        kind: "check",
        check: {
          id: id("hcheck"),
          taskId: task(ctx),
          planId: "host.effect_registration",
          planVersion: 1,
          obligationId: "host.unresolved_effect." + effectId,
          definitionHash: stableHarnessHash({ effectId, toolCallId: ctx.toolCallId }),
          purpose: "required_output",
          status: "unverified",
          assurance: "unsupported",
          bindings: [],
          findings: [
            {
              code: "UNRESOLVED_EFFECT_PATH",
              message: "实际效果路径未能规范化，义务未核实，不能完整交付。",
              actual: JSON.stringify(input.path).slice(0, 512),
            },
          ],
          coveredDomains: [],
          coveredEffectIds: [],
          uncoveredFields: [],
          failedCount: 0,
          unverifiedCount: 1,
          findingsTruncated: input.path.length > 512,
        },
      });
      throw new Error("UNRESOLVED_EFFECT_PATH");
    }
    const receipt: HarnessArtifactReceipt = {
      id: effectId,
      taskId: task(ctx),
      toolCallId: ctx.toolCallId,
      path: canonical!,
      effect: input.effect,
      execution: input.execution,
      persistence: input.persistence === "not_written" ? "not_written" : "unknown",
      footprint: input.footprint ?? ["*"],
      validation: "unverified",
      bindings: [...dependencies],
      dependencyGaps: [...dependencyGaps],
      ...(input.docId ? { docId: input.docId } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(plan ? { planId: plan.id, planVersion: plan.version } : {}),
      ...(input.capture ? { capture: input.capture } : {}),
      ...(input.replacesDataRanges?.length ? { replacesDataRanges: input.replacesDataRanges } : {}),
    };
    // Retain the actual host-reported obligation before any postimage/asset IO can fail.
    append(ctx, { kind: "artifact", artifact: receipt });
    try {
      dependencies = [
        ...dependencies,
        ...(input.assetInputs ?? []).map((asset) => ({
          path: resolveWorkspacePath(ctx.workspaceRoot, asset.path).rel,
          sha256: asset.sha256,
          authorizationKey: auth(ctx),
        })),
      ];
      receipt.bindings = dependencies;
      if (receipt.persistence !== "not_written" && input.effect !== "external") {
        if (dependencyGaps.includes("ACTUAL_PRODUCER_REVISION_UNBOUND"))
          throw new Error("ACTUAL_PRODUCER_REVISION_UNBOUND");
        receipt.path = resolveWorkspacePath(ctx.workspaceRoot, input.path).rel;
        const anchoredCreate = requiresCreatedDocumentAnchor(receipt, ctx);
        if (input.docId && receipt.execution === "succeeded" && !anchoredCreate)
          await documents.checkpoint(input.docId, ctx.workspaceRoot);
        const b = anchoredCreate
          ? createdDocumentBinding(receipt, ctx)
          : await (receipt.effect === "text"
              ? binding(input.path, ctx, undefined, true)
              : !input.docId && ["copy", "move", "export"].includes(receipt.effect)
                ? byteProducerBinding(input.path, ctx)
                : binding(input.path, ctx));
        receipt.bindings = [
          b,
          ...dependencies.filter((d) => stableHarnessHash(d) !== stableHarnessHash(b)),
        ];
        receipt.docId = b.docId;
        receipt.revision = b.rev;
        receipt.sha256 = b.sha256;
        receipt.persistence = "saved";
        if (
          receipt.effect === "format" &&
          !dependencyGaps.length &&
          receipt.execution === "succeeded"
        )
          receipt.validation = "passed";
      }
    } catch (error) {
      // The initial unknown receipt remains durable even when metadata is denied.
      receipt.persistence = input.persistence === "not_written" ? "not_written" : "unknown";
      if (input.assetInputs?.length)
        receipt.dependencyGaps = [...dependencyGaps, "ACTUAL_ASSET_DEPENDENCY_UNBOUND"];
      rethrowCancellation(error, ctx);
    }
    append(ctx, { kind: "artifact", artifact: receipt });
    return receipt;
  }
  function wrapTool(tool: ToolDefinition): ToolDefinition {
    const external = tool.name.startsWith("mcp__");
    const registered = savedEffects.has(tool.name) || external;
    if (!registered) return tool;
    const schema = z.unknown().transform((v, c) => {
      const parsed = tool.input.safeParse(strip(v));
      const verification = obj(v).verification;
      if (!parsed.success) {
        for (const issue of parsed.error.issues)
          c.addIssue({ code: "custom", message: issue.message, path: issue.path });
        return z.NEVER;
      }
      const checked =
        verification === undefined ? undefined : VerificationInput.safeParse(verification);
      if (checked && !checked.success) {
        for (const issue of checked.error.issues)
          c.addIssue({
            code: "custom",
            message: issue.message,
            path: ["verification", ...issue.path],
          });
        return z.NEVER;
      }
      return { ...obj(parsed.data), ...(checked?.success ? { verification: checked.data } : {}) };
    });
    const nativeJson = tool.inputJsonSchema ?? z.toJSONSchema(tool.input, { io: "input" });
    function extend(s: Json): Json {
      return {
        ...s,
        ...(s.properties
          ? {
              properties: {
                ...obj(s.properties),
                verification: {
                  ...z.toJSONSchema(VerificationInput.options[0], { io: "input" }),
                  description: "先用 workbook_check action=register 登记完整验证声明，再传回其 planId 和 version；登记不代表检查通过。",
                },
              },
            }
          : {}),
        ...(Array.isArray(s.anyOf) ? { anyOf: s.anyOf.map((v) => extend(obj(v))) } : {}),
        ...(Array.isArray(s.oneOf) ? { oneOf: s.oneOf.map((v) => extend(obj(v))) } : {}),
      };
    }
    return {
      ...tool,
      input: schema,
      inputJsonSchema: extend(obj(nativeJson)),
      effect:
        typeof tool.effect === "function"
          ? (args) =>
              typeof tool.effect === "function" ? tool.effect(strip(args) as never) : tool.effect
          : tool.effect,
      replay:
        typeof tool.replay === "function"
          ? (args) =>
              typeof tool.replay === "function" ? tool.replay(strip(args) as never) : tool.replay
          : tool.replay,
      targets: (args, scope) => tool.targets(strip(args), scope),
      ...(tool.activity ? { activity: (args: unknown) => tool.activity!(strip(args)) } : {}),
      ...(tool.intentMeta
        ? { intentMeta: (args: unknown, ctx: ToolContext) => tool.intentMeta!(strip(args), ctx) }
        : {}),
      recover(info) {
        const args = strip(info.args),
          effect = typeof tool.effect === "function" ? tool.effect(args as never) : tool.effect;
        let result: ToolResult | undefined, thrown: unknown;
        try {
          result = tool.recover?.({ ...info, args });
        } catch (e) {
          thrown = e;
        }
        if (effect !== "read" && result?.status !== "not_executed") {
          // Recovery only observes durable commit metadata. It never opens/checkpoints/replays a document.
          const lastTurn =
            info.turnId ??
            (
              db
                .prepare(
                  "SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1",
                )
                .get(info.sessionId, info.agentId) as { turnId: string } | undefined
            )?.turnId ??
            "legacy";
          const origin =
            info.access?.binding() ?? turnAccessBinding(db, info.sessionId, info.agentId, lastTurn);
          const taskId = harnessTaskId({
            ...info,
            turnId: lastTurn,
            ...(origin
              ? { originAgentId: origin.originAgentId, originTurnId: origin.originTurnId }
              : {}),
          });
          const known = new Map<string, { docId?: string; revision?: number }>();
          const committed = db
            .prepare(
              "SELECT d.path,o.doc_id,MAX(o.rev) AS rev FROM doc_ops o JOIN documents d ON d.id=o.doc_id WHERE o.session_id=? AND o.tool_call_id=? GROUP BY o.doc_id",
            )
            .all(info.sessionId, info.toolCallId) as {
            path: string;
            doc_id: string;
            rev: number;
          }[];
          for (const row of committed)
            known.set(row.path, { docId: row.doc_id, revision: row.rev });
          for (const path of array(obj(result?.data).textsChanged))
            if (typeof path === "string") known.set(path, {});
          const unknown = Boolean(thrown) || result?.status === "uncertain" || !tool.recover;
          if (external && unknown) known.set("external/" + tool.name, {});
          if (unknown && !external) {
            for (const path of [
              args.exportPath ?? args.path,
              args.to,
              ...array(args.ops).flatMap((o) => [obj(o).to]),
            ])
              if (typeof path === "string") known.set(path, known.get(path) ?? {});
          }
          if (unknown && !known.size) known.set("unresolved/" + tool.name, {});
          const intentSeq =
            info.intentSeq ??
            (
              db
                .prepare(
                  "SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 1",
                )
                .get(info.sessionId, info.agentId, info.toolCallId) as { seq: number } | undefined
            )?.seq ??
            0;
          for (const [path, meta] of known) {
            if (
              db
                .prepare(
                  "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.artifact.taskId')=? AND json_extract(data,'$.artifact.toolCallId')=? AND json_extract(data,'$.artifact.path')=? LIMIT 1",
                )
                .get(info.sessionId, info.agentId, intentSeq, taskId, info.toolCallId, path)
            )
              continue;
            const artifact: HarnessArtifactReceipt = {
              id:
                "hartifact_recovery_" +
                stableHarnessHash({
                  sessionId: info.sessionId,
                  toolCallId: info.toolCallId,
                  intentSeq,
                  path,
                }),
              taskId,
              toolCallId: info.toolCallId,
              path,
              ...meta,
              effect:
                external || path.startsWith("unresolved/")
                  ? "external"
                  : workbookPath(path)
                    ? "data"
                    : "text",
              execution: "uncertain",
              persistence: "unknown",
              footprint: ["*"],
              validation: "unverified",
              bindings: [],
              dependencyGaps: ["RECOVERY_SAVE_AND_READSET_NOT_CONFIRMED"],
            };
            log.append(info.sessionId, info.agentId, [
              { type: "harness.event", data: { kind: "artifact", artifact } },
            ]);
          }
        }
        if (thrown) throw thrown;
        return result;
      },
      async execute(input, ctx) {
        const args = strip(input),
          verification = obj(input).verification;
        // Native targets enforce current write scope before any dependency metadata is read.
        if (!external && tool.name !== "run_script")
          try {
            tool.targets(args, ctx);
          } catch (e) {
            rethrowCancellation(e, ctx);
            return deny(e instanceof Error ? e.message : "写入范围无效");
          }
        let plan: HarnessPlan | undefined;
        try {
          plan = verification
            ? await registerOrResolve(VerificationInput.parse(verification), ctx)
            : currentPlan(ctx);
        } catch (e) {
          rethrowCancellation(e, ctx);
          return deny(e instanceof Error ? e.message : "计划无效");
        }
        const reports: Parameters<NonNullable<ToolContext["reportArtifactEffect"]>>[0][] = [],
          dependencies: HarnessBinding[] = [],
          dependencyGaps: string[] = [];
        const sourcePaths: string[] = [];
        if (tool.name === "workbook_edit")
          for (const operation of array(args.ops)) {
            const op = obj(operation);
            if (op.op === "image.add" && typeof op.path === "string") sourcePaths.push(op.path);
          }
        if (["workbook_analyze", "workbook_export", "workbook_render"].includes(tool.name)) {
          try {
            sourcePaths.push(documents.editTarget(ctx.workspaceId, ctx.workspaceRoot, args));
          } catch {
            dependencyGaps.push("SOURCE_IDENTITY_UNRESOLVED");
          }
          for (const s of array(args.sources))
            try {
              sourcePaths.push(documents.editTarget(ctx.workspaceId, ctx.workspaceRoot, obj(s)));
            } catch {
              dependencyGaps.push("SOURCE_IDENTITY_UNRESOLVED");
            }
        }
        if (tool.name === "files")
          for (const v of array(args.ops)) {
            const op = obj(v);
            if (op.op === "copy" || op.op === "move") sourcePaths.push(String(op.path));
          }
        for (const path of [...new Set(sourcePaths)])
          try {
            dependencies.push(
              tool.name === "files"
                ? await byteProducerBinding(path, ctx)
                : await binding(path, ctx),
            );
          } catch {
            dependencyGaps.push("SOURCE_NOT_SAVED_OR_AUTHORIZED");
          }
        const observed = new Map<
          string,
          { sha: string | null; rev: number | undefined; docId: string | undefined }
        >();
        const observe = (path: string) => {
          const p = resolveWorkspacePath(ctx.workspaceRoot, path);
          const row = db
            .prepare("SELECT id,head_rev FROM documents WHERE workspace_id=? AND path=?")
            .get(ctx.workspaceId, p.rel) as { id: string; head_rev: number } | undefined;
          return { path: p.rel, sha: pathVersion(p.abs), rev: row?.head_rev, docId: row?.id };
        };
        if (!external && tool.name !== "run_script")
          for (const path of tool.targets(args, ctx))
            try {
              const current = observe(path);
              observed.set(current.path, current);
            } catch {
              /* Original tool keeps authority over invalid targets. */
            }
        await cooperate(ctx);
        const next = {
          ...ctx,
          assertOriginalChart: (input: {
            path: string;
            docId: string;
            sheetId: string;
            chartId: string;
          }) => assertOriginalChartLineage(db, ctx, input),
          reportArtifactEffect: async (
            effect: Parameters<NonNullable<ToolContext["reportArtifactEffect"]>>[0],
          ) => {
            reports.push(effect);
          },
        };
        let result: ToolResult;
        try {
          result = await tool.execute(args, next);
        } catch (e) {
          if (
            external &&
            (typeof tool.effect === "function" ? tool.effect(args as never) : tool.effect) !==
              "read"
          )
            reports.push({
              path: "external/" + tool.name,
              effect: "external",
              execution: "uncertain",
              persistence: "unknown",
              footprint: ["*"],
            });
          for (const [path, old] of observed)
            try {
              const now = observe(path);
              if (
                (old.sha !== now.sha || old.rev !== now.rev) &&
                !reports.some((r) => r.path === path)
              )
                reports.push({
                  path,
                  docId: now.docId,
                  effect: "data",
                  execution: "uncertain",
                  persistence: "unknown",
                  footprint: ["*"],
                });
            } catch {
              reports.push({
                path,
                effect: "data",
                execution: "uncertain",
                persistence: "unknown",
                footprint: ["*"],
              });
            }
          await captureDependencies(
            reports.flatMap((report) => (report.readDependencies ?? []).flatMap(normalizedReads)),
            ctx,
            dependencies,
            dependencyGaps,
          );
          for (const report of reports)
            await recordEffect(
              {
                ...report,
                execution: report.execution === "failed" ? "failed" : "uncertain",
                persistence: report.persistence === "not_written" ? "not_written" : "unknown",
              },
              ctx,
              plan,
              dependencies,
              dependencyGaps,
            );
          throw e;
        }
        const data = obj(result.data),
          changes = obj(result.changes),
          dry = args.dryRun === true || args.mode === "preview";
        if (
          !dry &&
          tool.name === "workbook_edit" &&
          (result.status === "ok" || result.status === "uncertain")
        ) {
          const path =
              typeof data.path === "string"
                ? data.path
                : documents.editTarget(ctx.workspaceId, ctx.workspaceRoot, args),
            docId =
              typeof data.docId === "string"
                ? data.docId
                : typeof args.docId === "string"
                  ? args.docId
                  : undefined;
          const footprint = array(obj(data.changes).ranges ?? changes.ranges).map(String);
          const revisions =
            args.create === true && docId
              ? [data.rev, obj(result.docRevs)[docId], obj(data.docRevs)[docId]]
              : [];
          const revision =
            revisions.length === 3 &&
            revisions.every(
              (value) => Number.isSafeInteger(value) && Number(value) > 0 && value === revisions[0],
            )
              ? Number(revisions[0])
              : undefined;
          if (revision === undefined && (args.create === true || data.created === true))
            dependencyGaps.push("ACTUAL_PRODUCER_REVISION_UNBOUND");
          reports.push({
            path,
            ...(docId ? { docId } : {}),
            ...(revision !== undefined ? { revision } : {}),
            effect: classifyWorkbookEffect(array(args.ops)),
            execution: result.status === "ok" ? "succeeded" : "uncertain",
            footprint,
            replacesDataRanges: literalReplacementRanges(array(args.ops), footprint),
          });
        }
        if (!dry && tool.name === "workbook_analyze" && args.saveTo && result.status === "ok") {
          const saved = obj(data.saved),
            to = obj(args.saveTo);
          const path = String(saved.path ?? to.path ?? data.path ?? args.path ?? "");
          if (path)
            reports.push({
              path,
              docId: typeof saved.docId === "string" ? saved.docId : undefined,
              revision: typeof saved.rev === "number" ? saved.rev : undefined,
              effect: "data",
              execution: "succeeded",
              footprint:
                typeof saved.range === "string"
                  ? ["'" + String(saved.sheet ?? to.sheet).replaceAll("'", "''") + "'!" + saved.range]
                  : ["*"],
            });
        }
        if (
          !dry &&
          tool.name === "run_script" &&
          reports.length === 0 &&
          array(data.published).length
        ) {
          // Compatibility for historical/current SDK publication receipts until every producer reports directly.
          for (const p of array(data.published)) {
            const a = obj(p);
            reports.push({
              path: String(a.path),
              docId: typeof a.docId === "string" ? a.docId : undefined,
              revision: typeof a.rev === "number" ? a.rev : undefined,
              effect: a.kind === "text" ? "text" : "data",
              execution: result.status === "ok" ? "succeeded" : "uncertain",
              footprint: array(obj(a.changes).ranges).map(String),
            });
          }
        }
        if (!dry && ["write", "edit"].includes(tool.name) && result.status === "ok")
          reports.push({
            path: String(data.path ?? args.path),
            effect: "text",
            execution: "succeeded",
            footprint: ["*"],
          });
        if (!dry && tool.name === "files" && ["ok", "uncertain"].includes(result.status))
          for (const op of array(args.ops)) {
            const a = obj(op);
            if (a.op === "copy" || a.op === "move") {
              const from = normalizeAccessPath(String(a.path)),
                to = normalizeAccessPath(String(a.to));
              const transferred = array(data.results).map(obj).find(
                (item) => item.path === from && item.to === to,
              );
              reports.push({
                path: typeof transferred?.to === "string" ? transferred.to : String(a.to),
                effect: a.op,
                execution: result.status === "ok" ? "succeeded" : "uncertain",
                footprint: ["*"],
              });
            }
          }
        if (!dry && tool.name === "workbook_export" && ["ok", "uncertain"].includes(result.status))
          for (const path of array(changes.paths))
            reports.push({
              path: String(path),
              effect: "export",
              execution: result.status === "ok" ? "succeeded" : "uncertain",
              footprint: ["*"],
            });
        if (
          external &&
          (typeof tool.effect === "function" ? tool.effect(args as never) : tool.effect) !==
            "read" &&
          result.status !== "not_executed"
        )
          reports.push({
            path: "external/" + tool.name,
            effect: "external",
            execution: result.status === "ok" ? "succeeded" : "uncertain",
            persistence: "unknown",
            footprint: ["*"],
          });
        if (!dry && result.status !== "ok")
          for (const [path, old] of observed)
            try {
              const now = observe(path);
              if (
                (old.sha !== now.sha || old.rev !== now.rev) &&
                !reports.some((r) => r.path === path)
              )
                reports.push({
                  path,
                  docId: now.docId,
                  effect:
                    tool.name === "files"
                      ? "move"
                      : tool.name === "write" || tool.name === "edit"
                        ? "text"
                        : "data",
                  execution: "partial",
                  persistence: "unknown",
                  footprint: ["*"],
                });
            } catch {
              reports.push({
                path,
                effect: "data",
                execution: "uncertain",
                persistence: "unknown",
                footprint: ["*"],
              });
            }
        await captureDependencies(
          [
            ...readsOf(result, tool.name),
            ...reports.flatMap((report) =>
              (report.readDependencies ?? []).flatMap(normalizedReads),
            ),
          ],
          ctx,
          dependencies,
          dependencyGaps,
        );
        const artifacts: HarnessArtifactReceipt[] = [];
        let registrationFailure: string | undefined;
        for (const report of reports) {
          let transfer: HarnessBinding | undefined;
          if (tool.name === "files" && report.execution === "succeeded")
            for (const raw of array(args.ops)) {
              const op = obj(raw);
              if (
                (op.op === "copy" || op.op === "move") &&
                resolveWorkspacePath(ctx.workspaceRoot, String(op.to)).rel ===
                  resolveWorkspacePath(ctx.workspaceRoot, report.path).rel
              ) {
                const from = resolveWorkspacePath(ctx.workspaceRoot, String(op.path)).rel;
                transfer = dependencies.find((d) => d.path === from);
                if (transfer && op.op === "move") transfer.expectedAbsent = true;
              }
            }
          let artifact: HarnessArtifactReceipt;
          try {
            artifact = await recordEffect(
              { ...report, footprint: report.footprint?.length ? report.footprint : ["*"] },
              ctx,
              plan,
              dependencies,
              dependencyGaps,
            );
          } catch (error) {
            rethrowCancellation(error, ctx);
            registrationFailure =
              error instanceof Error ? error.message.slice(0, 512) : "EFFECT_REGISTRATION_FAILED";
            continue;
          }
          artifacts.push(artifact);
          if (
            transfer &&
            artifact.persistence === "saved" &&
            artifact.sha256 === transfer.sha256 &&
            !dependencyGaps.length
          ) {
            append(ctx, {
              kind: "check",
              check: {
                id: id("hcheck"),
                taskId: task(ctx),
                planId: "host.byte_transfer",
                planVersion: 1,
                obligationId: "host.byte_transfer." + artifact.id,
                definitionHash: stableHarnessHash({
                  source: transfer,
                  target: artifact.path,
                  sha256: artifact.sha256,
                }),
                purpose: "required_output",
                status: "passed",
                assurance: "structural",
                bindings: artifact.bindings,
                findings: [],
                coveredDomains: [],
                uncoveredFields: [],
                coveredEffectIds: [artifact.id],
                failedCount: 0,
                unverifiedCount: 0,
                findingsTruncated: false,
              },
            });
          }
        }
        if (registrationFailure)
          return {
            ...result,
            status: result.status === "ok" ? "partial" : result.status,
            data: {
              ...data,
              harnessRegistration: {
                status: "incomplete",
                producerStatus: result.status,
                code: "EFFECT_REGISTRATION_FAILED",
                message: registrationFailure,
              },
            },
            error: result.error ?? {
              code: "INTERNAL",
              message: "实际效果登记失败，相关义务未核实：" + registrationFailure,
              retryable: false,
            },
          };
        // All actual reports must be recorded before a stop can end post-save verification.
        if (artifacts.length) await cooperate(ctx);
        if (artifacts.length && plan) await check(plan, ctx, readsOf(result, tool.name));
        if (artifacts.length) {
          await deliveryState(ctx);
          const state = finalCurrentState(ctx);
          result = {
            ...result,
            data: {
              ...data,
              harness: {
                taskId: state.taskId,
                artifacts: state.artifacts,
                checks: state.checks,
                unverifiedObligations: state.unverifiedObligations,
                allowedOutcomes: state.allowedOutcomes,
              },
            },
          };
        }
        return result;
      },
    };
  }
  return { registerOrResolve, prepare, recordUnsupported, check, deliveryState, wrapTool };
}
