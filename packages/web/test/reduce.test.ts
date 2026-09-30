// reduceSession 用服务端 e2e 录下的真实 WS 消息流做断言（ADR 0006：reduce 属易错纯逻辑）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerMessage } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import {
  displayItems,
  initialDocSync,
  initialSessionState,
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
    const items = displayItems(s);
    const userMsgs = items.filter((i) => !("kind" in i) && i.role === "user");
    expect(userMsgs.length).toBe(1);
    const assistant = items.filter((i) => !("kind" in i) && i.role === "assistant");
    expect(assistant.length).toBe(1);
    expect(assistant[0] && "text" in assistant[0] ? assistant[0].text : "").toContain(
      "工作簿已读取",
    );
    // 工具卡片：workbook_read 成功
    const tool = s.tools.find((t) => t.name === "workbook_read");
    expect(tool?.status).toBe("ok");
    expect(s.running).toBe(false);
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
