// 压缩纯函数单测（04 §6.3）：token 估算、切点规划、摘要转录。

import type { ContextItem } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import {
  COMPACTION_PROMPT,
  COMPACTION_SYSTEM,
  estimateTokens,
  keepBudgetTokens,
  planCompaction,
  tailFrom,
  transcriptForSummary,
} from "../src/compaction.ts";

const user = (text: string): ContextItem => ({ kind: "user", text });
const assistant = (
  text: string,
  toolCalls?: { id: string; name: string; args: unknown }[],
): ContextItem => ({
  kind: "assistant",
  text,
  ...(toolCalls ? { toolCalls } : {}),
});
const toolResult = (id: string, name = "find"): ContextItem => ({
  kind: "toolResult",
  toolCallId: id,
  toolName: name,
  output: { status: "ok", data: { entries: [] } },
});

const rowsOf = (...items: ContextItem[]) => items.map((item, i) => ({ item, fromSeq: i + 1 }));

describe("estimateTokens", () => {
  test("空历史为 0；按 JSON 字符数 / 4 向上取整", () => {
    expect(estimateTokens([])).toBe(0);
    const items = [user("abcd")];
    expect(estimateTokens(items)).toBe(Math.ceil(JSON.stringify(items[0]).length / 4));
    const two = [user("a".repeat(100)), assistant("b".repeat(50))];
    const chars = JSON.stringify(two[0]).length + JSON.stringify(two[1]).length;
    expect(estimateTokens(two)).toBe(Math.ceil(chars / 4));
  });
});

describe("planCompaction", () => {
  test("空/单条/两条全保留时返回 null", () => {
    expect(planCompaction([], 0)).toBeNull();
    expect(planCompaction(rowsOf(user("唯一一条")), 0)).toBeNull();
    // 两条都进保留尾部 → 无可压缩旧条目
    expect(planCompaction(rowsOf(user("短"), assistant("短")), 10_000)).toBeNull();
  });

  test("预算为 0 时全部摘要", () => {
    const rows = rowsOf(user("一问"), assistant("一答"), user("二问"), assistant("二答"));
    const plan = planCompaction(rows, 0);
    expect(plan).not.toBeNull();
    expect(plan?.keepFromSeq).toBeNull();
    expect(plan?.old.map((r) => r.fromSeq)).toEqual([1, 2, 3, 4]);
  });

  test("切点不落在 toolResult：孤立工具结果并入旧侧", () => {
    // 尾部预算只能容纳最后一个 toolResult：切点会后移把它并入旧侧
    const rows = rowsOf(
      user("最早的问题 ".repeat(40)),
      assistant("回答", [{ id: "c1", name: "find", args: { path: "." } }]),
      toolResult("c1"),
      user("最近的问题"),
    );
    const keepLast = estimateTokens([rows[3]?.item ?? user("")]);
    const plan = planCompaction(rows, keepLast);
    expect(plan).not.toBeNull();
    // 保留尾部 = [最近的问题]，第一条不是 toolResult
    expect(plan?.keepFromSeq).toBe(4);
    expect(plan?.old.map((r) => r.fromSeq)).toEqual([1, 2, 3]);
  });

  test("assistant 的 toolCalls 与其 toolResult 在同侧", () => {
    // 预算刚好容纳 assistant(带调用)+toolResult 两条
    const tail = [
      assistant("调用工具", [{ id: "c9", name: "find", args: { path: "." } }]),
      toolResult("c9"),
    ];
    const rows = rowsOf(
      user("很早的上下文 ".repeat(60)),
      assistant("很早的回答 ".repeat(60)),
      ...tail,
    );
    const plan = planCompaction(rows, estimateTokens(tail));
    expect(plan).not.toBeNull();
    expect(plan?.keepFromSeq).toBe(rows[2]?.fromSeq);
    const keptIdx = rows.findIndex((r) => r.fromSeq === plan?.keepFromSeq);
    expect(rows[keptIdx]?.item.kind).toBe("assistant");
    // 调用与结果一起保留在尾部（旧侧只有前两条）
    expect(plan?.old.map((r) => r.fromSeq)).toEqual([1, 2]);
  });

  test("切点越过末尾 → keepFromSeq=null", () => {
    const big = user("大消息 ".repeat(200));
    const rows = rowsOf(user("前一条 ".repeat(50)), assistant("前回答 ".repeat(50)), big);
    const plan = planCompaction(rows, estimateTokens([big]) - 1);
    expect(plan).not.toBeNull();
    expect(plan?.keepFromSeq).toBeNull();
    expect(plan?.old.length).toBe(3);
  });
});

describe("tailFrom", () => {
  test("按位置取第一条 fromSeq 相等的条目及其后全部（from_seq 非单调）", () => {
    // 压缩后活跃顺序：摘要(from_seq 大) + 保留尾部(from_seq 小)，非单调；
    // 用 >= 会把摘要也复制一遍，按位置相等才正确。
    const rows = [
      { item: user("旧摘要"), fromSeq: 50 },
      { item: user("二问"), fromSeq: 10 },
      { item: assistant("二答"), fromSeq: 12 },
      { item: toolResult("c1"), fromSeq: 13 },
    ];
    expect(tailFrom(rows, 12).map((r) => r.fromSeq)).toEqual([12, 13]);
    // keepFromSeq 指向摘要自身：它及之后全部保留
    expect(tailFrom(rows, 50).map((r) => r.fromSeq)).toEqual([50, 10, 12, 13]);
    expect(tailFrom(rows, 10).map((r) => r.fromSeq)).toEqual([10, 12, 13]);
  });

  test("keepFromSeq 为 null 或活跃条目中不存在时不保留", () => {
    const rows = rowsOf(user("a"), assistant("b"));
    expect(tailFrom(rows, null)).toEqual([]);
    expect(tailFrom(rows, 999)).toEqual([]);
    expect(tailFrom([], 1)).toEqual([]);
  });
});

describe("keepBudgetTokens", () => {
  test("窗口已知取窗口 20%，否则取当前估算 20%", () => {
    expect(keepBudgetTokens(400, 9999)).toBe(80);
    expect(keepBudgetTokens(undefined, 1000)).toBe(200);
  });
});

describe("transcriptForSummary", () => {
  test("角色前缀、工具调用行、条目间空行；不含 reasoning", () => {
    const items: ContextItem[] = [
      user("把 B 列换算成不含税"),
      {
        kind: "assistant",
        text: "先看一下文件",
        reasoning: "内心活动不该进转录",
        toolCalls: [{ id: "t1", name: "find", args: { path: "." } }],
      },
      toolResult("t1"),
      assistant("结论"),
    ];
    const text = transcriptForSummary(items);
    expect(text).toContain("【用户】\n把 B 列换算成不含税");
    expect(text).toContain("【助手】\n先看一下文件");
    expect(text).toContain('【调用工具 find】{"path":"."}');
    expect(text).toContain("【工具结果 find】");
    expect(text).not.toContain("内心活动");
    expect(text.split("\n\n").length).toBe(4);
  });

  test("单条超过 4000 字符截断并附省略标记", () => {
    const text = transcriptForSummary([user("长".repeat(5000))]);
    expect(text).toContain("…（已截断）");
    expect(text.length).toBeLessThan(4100);
  });

  test("压缩提示词常量包含六节标题与系统提示词要点", () => {
    expect(COMPACTION_SYSTEM).toContain("对话压缩器");
    for (const h of [
      "## 用户目标与约束",
      "## 已做出的决定",
      "## 涉及的文件与最后已知修订号",
      "## 未完成的待办",
      "## 用户明确说过的偏好",
      "## 重要中间结果",
    ]) {
      expect(COMPACTION_PROMPT).toContain(h);
    }
  });
});
