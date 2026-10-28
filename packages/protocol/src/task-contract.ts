import { z } from "zod";

/** Durable host expectation, retained across delegation and deferred publication. */
export const ContractRef = z.strictObject({
  contractId: z.string().min(1),
  originTaskId: z.string().min(1),
  originAgentId: z.string().min(1),
  originTurnId: z.string().min(1),
});
export type ContractRef = z.infer<typeof ContractRef>;

/** Proposed references identify text, never authorize an operation by themselves. */
export const ContractSourceRef = z.strictObject({
  dispatchId: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).refine((value) => value.end > value.start);
export type ContractSourceRef = z.infer<typeof ContractSourceRef>;

export const ContractOperation = z.enum([
  "read-content", "read-metadata", "enumerate",
  "create", "mutate", "remove", "relocate", "deliver",
]);
export type ContractOperation = z.infer<typeof ContractOperation>;
export const ContractTarget = z.strictObject({
  path: z.string().min(1).max(4096),
  match: z.enum(["exact", "tree"]),
  sheetId: z.string().min(1).optional(),
  range: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
});
export type ContractTarget = z.infer<typeof ContractTarget>;
export const ContractPermission = z.strictObject({
  id: z.string().min(1),
  operation: ContractOperation,
  target: ContractTarget,
  source: ContractSourceRef,
});
export const ContractObligation = z.strictObject({
  id: z.string().min(1),
  requirement: z.string().min(1),
  required: z.boolean(),
  source: ContractSourceRef,
});
export const ContractAtomicGroup = z.strictObject({
  id: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(64),
  source: ContractSourceRef,
});
const namedResource = z.strictObject({
  id: z.string().min(1), path: z.string().min(1), source: ContractSourceRef,
});
export const TaskContractProposal = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  atomicGroups: z.array(ContractAtomicGroup).max(32).optional(),
  objectives: z.array(z.strictObject({
    id: z.string().min(1), description: z.string().min(1), source: ContractSourceRef,
  })).max(64),
  inputs: z.array(namedResource).max(256),
  outputs: z.array(namedResource).max(256),
  permissions: z.array(ContractPermission).max(256),
  prohibitions: z.array(ContractPermission).max(256),
  obligations: z.array(ContractObligation).max(256),
});
export type TaskContractProposal = z.infer<typeof TaskContractProposal>;

export const TaskContract = z.strictObject({
  originTaskId: z.string().min(1),
  revision: z.number().int().positive(),
  atomicGroups: z.array(ContractAtomicGroup).max(32).optional(),
  objectives: TaskContractProposal.shape.objectives,
  inputs: TaskContractProposal.shape.inputs,
  outputs: TaskContractProposal.shape.outputs,
  permissions: z.array(ContractPermission.extend({
    state: z.enum(["active", "denied", "needs_confirmation"]),
    reason: z.string().min(1),
  })).max(256),
  prohibitions: z.array(ContractPermission.omit({ id: true }).extend({
    id: z.string().min(1).optional(),
  })).max(512),
  obligations: z.array(ContractObligation).max(512),
});
export type TaskContract = z.infer<typeof TaskContract>;
