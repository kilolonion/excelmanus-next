// reduceSession 用服务端 e2e 录下的真实 WS 消息流做断言（ADR 0006：reduce 属易错纯逻辑）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerMessage } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import {
  agentView,
  displayItems,
  initialDocSync,
  initialSessionState,
  queueAhead,
  queuedCount,
  reduceDoc,
  reduceSession,
  trackDocSubmit,
} from "../src/reduce.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/session-stream.json");

describe("reduceSession", () => {
  test("回放 e2e 录制的真实消息流", () => {
    const msgs = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown[];
    expect(msgs.length).toBeGreaterThan(0);
    let s = initialSessionState();
    for (const raw of msgs) {
      s = reduceSession(s, ServerMessage.parse(raw));
    }
    // workbook e2e：一条用户消息 + 一条助手回答
    const view = agentView(s, "main");
    const items = displayItems(view);
    const userMsgs = items.filter((i) => !("kind" in i) && i.role === "user");
    expect(userMsgs.length).toBe(1);
    const assistant = items.filter((i) => !("kind" in i) && i.role === "assistant");
    expect(assistant.length).toBe(1);
    expect(assistant[0] && "text" in assistant[0] ? assistant[0].text : "").toContain(
      "工作簿已读取",
    );
    // 工具卡片：workbook_read 成功
    const tool = view.tools.find((t) => t.name === "workbook_read");
    expect(tool?.status).toBe("ok");
    expect(view.running).toBe(false);
    expect(s.cursor).toBeGreaterThan(0);
  });

  test("seq 幂等：重复 rec 不重复产生消息", () => {
    let s = initialSessionState();
    const rec = {
      type: "rec" as const,
      topic: "session:x",
      seq: 5,
      record: {
        seq: 5,
        sessionId: "x",
        agentId: "main",
        type: "user.message" as const,
        data: { dispatchId: "d1", clientMessageId: "c1", text: "hi" },
        createdAt: "2026-01-01T00:00:00Z",
      },
    };
    s = reduceSession(s, ServerMessage.parse(rec));
    s = reduceSession(s, ServerMessage.parse(rec));
    expect(s.messages.length).toBe(1);
    expect(s.cursor).toBe(5);
  });

  test("未知记录类型 console.warn 并忽略", () => {
    let s = initialSessionState();
    // 模拟未来版本的记录类型：走 schema 之外的形状验证 reducer 防御分支
    s = reduceSession(s, {
      type: "rec",
      topic: "session:x",
      seq: 7,
      record: { type: "future.record", data: {} },
    } as unknown as ServerMessage);
    expect(s.messages.length).toBe(0);
    expect(s.cursor).toBe(7);
  });

  test("还原审批、提问和待办记录，重放后状态可恢复", () => {
    let s = initialSessionState();
    const rec = (seq: number, type: string, data: Record<string, unknown>) =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq,
        record: {
          seq,
          sessionId: "x",
          agentId: "main",
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    s = reduceSession(
      s,
      rec(1, "approval.requested", {
        approvalId: "a1",
        toolCallId: "t1",
        toolName: "write",
        args: { path: "a.txt" },
        targets: ["a.txt"],
        effect: "write",
      }),
    );
    s = reduceSession(
      s,
      rec(2, "question.asked", {
        questionId: "q1",
        questionType: "range_confirm",
        spec: { suggestedRange: "Sheet1!A1:B2" },
      }),
    );
    s = reduceSession(
      s,
      rec(3, "todo.set", { items: [{ id: "todo1", title: "检查", status: "pending" }] }),
    );
    expect(s.approvals[0]?.status).toBe("pending");
    expect(s.questions[0]?.questionType).toBe("range_confirm");
    expect(s.todos.main?.[0]?.title).toBe("检查");
    s = reduceSession(s, rec(4, "approval.decided", { approvalId: "a1", decision: "approved" }));
    s = reduceSession(
      s,
      rec(5, "question.answered", {
        questionId: "q1",
        answer: { range: "Sheet1!A1:B2" },
        rev: 2,
      }),
    );
    expect(s.approvals[0]?.status).toBe("approved");
    expect(s.questions[0]?.status).toBe("answered");
    expect(s.questions[0]?.rev).toBe(2);
  });

  test("tool.result uncertain 映射为「结果不确定」卡片状态（14 场景 10）", () => {
    let s = initialSessionState();
    const rec = (seq: number, type: string, data: Record<string, unknown>) =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq,
        record: {
          seq,
          sessionId: "x",
          agentId: "main",
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    s = reduceSession(
      s,
      rec(1, "tool.intent", {
        toolCallId: "tc1",
        toolName: "write",
        args: { path: "a.txt" },
        targets: ["a.txt"],
      }),
    );
    s = reduceSession(
      s,
      rec(2, "tool.result", {
        toolCallId: "tc1",
        toolName: "write",
        status: "uncertain",
        result: {
          status: "uncertain",
          error: { code: "CANCELLED", message: "进程中断，结果不确定，未自动重放" },
        },
      }),
    );
    expect(s.tools[0]?.status).toBe("uncertain");
    expect(s.tools[0]?.resultSummary).toContain("结果不确定");
  });

  test("派发状态：user.message 记 mode，dispatch.updated 驱动 dispatchStatus", () => {
    let s = initialSessionState();
    const rec = (seq: number, type: string, data: Record<string, unknown>, agentId = "main") =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq,
        record: {
          seq,
          sessionId: "x",
          agentId,
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    // 运行中受理：queued；完成后 applied；撤回后 cancelled
    s = reduceSession(
      s,
      rec(1, "user.message", {
        dispatchId: "d1",
        clientMessageId: "c1",
        text: "排队中",
        mode: "queue",
      }),
    );
    s = reduceSession(
      s,
      rec(2, "user.message", {
        dispatchId: "d2",
        clientMessageId: "c2",
        text: "引导中",
        mode: "steer",
      }),
    );
    expect(s.messages[0]?.dispatchStatus).toBe("accepted");
    expect(s.messages[0]?.mode).toBe("queue");
    s = reduceSession(s, rec(3, "dispatch.updated", { dispatchId: "d1", status: "queued" }));
    s = reduceSession(s, rec(4, "dispatch.updated", { dispatchId: "d2", status: "queued" }));
    expect(s.messages[0]?.dispatchStatus).toBe("queued");
    expect(s.messages[1]?.dispatchStatus).toBe("queued");
    s = reduceSession(s, rec(5, "dispatch.updated", { dispatchId: "d1", status: "applied" }));
    s = reduceSession(s, rec(6, "dispatch.updated", { dispatchId: "d2", status: "cancelled" }));
    expect(s.messages[0]?.dispatchStatus).toBe("applied");
    expect(s.messages[1]?.dispatchStatus).toBe("cancelled");
    // 未知派发 ID / 非法状态不产生变化
    s = reduceSession(s, rec(7, "dispatch.updated", { dispatchId: "ghost", status: "queued" }));
    expect(s.messages.length).toBe(2);
  });

  test("压缩块：compaction 记录插入可展开块并更新占用；usage.updated.context 驱动占比", () => {
    let s = initialSessionState();
    const rec = (seq: number, type: string, data: Record<string, unknown>) =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq,
        record: {
          seq,
          sessionId: "x",
          agentId: "main",
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    s = reduceSession(
      s,
      rec(1, "usage.updated", {
        turnId: "t1",
        usage: { inputTokens: 350, outputTokens: 10 },
        context: { tokens: 360, window: 400, estimated: false },
      }),
    );
    expect(agentView(s, "main").live.contextUsage).toEqual({
      tokens: 360,
      window: 400,
      estimated: false,
    });

    s = reduceSession(
      s,
      rec(2, "compaction", {
        trigger: "auto",
        summary: "## 用户目标与约束\n目标：核对 B 列",
        keepFromSeq: 12,
        beforeTokens: 390,
        afterTokens: 82,
        estimated: true,
      }),
    );
    const block = s.messages[s.messages.length - 1];
    expect(block?.role).toBe("compaction");
    expect(block?.text).toContain("核对 B 列");
    expect(block?.compaction).toEqual({
      trigger: "auto",
      beforeTokens: 390,
      afterTokens: 82,
      estimated: true,
    });
    // 压缩记录本身把占用更新为 afterTokens（窗口沿用已知值）
    expect(agentView(s, "main").live.contextUsage).toEqual({
      tokens: 82,
      window: 400,
      estimated: true,
    });
    // 压缩块不占 user/assistant 消息计数、不影响排队位置统计
    expect(s.messages.filter((m) => m.role === "user").length).toBe(0);
  });

  test("usage.updated 无 context 字段时不改占用", () => {
    let s = initialSessionState();
    s = reduceSession(
      s,
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq: 1,
        record: {
          seq: 1,
          sessionId: "x",
          agentId: "main",
          type: "usage.updated",
          data: { turnId: "t1", usage: { inputTokens: 5, outputTokens: 2 } },
          createdAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    expect(agentView(s, "main").live.contextUsage).toBeNull();
  });

  test("排队位置：同代理更早且仍 queued 的 queue 消息才计入前面还有 N 条", () => {
    let s = initialSessionState();
    let seq = 0;
    const rec = (type: string, data: Record<string, unknown>, agentId = "main") =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq: ++seq,
        record: {
          seq,
          sessionId: "x",
          agentId,
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    const msg = (id: string, mode: string, agentId = "main") =>
      rec("user.message", { dispatchId: id, clientMessageId: id, text: id, mode }, agentId);
    // d1 queue、ds steer、do 其他代理、d2 queue、d3 queue —— 全部 queued
    for (const [id, mode, agent] of [
      ["d1", "queue", "main"],
      ["ds", "steer", "main"],
      ["do", "queue", "worker-1"],
      ["d2", "queue", "main"],
      ["d3", "queue", "main"],
    ] as const) {
      s = reduceSession(s, msg(id, mode, agent));
      s = reduceSession(s, rec("dispatch.updated", { dispatchId: id, status: "queued" }, agent));
    }
    const byId = (id: string) => {
      const m = s.messages.find((x) => x.id === id);
      if (m === undefined) throw new Error(`缺少消息 ${id}`);
      return m;
    };
    expect(queueAhead(s, byId("d1"))).toBe(0);
    expect(queueAhead(s, byId("d2"))).toBe(1); // 只有 d1（ds 是 steer、do 是别的代理）
    expect(queueAhead(s, byId("d3"))).toBe(2);
    expect(queuedCount(s, "main")).toBe(4); // d1 ds d2 d3 全部 queued（不分模式）
    expect(queuedCount(s, "worker-1")).toBe(1);
    // d1 被撤回后 d2/d3 的前排减少
    s = reduceSession(s, rec("dispatch.updated", { dispatchId: "d1", status: "cancelled" }));
    expect(queueAhead(s, byId("d2"))).toBe(0);
    expect(queueAhead(s, byId("d3"))).toBe(1);
    expect(queuedCount(s, "main")).toBe(3);
  });

  test("多代理：交错的 delta/record 分流到各自 agentView（05 §8）", () => {
    let s = initialSessionState();
    let seq = 0;
    const rec = (type: string, data: Record<string, unknown>, agentId = "main") =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq: ++seq,
        record: {
          seq,
          sessionId: "x",
          agentId,
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    const delta = (agentId: string, text: string) =>
      ServerMessage.parse({
        type: "delta",
        topic: "session:x",
        agentId,
        stepId: `${agentId}-s1`,
        part: 0,
        kind: "text",
        payload: text,
      });
    // main 派生 worker-1 与 worker-2
    s = reduceSession(
      s,
      rec("agent.spawned", { name: "查数", role: "worker", parentId: "main" }, "worker-1"),
    );
    s = reduceSession(
      s,
      rec("agent.spawned", { name: "汇总", role: "reader", parentId: "main" }, "worker-2"),
    );
    expect(s.roster["worker-1"]).toMatchObject({
      name: "查数",
      role: "worker",
      parentId: "main",
    });
    // 交错：worker-1 开轮 + delta；main 的 delta；worker-2 被闸门拦下为 queued
    s = reduceSession(s, rec("turn.started", { turnId: "t-w1" }, "worker-1"));
    s = reduceSession(s, delta("worker-1", "正在读取"));
    s = reduceSession(s, delta("main", "我派生了"));
    s = reduceSession(s, rec("agent.status", { status: "queued" }, "worker-2"));
    s = reduceSession(
      s,
      rec("tool.intent", { toolCallId: "tc1", toolName: "workbook_read", args: {} }, "worker-1"),
    );
    s = reduceSession(s, delta("worker-1", "两个文件"));
    const v1 = agentView(s, "worker-1");
    const v2 = agentView(s, "worker-2");
    const vm = agentView(s, "main");
    expect(v1.live.streamingText).toBe("正在读取两个文件");
    expect(vm.live.streamingText).toBe("我派生了");
    expect(v2.live.streamingText).toBe("");
    expect(v1.running).toBe(true);
    expect(vm.running).toBe(false);
    // roster：queued 状态与 lastTool
    expect(s.roster["worker-2"]?.status).toBe("queued");
    expect(s.roster["worker-1"]?.status).toBe("running");
    expect(s.roster["worker-1"]?.lastTool).toBe("workbook_read");
    // 工具卡片只归发起代理
    expect(v1.tools.map((t) => t.name)).toEqual(["workbook_read"]);
    expect(vm.tools.length).toBe(0);
    // turn.completed 把 worker-1 标回 idle 并清空流式残留
    s = reduceSession(s, rec("turn.completed", { turnId: "t-w1" }, "worker-1"));
    expect(agentView(s, "worker-1").running).toBe(false);
    expect(agentView(s, "worker-1").live.streamingText).toBe("");
    expect(s.roster["worker-1"]?.status).toBe("idle");
  });

  test("inbox.sent 还原为 internal 消息并归入收发双方视图", () => {
    let s = initialSessionState();
    let seq = 0;
    const rec = (type: string, data: Record<string, unknown>, agentId: string) =>
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq: ++seq,
        record: {
          seq,
          sessionId: "x",
          agentId,
          type,
          data,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
    s = reduceSession(
      s,
      rec("agent.spawned", { name: "子", role: "worker", parentId: "main" }, "child-1"),
    );
    s = reduceSession(
      s,
      rec(
        "inbox.sent",
        {
          messageId: "inbox-1",
          fromAgentId: "child-1",
          toAgentId: "main",
          kind: "report",
          message: "子代理「子」本轮已完成。【最终回复】完成",
        },
        "child-1",
      ),
    );
    const msg = s.messages.find((m) => m.id === "inbox-1");
    expect(msg?.role).toBe("internal");
    expect(msg?.internal).toEqual({ from: "child-1", to: "main", kind: "report" });
    // 发送方与接收方的视图都可见；无关代理不可见
    expect(agentView(s, "main").messages.some((m) => m.id === "inbox-1")).toBe(true);
    expect(agentView(s, "child-1").messages.some((m) => m.id === "inbox-1")).toBe(true);
    expect(agentView(s, "other").messages.some((m) => m.id === "inbox-1")).toBe(false);
    // 连续 internal 折叠为一组
    s = reduceSession(
      s,
      rec(
        "inbox.sent",
        {
          messageId: "inbox-2",
          fromAgentId: "child-1",
          toAgentId: "main",
          kind: "report",
          message: "第二条",
        },
        "child-1",
      ),
    );
    const items = displayItems(agentView(s, "main"));
    const groups = items.filter((i) => "kind" in i && i.kind === "internalGroup");
    expect(groups.length).toBe(1);
    expect(
      "messages" in (groups[0] ?? {}) ? (groups[0] as { messages: unknown[] }).messages.length : 0,
    ).toBe(2);
  });
});

describe("reduceDoc", () => {
  test("doc.op 按 rev 幂等推进，分片同 rev 不重复", () => {
    let s = initialDocSync(0);
    const op = (rev: number, chunk?: { index: number; total: number }) =>
      ServerMessage.parse({
        type: "doc.op",
        docId: "d1",
        rev,
        source: "agent:s1/main",
        mutations: [],
        ...(chunk !== undefined ? { chunk } : {}),
      });
    s = reduceDoc(s, op(1, { index: 0, total: 2 }));
    s = reduceDoc(s, op(1, { index: 1, total: 2 }));
    expect(s.rev).toBe(1);
    s = reduceDoc(s, op(1)); // 重复 rev：幂等
    expect(s.rev).toBe(1);
    s = reduceDoc(s, op(2));
    expect(s.rev).toBe(2);
  });

  test("doc.submit 的 ack/reject 更新 pending", () => {
    let s = trackDocSubmit(initialDocSync(0), "c1");
    expect(s.pending.c1?.status).toBe("pending");
    s = reduceDoc(s, ServerMessage.parse({ type: "doc.ack", clientOpId: "c1", rev: 3 }));
    expect(s.pending.c1?.status).toBe("acked");
    expect(s.rev).toBe(3);
    s = trackDocSubmit(s, "c2");
    s = reduceDoc(
      s,
      ServerMessage.parse({
        type: "doc.reject",
        clientOpId: "c2",
        conflict: { code: "VERSION_CONFLICT" },
      }),
    );
    expect(s.pending.c2?.status).toBe("rejected");
    expect(s.rev).toBe(3); // reject 不前进 rev
  });
});
