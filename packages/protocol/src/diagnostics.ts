import { z } from "zod";
export const DiagnosticQuery = z.strictObject({
  sessionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});
export const DiagnosticTrace = z.object({
  sessionId: z.string(),
  seq: z.int(),
  agentId: z.string().nullable(),
  type: z.string(),
  createdAt: z.string(),
  turnId: z.string().optional(),
  stepId: z.string().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export const DiagnosticTracesResponse = z.object({
  items: z.array(DiagnosticTrace),
  truncated: z.boolean(),
});
export const DiagnosticExportBody = z.strictObject({ sessionId: z.string().min(1).optional() });
export const DiagnosticLogEvent = z.object({
  t: z.string(),
  event: z.string(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
  stepId: z.string().optional(),
  method: z.string().optional(),
  route: z.string().optional(),
  status: z.union([z.string(), z.number()]).optional(),
  port: z.number().optional(),
  count: z.number().optional(),
  durationMs: z.number().optional(),
  code: z.string().optional(),
});
export const DiagnosticExportResponse = z.object({
  protocolVersion: z.int(),
  generatedAt: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  traces: DiagnosticTracesResponse,
  logs: z.array(DiagnosticLogEvent),
  logsTruncated: z.boolean(),
});

export type DiagnosticTrace = z.infer<typeof DiagnosticTrace>;
