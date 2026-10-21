// reduceSession 用服务端 e2e 录下的真实 WS 消息流做断言（reduce 属易错纯逻辑）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerMessage } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import {
  agentBusy,
  initialSessionState,
  reduceSession,
  visibleTimeline,
} from "../src/lib/session/reducer.ts";
import type { TurnSegment, UserItem } from "../src/lib/session/types.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/session-stream.json");

const rec = (seq: number, type: string, data: Record<string, unknown>, agentId = "main") =>
  ServerMessage.parse({
    type: "rec",
    topic: "session:x",
    seq,
    record: { seq, sessionId: "x", agentId, type, data, createdAt: "2026-01-01T00:00:00Z" },
  });

describe("reduceSession", () => {
  test("消息用量累加本轮各步，包含结束后记录的最后一步且不混入其他轮或代理", () => {
    let s = initialSessionState();
    let seq = 0;
    const apply = (type: string, data: Record<string, unknown>, agent = "main") => {
      s = reduceSession(s, rec(++seq, type, data, agent));
    };
    const turn = (id: string, agent = "main") =>
      visibleTimeline(s, agent).findLast(
        (item): item is TurnSegment => item.kind === "turn" && item.turnId === id,
      );
    apply("turn.started", { turnId: "t1" });
    apply("usage.updated", {
      turnId: "t1",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
    apply("turn.completed", {
      turnId: "t1",
      usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    });
    const final = rec(++seq, "usage.updated", {
      turnId: "t1",
      usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    });
    s = reduceSession(s, final);
    s = reduceSession(s, final);
    expect(turn("t1")?.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
    });
    apply("turn.started", { turnId: "t2" });
    apply("usage.updated", { turnId: "t2", usage: { inputTokens: 7, outputTokens: 3 } });
    apply("turn.interrupted", { turnId: "t2" });
    expect(turn("t2")?.usage?.totalTokens).toBe(10);
    apply("turn.started", { turnId: "t1" }, "worker");
    apply("usage.updated", { turnId: "t1", usage: { totalTokens: 5 } }, "worker");
    expect(turn("t1", "worker")?.usage?.totalTokens).toBe(5);
    expect(turn("t1")?.usage?.totalTokens).toBe(350);
  });

  test("回放 e2e 录制的真实消息流", () => {
    const msgs = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown[];
    let s = initialSessionState();
    for (const raw of msgs) s = reduceSession(s, ServerMessage.parse(raw));

    const timeline = visibleTimeline(s, "main");
    const users = timeline.filter((i): i is UserItem => i.kind === "user");
    expect(users).toHaveLength(1);
    const turns = timeline.filter((i): i is TurnSegment => i.kind === "turn");
    expect(turns.length).toBeGreaterThan(0);
    const text = turns
      .flatMap((t) => t.blocks)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(text).toContain("工作簿已读取");
    expect(Object.values(s.tools).find((t) => t.name === "workbook_read")?.status).toBe("ok");
    expect(agentBusy(s, "main")).toBe(false);
    expect(s.cursor).toBeGreaterThan(0);
  });

  test("seq 幂等：重复 rec 不重复产生消息", () => {
    const msg = rec(5, "user.message", { dispatchId: "d1", clientMessageId: "c1", text: "hi" });
    let s = reduceSession(initialSessionState(), msg);
    const once = s;
    s = reduceSession(s, msg);
    expect(s).toBe(once);
    expect(s.cursor).toBe(5);
  });

  test("未知记录类型被忽略，游标照常前进", () => {
    const s = reduceSession(initialSessionState(), {
      type: "rec",
      topic: "session:x",
      seq: 7,
      record: { type: "future.record", data: {} },
    } as unknown as ServerMessage);
    expect(visibleTimeline(s, "main")).toHaveLength(0);
    expect(s.cursor).toBe(7);
  });

  test("history.rewound 隐藏回退区间内的对话", () => {
    let s = initialSessionState();
    s = reduceSession(
      s,
      rec(1, "user.message", { dispatchId: "d1", clientMessageId: "c1", text: "第一条" }),
    );
    s = reduceSession(s, rec(2, "dispatch.updated", { dispatchId: "d1", status: "applied" }));
    s = reduceSession(
      s,
      rec(3, "user.message", { dispatchId: "d2", clientMessageId: "c2", text: "第二条" }),
    );
    s = reduceSession(s, rec(4, "dispatch.updated", { dispatchId: "d2", status: "applied" }));
    s = reduceSession(s, rec(5, "history.rewound", { dispatchId: "d2", fromSeq: 3 }));
    const kinds = visibleTimeline(s, "main").map((i) => (i.kind === "user" ? i.text : i.kind));
    expect(kinds).toContain("第一条");
    expect(kinds).not.toContain("第二条");
    expect(kinds).toContain("rewind");
  });

  test("服务重启写入的 turn.interrupted 带 restart 原因", () => {
    let s = initialSessionState();
    s = reduceSession(s, rec(1, "turn.started", { turnId: "t1" }));
    s = reduceSession(s, rec(2, "turn.interrupted", { turnId: "t1", reason: "restart" }));
    const turn = visibleTimeline(s, "main").find((i): i is TurnSegment => i.kind === "turn");
    expect(turn?.status).toBe("interrupted");
    expect(turn?.reason).toBe("restart");
  });

  test("doc.edited 提示：代理读到同一文档或本轮结束后清除", () => {
    const notice = {
      kind: "doc.edited",
      docId: "doc1",
      path: "销售.xlsx",
      rev: 4,
      ranges: ["汇总!B2"],
      text: "用户修改了 汇总!B2",
    };
    let s = initialSessionState();
    s = reduceSession(s, rec(1, "turn.started", { turnId: "t1" }));
    s = reduceSession(s, rec(2, "context.notice", notice));
    expect(s.docNotices.main?.ranges).toEqual(["汇总!B2"]);
    s = reduceSession(
      s,
      rec(3, "tool.intent", {
        toolCallId: "c1",
        toolName: "workbook_read",
        args: { path: "其他.xlsx" },
      }),
    );
    s = reduceSession(s, rec(4, "tool.result", { toolCallId: "c1", status: "ok" }));
    expect(s.docNotices.main).toBeDefined();
    s = reduceSession(
      s,
      rec(5, "tool.intent", {
        toolCallId: "c2",
        toolName: "workbook_read",
        args: { path: "./销售.xlsx" },
      }),
    );
    s = reduceSession(s, rec(6, "tool.result", { toolCallId: "c2", status: "ok" }));
    expect(s.docNotices.main).toBeUndefined();

    s = reduceSession(s, rec(7, "context.notice", notice));
    s = reduceSession(s, rec(8, "turn.completed", { turnId: "t1" }));
    expect(s.docNotices.main).toBeUndefined();
  });
  test("feedback.given 以最后一条为准，rating=null 撤回", () => {
    let s = initialSessionState();
    s = reduceSession(s, rec(1, "feedback.given", { seq: 7, rating: "up" }));
    s = reduceSession(s, rec(2, "feedback.given", { seq: 7, rating: "down" }));
    expect(s.feedback[7]).toBe("down");
    s = reduceSession(s, rec(3, "feedback.given", { seq: 7, rating: null }));
    expect(s.feedback[7]).toBeUndefined();
  });

  test("user.message 带 chatMode 时保留在消息上", () => {
    let s = initialSessionState();
    s = reduceSession(
      s,
      rec(1, "user.message", {
        dispatchId: "d1",
        clientMessageId: "c1",
        text: "问问",
        chatMode: "ask",
      }),
    );
    expect(s.dispatches.d1?.chatMode).toBe("ask");
  });
});
