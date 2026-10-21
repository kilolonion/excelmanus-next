import { z } from "zod";

/** Runtime-owned, explicit directory or finite-file task constraint. Not a tool parameter or general permission policy. */
export const DirectoryScopeDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unbounded") }),
  z.object({ kind: z.literal("restricted"), root: z.string().min(1) }),
  z.object({ kind: z.literal("unresolved"), reason: z.string() }),
  z
    .object({
      kind: z.literal("files"),
      readPaths: z.array(z.string().min(1)).min(1).max(2),
      writePaths: z.array(z.string().min(1)).max(2),
    })
    .refine(
      (scope) =>
        new Set(scope.readPaths).size === scope.readPaths.length &&
        new Set(scope.writePaths).size === scope.writePaths.length &&
        scope.writePaths.every((path) => scope.readPaths.includes(path)),
    ),
]);
export type DirectoryScopeDecision = z.infer<typeof DirectoryScopeDecision>;
export const TurnAccessBinding = z.object({
  originAgentId: z.string(),
  originTurnId: z.string(),
  sourceDispatchIds: z.array(z.string()),
  ruleVersion: z.union([z.literal(1), z.literal(2)]),
  decision: DirectoryScopeDecision,
  accessDeliveryRequired: z.boolean(),
});
export type TurnAccessBinding = z.infer<typeof TurnAccessBinding>;
export const AccessKind = z.enum([
  "directory-enumeration",
  "file-metadata",
  "file-bytes",
  "file-write",
  "document-snapshot",
  "package-cache-parse",
  "external-target-fetch",
]);
export type AccessKind = z.infer<typeof AccessKind>;
export const AccessFact = z.object({
  operationId: z.string(),
  turnId: z.string(),
  originAgentId: z.string(),
  originTurnId: z.string(),
  sdkCallIndex: z.number().int().nonnegative().optional(),
  toolCallId: z.string(),
  kind: AccessKind,
  path: z.string(),
  outcome: z.enum(["started", "succeeded", "failed", "rejected-before-access"]),
  purpose: z.string().optional(),
  docId: z.string().optional(),
  rev: z.number().int().nonnegative().optional(),
  mode: z.string().optional(),
  range: z.string().optional(),
  packageState: z.string().optional(),
});
export type AccessFact = z.infer<typeof AccessFact>;
