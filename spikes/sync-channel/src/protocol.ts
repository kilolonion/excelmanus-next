import { z } from "zod";

export const protocolVersion = 1;

export const Topic = z.string().regex(/^session:[A-Za-z0-9_-]{1,64}$/);

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
});

export const RestError = z.object({
  error: ErrorBody.extend({ requestId: z.string(), details: z.unknown().optional() }),
});

export const TicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.iso.datetime(),
});

export const LogRecord = z.object({
  type: z.string().min(1),
  agentId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type LogRecord = z.infer<typeof LogRecord>;

export const DeltaKind = z.enum([
  "text",
  "reasoning",
  "tool_args",
  "tool_progress",
  "workbook_activity",
  "agent_budget",
]);

// ---------- 客户端 → 服务端 ----------

export const SubMsg = z.strictObject({
  type: z.literal("sub"),
  topic: Topic,
  cursor: z.int().nonnegative().optional(),
});
export const UnsubMsg = z.strictObject({ type: z.literal("unsub"), topic: Topic });
export const PingMsg = z.strictObject({ type: z.literal("ping") });
export const PongMsg = z.strictObject({ type: z.literal("pong") });

export const ClientMessage = z.discriminatedUnion("type", [SubMsg, UnsubMsg, PingMsg, PongMsg]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- 服务端 → 客户端 ----------

export const HelloMsg = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.int(),
  connectionId: z.string(),
  serverTime: z.iso.datetime(),
});
export const SubOkMsg = z.strictObject({
  type: z.literal("sub.ok"),
  topic: Topic,
  headCursor: z.int().nonnegative(),
  /** 本次订阅的实际起点：带游标时=游标，不带时=headCursor（spike 对 11 §3.3 的补充） */
  cursor: z.int().nonnegative(),
});
export const SubErrorMsg = z.strictObject({
  type: z.literal("sub.error"),
  topic: z.string(),
  error: ErrorBody,
});
export const RecMsg = z.strictObject({
  type: z.literal("rec"),
  topic: Topic,
  seq: z.int().positive(),
  record: LogRecord,
});
export const DeltaMsg = z.strictObject({
  type: z.literal("delta"),
  topic: Topic,
  agentId: z.string(),
  stepId: z.string(),
  part: z.int().nonnegative(),
  kind: DeltaKind,
  payload: z.unknown(),
});
export const SnapshotMsg = z.strictObject({
  type: z.literal("snapshot"),
  topic: Topic,
  agentId: z.string(),
  stepId: z.string(),
  text: z.string(),
  reasoning: z.string(),
  toolArgs: z.string(),
});
export const ErrorMsg = z.strictObject({ type: z.literal("error"), error: ErrorBody });

export const ServerMessage = z.discriminatedUnion("type", [
  HelloMsg,
  SubOkMsg,
  SubErrorMsg,
  RecMsg,
  DeltaMsg,
  SnapshotMsg,
  PingMsg,
  PongMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type RecMsg = z.infer<typeof RecMsg>;
export type DeltaMsg = z.infer<typeof DeltaMsg>;
export type SnapshotMsg = z.infer<typeof SnapshotMsg>;

export const serverMessageTypes: ReadonlySet<string> = new Set(
  ServerMessage.options.map((o) => o.shape.type.value),
);

// ---------- 演示写入口（REST） ----------

export const AppendBody = z.strictObject({
  type: z.string().min(1),
  agentId: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()),
});
export const DeltaBody = z.strictObject({
  agentId: z.string().min(1),
  stepId: z.string().min(1),
  part: z.int().nonnegative(),
  kind: DeltaKind,
  payload: z.unknown(),
});
