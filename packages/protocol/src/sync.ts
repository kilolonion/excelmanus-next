// 同步通道消息（11 §3.3）。presence 是瞬时状态，不写入会话日志。

import { z } from "zod";
import { LogRecord } from "./records.ts";
import { ChartObject, ShapeObject } from "./workbook-objects.ts";

// v4：供应商连接独立持久化，模型写入要求 connectionId；旧客户端必须刷新。
export const protocolVersion = 4;
export function protocolCompatible(remote: number): boolean {
  return remote === protocolVersion;
}

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

/** tool_args 增量的载荷：首个分片带工具名，界面据此提前画出"正在准备调用某工具"。 */
export const ToolArgsDelta = z.object({
  id: z.string(),
  name: z.string().optional(),
  delta: z.string(),
});
export type ToolArgsDelta = z.infer<typeof ToolArgsDelta>;

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
  /** 用户在冲突条里选了「保留我的」：仍按 baseRev 平移坐标，但不再因 baseRev 之后他人的写入而拒绝。 */
  overwrite: z.boolean().optional(),
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
export const PresenceParticipant = z.strictObject({
  participantId: z.string(),
  kind: z.enum(["client", "agent"]),
  name: z.string(),
  color: z.string(),
  sheet: z.string(),
  selection: z.string(),
  viewport: z.unknown().optional(),
  updatedAt: z.iso.datetime(),
});
export type PresenceParticipant = z.infer<typeof PresenceParticipant>;
export const PresenceStateMsg = z.strictObject({
  type: z.literal("presence"),
  docId: z.string(),
  participants: z.array(PresenceParticipant),
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
      borders: z
        .partialRecord(
          z.enum(["t", "b", "l", "r", "tl_br", "bl_tr"]),
          z.object({ style: z.number().int().min(0).max(13), color: z.string() }),
        )
        .optional(),
      dataBar: z
        .object({ start: z.number(), end: z.number(), color: z.string(), gradient: z.boolean() })
        .optional(),
      icon: z
        .object({ type: z.string(), index: z.number().int(), count: z.number().int() })
        .optional(),
    }),
  ),
  charts: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        chart: ChartObject,
        cells: z.record(
          z.string(),
          z.record(
            z.string(),
            z.object({ v: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() }),
          ),
        ),
      }),
    )
    .optional(),
  images: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        mediaType: z.enum(["image/png", "image/jpeg", "image/gif"]),
        data: z.string(),
      }),
    )
    .optional(),
  shapes: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        shape: ShapeObject,
      }),
    )
    .optional(),
});
export type RenderLayout = z.infer<typeof RenderLayout>;
/** Fixed data-only input for an owned browser rendering a frozen workbook view. */
export const WorkbookCapturePacket = z
  .strictObject({
    workspaceId: z.string().min(1).max(128),
    docId: z.string().min(1).max(128),
    sheetId: z.string().min(1).max(128),
    rev: z.int().nonnegative(),
    range: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/),
    bounds: z.strictObject({
      startRow: z.int().nonnegative(),
      endRow: z.int().nonnegative(),
      startColumn: z.int().nonnegative(),
      endColumn: z.int().nonnegative(),
    }),
    snapshot: z.looseObject({
      id: z.string(),
      sheetOrder: z.array(z.string()),
      sheets: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
    viewport: z.strictObject({
      width: z.int().min(640).max(1600),
      height: z.int().min(480).max(1200),
    }),
    dpr: z.number().min(1).max(2),
  })
  .superRefine((packet, ctx) => {
    const b = packet.bounds;
    const range = /^([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)$/.exec(packet.range);
    const column = (letters: string) =>
      [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    if (
      !range ||
      column(range[1]!) !== b.startColumn ||
      column(range[3]!) !== b.endColumn ||
      Number(range[2]) - 1 !== b.startRow ||
      Number(range[4]) - 1 !== b.endRow
    )
      ctx.addIssue({ code: "custom", message: "截图range与bounds不一致", path: ["range"] });
    if (
      b.endRow < b.startRow ||
      b.endRow - b.startRow >= 80 ||
      b.endColumn < b.startColumn ||
      b.endColumn - b.startColumn >= 30
    )
      ctx.addIssue({ code: "custom", message: "单次真实视图最多请求80行×30列", path: ["bounds"] });
    if (
      !packet.snapshot.sheets[packet.sheetId] ||
      !packet.snapshot.sheetOrder.includes(packet.sheetId)
    )
      ctx.addIssue({ code: "custom", message: "截图工作表不在冻结快照中", path: ["sheetId"] });
    if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > 16 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "截图快照超过16MiB限制", path: ["snapshot"] });
  });
export type WorkbookCapturePacket = z.infer<typeof WorkbookCapturePacket>;

export const WorkbookCaptureReceipt = z.strictObject({
  docId: z.string(),
  sheetId: z.string(),
  rev: z.int().nonnegative(),
  requestedRange: z.string(),
  visibleRange: z.string(),
  fullyVisible: z.boolean(),
  warnings: z.array(z.string().max(500)).max(10).optional(),
  viewport: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
  dpr: z.number().positive(),
  zoom: z.literal(1),
  scroll: z.strictObject({ row: z.int().nonnegative(), column: z.int().nonnegative() }),
});
export type WorkbookCaptureReceipt = z.infer<typeof WorkbookCaptureReceipt>;

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
