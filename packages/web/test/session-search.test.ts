import type { SessionSummary } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import { filterSessions } from "../src/session-search.ts";

function session(id: string, title: string | null): SessionSummary {
  return {
    id,
    workspaceId: "workspace",
    title,
    permissionMode: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
  };
}

describe("filterSessions", () => {
  test("trims and matches titles case-insensitively while preserving order", () => {
    const sessions = [session("1", "月度销售"), session("2", "Q4 Review"), session("3", null)];

    expect(filterSessions(sessions, "  REVIEW ")).toEqual([sessions[1]]);
    expect(filterSessions(sessions, "未命名", "（未命名会话）")).toEqual([sessions[2]]);
    expect(filterSessions(sessions, "")).toEqual(sessions);
  });
});
