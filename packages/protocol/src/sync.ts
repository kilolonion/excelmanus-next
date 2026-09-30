// 同步通道消息（11 §3.3）。doc:* 与 presence 先只定义类型，服务端 M1 不实现。

import { z } from "zod";
import { LogRecord } from "./records.ts";

export const protocolVersion = 1;

export const Topic = z.string().regex(/^(session|doc):[A-Za-z0-9_-]{1,64}$|^app$/);
export type Topic = z.infer<typeof Topic>;

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const DeltaKind = z.enum([
  "text",
  "reasoning",
  "tool_args",
  "tool_progress",
  "workbook_activity",
  "agent_budget",
]);
export type DeltaKind = z.infer<typeof DeltaKind>;

// ---------- 客户端 → 服务端 ----------

export const SubMsg = z.strictObject({
  type: z.literal("sub"),
  topic: Topic,
  cursor: z.int().nonnegative().optional(),
});
export const UnsubMsg = z.strictObject({ type: z.literal("unsub"), topic: Topic });
export const PingMsg = z.strictObject({ type: z.literal("ping") });
export const PongMsg = z.strictObject({ type: z.literal("pong") });
/** M2 实现：用户在工作台中的编辑提交。 */
export const DocSubmitMsg = z.strictObject({
  type: z.literal("doc.submit"),
  docId: z.string(),
  clientOpId: z.string(),
  baseRev: z.int().nonnegative(),
  mutations: z.unknown(),
});
export const PresenceMsg = z.strictObject({
  type: z.literal("presence"),
  docId: z.string(),
  sheet: z.string(),
  selection: z.string(),
  viewport: z.unknown().optional(),
});

export const ClientMessage = z.discriminatedUnion("type", [
  SubMsg,
  UnsubMsg,
  PingMsg,
  PongMsg,
  DocSubmitMsg,
  PresenceMsg,
]);
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
  /** 本次订阅的实际起点：带游标时=游标，不带时=headCursor。 */
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
/** M2 定义，M1 不发送。 */
export const DocOpMsg = z.strictObject({
  type: z.literal("doc.op"),
  docId: z.string(),
  rev: z.int().positive(),
  source: z.string(),
  mutations: z.unknown(),
  chunk: z.object({ index: z.int(), total: z.int() }).optional(),
});
export const DocAckMsg = z.strictObject({
  type: z.literal("doc.ack"),
  clientOpId: z.string(),
  rev: z.int().positive(),
});
export const DocRejectMsg = z.strictObject({
  type: z.literal("doc.reject"),
  clientOpId: z.string(),
  conflict: z.unknown(),
});
export const DocReloadMsg = z.strictObject({
  type: z.literal("doc.reload"),
  docId: z.string(),
  rev: z.int().nonnegative(),
  reason: z.string(),
});
export const PresenceStateMsg = z.strictObject({
  type: z.literal("presence"),
  docId: z.string(),
  participants: z.array(z.unknown()),
});
export const AppEventMsg = z.strictObject({
  type: z.literal("app.event"),
  data: z.object({ type: z.string() }).loose(),
});
export const ErrorMsg = z.strictObject({
  type: z.literal("error"),
  error: ErrorBody,
});

export const ServerMessage = z.discriminatedUnion("type", [
  HelloMsg,
  SubOkMsg,
  SubErrorMsg,
  RecMsg,
  DeltaMsg,
  SnapshotMsg,
  DocOpMsg,
  DocAckMsg,
  DocRejectMsg,
  DocReloadMsg,
  PresenceStateMsg,
  AppEventMsg,
  PingMsg,
  PongMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type RecMsg = z.infer<typeof RecMsg>;
export type DeltaMsg = z.infer<typeof DeltaMsg>;
export type SnapshotMsg = z.infer<typeof SnapshotMsg>;
