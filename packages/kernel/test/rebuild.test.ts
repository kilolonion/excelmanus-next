// 投影重建 = 增量（10 §3.3 硬性）：随机生成的会话记录经 SessionLog 增量写入后，
// 清空全部投影重建，投影表必须与增量维护的结果完全一致。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import { kernelProjections } from "../src/projections.ts";
import { SessionLog } from "../src/session-log.ts";

const dirs: string[] = [];
function tmpDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "kernel-rebuild-"));
  dirs.push(dir);
  return openDb(join(dir, "db.sqlite"), KERNEL_MIGRATIONS);
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 确定性 PRNG，避免测试不稳定
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const PROJECTION_TABLES: Record<string, string> = {
  sessions: "id",
  agents: "session_id, id",
  agent_context: "session_id, agent_id, idx",
  dispatches: "id",
  open_intents: "session_id, agent_id, tool_call_id",
};

function dump(db: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [t, order] of Object.entries(PROJECTION_TABLES)) {
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all();
  }
  return out;
}

interface Rec {
  type: string;
  data: unknown;
}

/** 生成一段随机但结构合法的记录流：会话创建 → 代理 → 若干轮完整步骤。 */
function genSession(
  rand: () => number,
  sessionIdx: number,
): { agentId: string | null; recs: Rec[] }[] {
  const batches: { agentId: string | null; recs: Rec[] }[] = [];
  batches.push({
    agentId: null,
    recs: [
      {
        type: "session.created",
        data: { workspaceId: "wks_1", title: null, permissionMode: "standard" },
      },
    ],
  });
  batches.push({
    agentId: "main",
    recs: [
      {
        type: "agent.spawned",
        data: { role: "main", name: "主代理", modelProfileId: "mp_1", systemPrompt: "p" },
      },
    ],
  });
  const turns = 1 + Math.floor(rand() * 3);
  for (let t = 0; t < turns; t++) {
    const dsp = `dsp_s${sessionIdx}_${t}`;
    const turnId = `trn_${t}`;
    batches.push({
      agentId: "main",
      recs: [
        {
          type: "user.message",
          data: { dispatchId: dsp, clientMessageId: `c_${sessionIdx}_${t}`, text: `消息 ${t}` },
        },
        { type: "dispatch.updated", data: { dispatchId: dsp, status: "accepted" } },
        { type: "dispatch.updated", data: { dispatchId: dsp, status: "applied" } },
        { type: "turn.started", data: { turnId } },
      ],
    });
    // 部分轮次夹带排队后被撤回的派发：永不进入 agent_context（04 §4.3）
    if (rand() < 0.35) {
      const cancelled = `dsp_s${sessionIdx}_${t}_cx`;
      batches.push({
        agentId: "main",
        recs: [
          {
            type: "user.message",
            data: {
              dispatchId: cancelled,
              clientMessageId: `cx_${sessionIdx}_${t}`,
              text: `撤回消息 ${t}`,
              mode: "queue",
            },
          },
          { type: "dispatch.updated", data: { dispatchId: cancelled, status: "queued" } },
          { type: "dispatch.updated", data: { dispatchId: cancelled, status: "cancelled" } },
        ],
      });
    }
    const steps = 1 + Math.floor(rand() * 3);
    for (let s = 0; s < steps; s++) {
      const stepId = `stp_${t}_${s}`;
      const withTool = s < steps - 1 || rand() < 0.5;
      batches.push({
        agentId: "main",
        recs: [{ type: "step.started", data: { turnId, stepId, step: s + 1, model: "m/m" } }],
      });
      if (withTool) {
        const callId = `call_${t}_${s}`;
        batches.push({
          agentId: "main",
          recs: [
            {
              type: "model.output",
              data: {
                stepId,
                text: "想一下",
                toolCalls: [{ id: callId, name: "find", args: { path: "." } }],
              },
            },
            {
              type: "tool.intent",
              data: {
                stepId,
                toolCallId: callId,
                toolName: "find",
                args: { path: "." },
                targets: ["."],
                replay: "safe",
                intentMeta: { workspaceId: "wks_1", paths: { "note.txt": null } },
              },
            },
            {
              type: "tool.result",
              data: {
                toolCallId: callId,
                toolName: "find",
                status: "ok",
                result: { status: "ok", data: { entries: [] } },
              },
            },
          ],
        });
      } else {
        batches.push({
          agentId: "main",
          recs: [{ type: "model.output", data: { stepId, text: `回答 ${s}` } }],
        });
      }
    }
    const endKind = rand();
    batches.push({
      agentId: "main",
      recs:
        endKind < 0.7
          ? [
              {
                type: "turn.completed",
                data: { turnId, reason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
              },
              {
                type: "usage.updated",
                data: { turnId, usage: { inputTokens: 1, outputTokens: 2 } },
              },
            ]
          : endKind < 0.9
            ? [{ type: "turn.interrupted", data: { turnId } }]
            : [
                {
                  type: "error.guidance",
                  data: { kind: "network", message: "网络错误", actions: ["重试"] },
                },
                {
                  type: "turn.failed",
                  data: {
                    turnId,
                    error: { kind: "network", retryable: true, message: "boom" },
                  },
                },
              ],
    });
    // 部分轮次后夹带压缩记录（04 §6.3）：keepFromSeq=null 全摘要路径；
    // 保留尾部路径由下面的专项用例覆盖（需要真实 from_seq）。
    if (rand() < 0.3) {
      batches.push({
        agentId: "main",
        recs: [
          {
            type: "compaction",
            data: {
              trigger: "auto",
              summary: `## 用户目标与约束\n第 ${t} 轮后的摘要`,
              keepFromSeq: null,
              beforeTokens: 900,
              afterTokens: 80,
              estimated: true,
            },
          },
        ],
      });
    }
  }
  // 未完成的 intent（crash 前状态），供 open_intents 有残留
  if (rand() < 0.5) {
    batches.push({
      agentId: "main",
      recs: [
        {
          type: "tool.intent",
          data: {
            stepId: "stp_x",
            toolCallId: `open_${sessionIdx}`,
            toolName: "read",
            args: { path: "a.txt" },
            targets: ["a.txt"],
            replay: "safe",
          },
        },
      ],
    });
  }
  return batches;
}

describe("SessionLog 投影重建", () => {
  test("随机会话：rebuild 后投影与增量维护完全一致", () => {
    const rand = prng(42);
    const db = tmpDb();
    const projections = kernelProjections();
    const log = new SessionLog(db, { projections });
    for (let s = 0; s < 3; s++) {
      const sid = `ses_${s}`;
      for (const batch of genSession(rand, s)) {
        log.append(sid, batch.agentId, batch.recs);
      }
    }
    const before = dump(db);
    log.rebuild();
    const after = dump(db);
    expect(after).toEqual(before);
  });

  test("按会话重建：只影响该会话投影", () => {
    const rand = prng(7);
    const db = tmpDb();
    const log = new SessionLog(db, { projections: kernelProjections() });
    for (let s = 0; s < 2; s++) {
      for (const batch of genSession(rand, s)) {
        log.append(`ses_${s}`, batch.agentId, batch.recs);
      }
    }
    const otherBefore = db.prepare("SELECT * FROM sessions WHERE id = 'ses_1'").all();
    const before = dump(db);
    log.rebuild("ses_0");
    const after = dump(db);
    expect(after).toEqual(before);
    expect(db.prepare("SELECT * FROM sessions WHERE id = 'ses_1'").all()).toEqual(otherBefore);
  });

  test("agent_context 只在 dispatch.updated applied 时入场；queued/cancelled 不进", () => {
    const db = tmpDb();
    const projections = kernelProjections();
    const log = new SessionLog(db, { projections });
    const sid = "ses_ctx";
    log.append(sid, null, [
      {
        type: "session.created",
        data: { workspaceId: "wks_1", title: null, permissionMode: "standard" },
      },
    ]);
    log.append(sid, "main", [
      {
        type: "agent.spawned",
        data: { role: "main", name: "主代理", modelProfileId: "mp_1", systemPrompt: "p" },
      },
    ]);
    // applied：进上下文
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "dsp_ok", clientMessageId: "ok", text: "会生效的消息" },
      },
      { type: "dispatch.updated", data: { dispatchId: "dsp_ok", status: "accepted" } },
      { type: "dispatch.updated", data: { dispatchId: "dsp_ok", status: "applied" } },
    ]);
    // queued 后撤回：不进上下文
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "dsp_cx", clientMessageId: "cx", text: "被撤回的消息" },
      },
      { type: "dispatch.updated", data: { dispatchId: "dsp_cx", status: "queued" } },
      { type: "dispatch.updated", data: { dispatchId: "dsp_cx", status: "cancelled" } },
    ]);
    // 一直排队未应用：不进上下文
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "dsp_q", clientMessageId: "q", text: "仍排队的消息" },
      },
      { type: "dispatch.updated", data: { dispatchId: "dsp_q", status: "queued" } },
    ]);

    const texts = () =>
      (
        db
          .prepare(
            "SELECT item FROM agent_context WHERE session_id = ? AND agent_id = 'main' ORDER BY idx",
          )
          .all(sid) as { item: string }[]
      ).map((r) => JSON.parse(r.item) as { kind: string; text?: string });
    const expectOnlyApplied = (rows: { kind: string; text?: string }[]) => {
      expect(rows.map((r) => r.kind)).toEqual(["user"]);
      expect(rows[0]?.text).toBe("会生效的消息");
    };
    expectOnlyApplied(texts());
    // 重建（只清 agent_context 也可整表重建）结果与增量一致
    const before = dump(db);
    log.rebuild(sid);
    expect(dump(db)).toEqual(before);
    expectOnlyApplied(texts());
  });

  test("compaction：旧条目标记 superseded、摘要在前、保留尾部复制原 from_seq；重建一致", () => {
    const db = tmpDb();
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sid = "ses_cmp";
    log.append(sid, null, [
      {
        type: "session.created",
        data: { workspaceId: "wks_1", title: null, permissionMode: "standard" },
      },
    ]);
    log.append(sid, "main", [
      {
        type: "agent.spawned",
        data: { role: "main", name: "主代理", modelProfileId: "mp_1", systemPrompt: "p" },
      },
    ]);
    // 第一轮：user + assistant
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "d1", clientMessageId: "c1", text: "最早的问题" },
      },
      { type: "dispatch.updated", data: { dispatchId: "d1", status: "accepted" } },
      { type: "dispatch.updated", data: { dispatchId: "d1", status: "applied" } },
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "model.output", data: { stepId: "s1", text: "第一个回答" } },
      { type: "turn.completed", data: { turnId: "t1", reason: "stop" } },
    ]);
    // 第二轮：user + assistant(toolCalls) + toolResult
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "d2", clientMessageId: "c2", text: "第二问" },
      },
      { type: "dispatch.updated", data: { dispatchId: "d2", status: "applied" } },
      { type: "turn.started", data: { turnId: "t2" } },
      {
        type: "model.output",
        data: {
          stepId: "s2",
          text: "查一下",
          toolCalls: [{ id: "call_9", name: "find", args: { path: "." } }],
        },
      },
      {
        type: "tool.result",
        data: {
          toolCallId: "call_9",
          toolName: "find",
          status: "ok",
          result: { status: "ok", data: { entries: [] } },
        },
      },
      { type: "turn.completed", data: { turnId: "t2", reason: "tool-calls" } },
    ]);
    // 保留尾部从「第二问」开始：keepFromSeq = 该上下文条目的 from_seq
    const keepRow = db
      .prepare(
        "SELECT from_seq FROM agent_context WHERE session_id = ? AND agent_id = 'main' AND superseded = 0 AND json_extract(item, '$.text') = '第二问'",
      )
      .get(sid) as { from_seq: number };
    log.append(sid, "main", [
      {
        type: "compaction",
        data: {
          trigger: "auto",
          summary: "## 用户目标与约束\n目标：核对 B 列含税金额",
          keepFromSeq: keepRow.from_seq,
          beforeTokens: 900,
          afterTokens: 80,
          estimated: true,
        },
      },
    ]);

    const visible = () =>
      db
        .prepare(
          "SELECT item, from_seq, superseded FROM agent_context WHERE session_id = ? AND agent_id = 'main' ORDER BY idx",
        )
        .all(sid) as { item: string; from_seq: number; superseded: number }[];
    const rows = visible();
    const live = rows.filter((r) => r.superseded === 0);
    // 旧条目保留为 superseded=1；可见 = 摘要 + 尾部三条（u2、a2、tr2）
    expect(rows.filter((r) => r.superseded === 1).length).toBe(5);
    expect(live.length).toBe(4);
    const items = live.map((r) => JSON.parse(r.item) as { kind: string; text?: string });
    expect(items[0]?.kind).toBe("user");
    expect(items[0]?.text).toContain("<summary>");
    expect(items[0]?.text).toContain("核对 B 列含税金额");
    expect(items[1]?.text).toBe("第二问");
    expect(items[2]?.kind).toBe("assistant");
    expect(items[3]?.kind).toBe("toolResult");
    // 复制的尾部保留原 from_seq（第二条来自「第二问」applied 记录）
    expect(live[1]?.from_seq).toBe(keepRow.from_seq);
    expect(live[0]?.from_seq).toBeGreaterThan(keepRow.from_seq);

    const before = dump(db);
    log.rebuild(sid);
    expect(dump(db)).toEqual(before);
    expect(visible()).toEqual(rows);
  });

  test("history.rewound：该消息及其后的条目失效、之后的消息照常进入；不越过压缩；重建一致", () => {
    const db = tmpDb();
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sid = "ses_rew";
    log.append(sid, null, [
      {
        type: "session.created",
        data: { workspaceId: "wks_1", title: null, permissionMode: "standard" },
      },
    ]);
    log.append(sid, "main", [
      {
        type: "agent.spawned",
        data: { role: "main", name: "主代理", modelProfileId: "mp_1", systemPrompt: "p" },
      },
    ]);
    const turn = (n: number, text: string): number => {
      const [msg] = log.append(sid, "main", [
        {
          type: "user.message",
          data: { dispatchId: `d${n}`, clientMessageId: `c${n}`, text },
        },
        { type: "dispatch.updated", data: { dispatchId: `d${n}`, status: "applied" } },
        { type: "turn.started", data: { turnId: `t${n}` } },
        { type: "model.output", data: { stepId: `s${n}`, text: `答${n}` } },
        { type: "turn.completed", data: { turnId: `t${n}`, reason: "stop" } },
      ]);
      return msg?.seq ?? 0;
    };
    const live = () =>
      (
        db
          .prepare(
            "SELECT item FROM agent_context WHERE session_id = ? AND agent_id = 'main' AND superseded = 0 ORDER BY idx",
          )
          .all(sid) as { item: string }[]
      ).map((r) => (JSON.parse(r.item) as { text?: string }).text);

    const seq1 = turn(1, "问1");
    const seq2 = turn(2, "问2");
    turn(3, "问3");
    log.append(sid, "main", [
      { type: "history.rewound", data: { dispatchId: "d2", fromSeq: seq2 } },
    ]);
    expect(live()).toEqual(["问1", "答1"]);
    const seq4 = turn(4, "问2（改）");
    expect(live()).toEqual(["问1", "答1", "问2（改）", "答4"]);

    // 压缩之后，回退到压缩之前的消息（含保留尾部里的）不生效
    const keep = db
      .prepare(
        "SELECT from_seq FROM agent_context WHERE session_id = ? AND agent_id = 'main' AND superseded = 0 AND json_extract(item, '$.text') = '问2（改）'",
      )
      .get(sid) as { from_seq: number };
    log.append(sid, "main", [
      {
        type: "compaction",
        data: {
          trigger: "manual",
          summary: "摘要",
          keepFromSeq: keep.from_seq,
          beforeTokens: 100,
          afterTokens: 10,
          estimated: true,
        },
      },
    ]);
    const afterCompaction = ["<summary>\n摘要\n</summary>", "问2（改）", "答4"];
    log.append(sid, "main", [
      { type: "history.rewound", data: { dispatchId: "d1", fromSeq: seq1 } },
      { type: "history.rewound", data: { dispatchId: "d4", fromSeq: seq4 } },
    ]);
    expect(live()).toEqual(afterCompaction);
    const seq5 = turn(5, "问5");
    turn(6, "问6");
    log.append(sid, "main", [
      { type: "history.rewound", data: { dispatchId: "d5", fromSeq: seq5 } },
    ]);
    expect(live()).toEqual(afterCompaction);

    const before = dump(db);
    log.rebuild(sid);
    expect(dump(db)).toEqual(before);
  });

  test("连续两次压缩：第二次切点落在首次保留尾部内，按位置取尾不重复摘要；重建一致", () => {
    const db = tmpDb();
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sid = "ses_cmp2";
    log.append(sid, null, [
      {
        type: "session.created",
        data: { workspaceId: "wks_1", title: null, permissionMode: "standard" },
      },
    ]);
    log.append(sid, "main", [
      {
        type: "agent.spawned",
        data: { role: "main", name: "主代理", modelProfileId: "mp_1", systemPrompt: "p" },
      },
    ]);
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "d1", clientMessageId: "c1", text: "最早的问题" },
      },
      { type: "dispatch.updated", data: { dispatchId: "d1", status: "applied" } },
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "model.output", data: { stepId: "s1", text: "第一个回答" } },
      { type: "turn.completed", data: { turnId: "t1", reason: "stop" } },
    ]);
    log.append(sid, "main", [
      {
        type: "user.message",
        data: { dispatchId: "d2", clientMessageId: "c2", text: "第二问" },
      },
      { type: "dispatch.updated", data: { dispatchId: "d2", status: "applied" } },
      { type: "turn.started", data: { turnId: "t2" } },
      {
        type: "model.output",
        data: {
          stepId: "s2",
          text: "查一下",
          toolCalls: [{ id: "call_9", name: "find", args: { path: "." } }],
        },
      },
      {
        type: "tool.result",
        data: {
          toolCallId: "call_9",
          toolName: "find",
          status: "ok",
          result: { status: "ok", data: { entries: [] } },
        },
      },
      { type: "turn.completed", data: { turnId: "t2", reason: "tool-calls" } },
    ]);
    const live = () =>
      db
        .prepare(
          "SELECT item, from_seq FROM agent_context WHERE session_id = ? AND agent_id = 'main' AND superseded = 0 ORDER BY idx",
        )
        .all(sid) as { item: string; from_seq: number }[];
    // 第一次压缩：保留尾部 = [第二问, assistant, toolResult]
    const u2 = live().find((r) => (JSON.parse(r.item) as { text?: string }).text === "第二问");
    expect(u2).toBeDefined();
    log.append(sid, "main", [
      {
        type: "compaction",
        data: {
          trigger: "manual",
          summary: "## 用户目标与约束\n第一次摘要",
          keepFromSeq: u2?.from_seq ?? null,
          beforeTokens: 900,
          afterTokens: 80,
          estimated: true,
        },
      },
    ]);
    // 活跃 = [摘要1(from_seq=S1 大), u2, a2, tr2] —— from_seq 不再随 idx 单调
    const mid = live();
    expect(mid.length).toBe(4);
    const a2 = mid.find((r) => (JSON.parse(r.item) as { kind: string }).kind === "assistant");
    expect(a2).toBeDefined();
    expect(mid[0]?.from_seq).toBeGreaterThan(a2?.from_seq ?? 0);
    // 第二次压缩：切点落在首次保留尾部内的 a2（from_seq < S1）
    log.append(sid, "main", [
      {
        type: "compaction",
        data: {
          trigger: "manual",
          summary: "## 用户目标与约束\n第二次摘要",
          keepFromSeq: a2?.from_seq ?? null,
          beforeTokens: 300,
          afterTokens: 60,
          estimated: true,
        },
      },
    ]);
    const rows = live();
    // 活跃 = [摘要2, a2, tr2]：恰好一个摘要（旧摘要没有被 >= 误复制），无重复
    expect(rows.length).toBe(3);
    const items = rows.map((r) => JSON.parse(r.item) as { kind: string; text?: string });
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "toolResult"]);
    expect(items.filter((i) => i.text?.includes("<summary>")).length).toBe(1);
    expect(items[0]?.text).toContain("第二次摘要");
    expect(items.some((i) => i.text?.includes("第一次摘要"))).toBe(false);
    expect(rows[1]?.from_seq).toBe(a2?.from_seq);
    expect(new Set(rows.map((r) => r.from_seq)).size).toBe(rows.length);

    const before = dump(db);
    log.rebuild(sid);
    expect(dump(db)).toEqual(before);
    expect(live()).toEqual(rows);
  });
});
