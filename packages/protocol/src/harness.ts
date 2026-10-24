import { z } from "zod";
import {
  OutputDomainDeclaration,
  SourceCheckDeclaration,
  SourceDomainDeclaration,
} from "./source-checks.ts";
export const VerificationDeclaration = z.strictObject({
  sources: z.array(SourceDomainDeclaration),
  outputs: z.array(OutputDomainDeclaration),
  checks: z.array(SourceCheckDeclaration),
  unverifiedObligations: z.array(z.string()).default([]),
  previousPlanId: z.string().min(1).optional(),
});
export const VerificationInput = z.union([
  z.strictObject({ planId: z.string().min(1), version: z.int().positive() }),
  VerificationDeclaration,
]);
export type VerificationInput = z.infer<typeof VerificationInput>;
export const HarnessBinding = z.strictObject({
  path: z.string(),
  docId: z.string().optional(),
  rev: z.int().nonnegative().optional(),
  savedRev: z.int().nonnegative().optional(),
  sha256: z.string(),
  domainId: z.string().optional(),
  sheet: z.string().optional(),
  range: z.string().optional(),
  authorizationKey: z.string(),
  expectedAbsent: z.literal(true).optional(),
});
export type HarnessBinding = z.infer<typeof HarnessBinding>;
export const HarnessPlan = VerificationDeclaration.extend({
  id: z.string(),
  version: z.int().positive(),
  taskId: z.string(),
  hash: z.string(),
  bindings: z.array(HarnessBinding),
  createdAt: z.string(),
});
export type HarnessPlan = z.infer<typeof HarnessPlan>;
const Location = z.object({
  domainId: z.string(),
  path: z.string(),
  sheet: z.string(),
  worksheetRow: z.int().positive().optional(),
  column: z.string().optional(),
});
const Finding = z.object({
  code: z.string(),
  message: z.string(),
  location: Location.optional(),
  sourceLocation: Location.optional(),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export const HarnessCheckReceipt = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  planId: z.string(),
  planVersion: z.int().positive(),
  obligationId: z.string(),
  definitionHash: z.string(),
  purpose: z.enum(["diagnostic", "required_output"]),
  status: z.enum(["passed", "failed", "unverified", "stale"]),
  assurance: z.enum(["source_derived", "structural", "declared_expression", "unsupported"]),
  bindings: z.array(HarnessBinding),
  findings: z.array(Finding),
  coveredDomains: z.array(z.string()),
  coveredCells: z
    .array(
      z.strictObject({
        domainId: z.string(),
        column: z.string(),
        worksheetRows: z.array(z.int().positive()),
      }),
    )
    .optional(),
  coveredEffectIds: z.array(z.string()).optional(),
  repairedEffectIds: z.array(z.string()).optional(),
  uncoveredFields: z.array(z.string()),
  failedCount: z.int().nonnegative(),
  unverifiedCount: z.int().nonnegative(),
  findingsTruncated: z.boolean(),
});
export type HarnessCheckReceipt = z.infer<typeof HarnessCheckReceipt>;
export const HarnessArtifactReceipt = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  toolCallId: z.string(),
  path: z.string(),
  effect: z.enum(["data", "structure", "format", "copy", "move", "export", "text", "external"]),
  execution: z.enum(["succeeded", "failed", "uncertain", "partial"]),
  persistence: z.enum(["saved", "pending_save", "save_failed", "unknown", "not_written"]),
  docId: z.string().optional(),
  revision: z.int().nonnegative().optional(),
  sha256: z.string().optional(),
  footprint: z.array(z.string()),
  replacesDataRanges: z.array(z.string()).optional(),
  validation: z.enum(["passed", "failed", "unverified", "stale"]),
  planId: z.string().optional(),
  planVersion: z.int().positive().optional(),
  bindings: z.array(HarnessBinding),
  dependencyGaps: z.array(z.string()).optional(),
});
export type HarnessArtifactReceipt = z.infer<typeof HarnessArtifactReceipt>;
export const HarnessDeliveryState = z.strictObject({
  taskId: z.string(),
  required: z.boolean(),
  plan: HarnessPlan.optional(),
  artifacts: z.array(HarnessArtifactReceipt),
  checks: z.array(HarnessCheckReceipt),
  unverifiedObligations: z.array(z.string()),
  allowedOutcomes: z.array(z.enum(["completed", "findings", "partial", "blocked"])),
});
export type HarnessDeliveryState = z.infer<typeof HarnessDeliveryState>;
export const HarnessEvent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), plan: HarnessPlan }),
  z.strictObject({ kind: z.literal("artifact"), artifact: HarnessArtifactReceipt }),
  z.strictObject({ kind: z.literal("check"), check: HarnessCheckReceipt }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
