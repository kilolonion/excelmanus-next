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
});
