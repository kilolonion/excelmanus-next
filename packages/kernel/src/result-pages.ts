import type { DatabaseSync } from "node:sqlite";
import type { ToolResult } from "@excelmanus/protocol";
import { z } from "zod";
import type { ToolDefinition } from "./tools.ts";

const PAGE_CHARS = 6500;
const CursorInput = z.object({ cursor: z.string() }).passthrough();
export const resultCursor = (seq: number, offset: number): string => `result:${seq}:${offset}`;

/** 分页引用只查询当前会话、当前代理、同名工具的持久化结果，不授予文件访问或执行权限。 */
export function pageResult(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  toolName: string,
  cursor: string,
): ToolResult {
  const invalid = (): ToolResult => ({
    status: "error",
    error: {
      code: "INVALID_ARGUMENT",
      message: "结果游标无效、已不可用或不属于当前代理和工具",
      retryable: false,
    },
  });
  const match = /^result:([1-9]\d*):(\d+)$/.exec(cursor);
  if (!match) return invalid();
  const seq = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(offset)) return invalid();
  const row = db
    .prepare(
      "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND seq = ? AND type = 'tool.result'",
    )
    .get(sessionId, agentId, seq) as { data: string } | undefined;
  if (!row) return invalid();
  const record = JSON.parse(row.data) as { toolName?: string; result?: ToolResult };
  if (record.toolName !== toolName || !record.result) return invalid();
  const { images: _images, ...rest } = record.result;
  const text = JSON.stringify(rest);
  if (offset >= text.length) return invalid();
  const end = Math.min(offset + PAGE_CHARS, text.length);
  return {
    status: "ok",
    data: { sourceSeq: seq, offset, chunk: text.slice(offset, end), complete: end === text.length },
    ...(end < text.length
      ? { truncated: { shown: end, total: text.length, cursor: resultCursor(seq, end) } }
      : {}),
  };
}

export function resultPageTool(tool: ToolDefinition, db: DatabaseSync): ToolDefinition {
  return {
    ...tool,
    input: CursorInput,
    effect: "read",
    replay: "safe",
    targets: () => [],
    intentMeta: undefined,
    approval: undefined,
    recover: undefined,
    execute: (args, context) =>
      pageResult(
        db,
        context.sessionId,
        context.agentId,
        tool.name,
        (args as { cursor: string }).cursor,
      ),
  };
}

export function isResultPage(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    "cursor" in args &&
    typeof args.cursor === "string" &&
    args.cursor.startsWith("result:")
  );
}

export function withResultCursor(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const cursor = {
    type: "string",
    description:
      "超长结果的 truncated.cursor；保留原调用参数，带此游标时仅读取已保存结果，不重新执行工具。",
  };
  return {
    ...schema,
    properties: {
      ...properties,
      cursor: properties.cursor ? { anyOf: [properties.cursor, cursor] } : cursor,
    },
  };
}
