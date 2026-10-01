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

/** 截图渲染结果（07 §8）：由界面或桌面离屏窗口把版式画成 PNG 后回传。 */
export const RenderResultMsg = z.strictObject({
  type: z.literal("render.result"),
  requestId: z.string(),
  /** PNG 的 base64（不含 data: 前缀）。 */
  png: z.string().optional(),
  error: z.string().optional(),
});

export const ClientMessage = z.discriminatedUnion("type", [
  RenderResultMsg,
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
export const DocCheckpointMsg = z.strictObject({
  type: z.literal("doc.checkpoint"),
  docId: z.string(),
  checkpointRev: z.int().nonnegative(),
  error: z.string().optional(),
  /** 外部修改与未写回修订冲突，等用户经 REST 选择保留哪个版本（07 §5）。 */
  externalConflict: z.boolean().optional(),
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

/** 渲染版式（07 §8）：全部坐标为 CSS 像素，含行列表头。 */
export const RenderLayout = z.object({
  width: z.number(),
  height: z.number(),
  cells: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      text: z.string(),
      header: z.boolean().optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      color: z.string().optional(),
      fill: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      fontSize: z.number().optional(),
    }),
  ),
});
export type RenderLayout = z.infer<typeof RenderLayout>;
export const RenderRequestMsg = z.strictObject({
  type: z.literal("render.request"),
  requestId: z.string(),
  layout: RenderLayout,
  /** 设备像素比（清晰度），默认 2。 */
  scale: z.number().optional(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  RenderRequestMsg,
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
  DocCheckpointMsg,
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
