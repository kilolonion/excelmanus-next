import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ApprovalCoordinator, isAutoApproved } from "../src/approvals.ts";
import { openDb } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import { kernelProjections } from "../src/projections.ts";
import { SessionLog } from "../src/session-log.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-agent-control-"));
  dirs.push(dir);
  const db = openDb(join(dir, "db.sqlite"), KERNEL_MIGRATIONS);
  const log = new SessionLog(db, { projections: kernelProjections() });
  log.append("ses_1", null, [
    {
      type: "session.created",
      data: { workspaceId: "ws_1", title: null, permissionMode: "confirm" },
    },
  ]);
  log.append("ses_1", "main", [
    {
      type: "agent.spawned",
      data: { role: "main", name: "主代理", modelProfileId: null, systemPrompt: "p" },
    },
  ]);
  log.append("ses_1", "sub", [
    {
      type: "agent.spawned",
      data: {
        role: "worker",
        parentId: "main",
        name: "甲",
        modelProfileId: null,
        systemPrompt: "p",
      },
    },
  ]);
  const status = (id: string) =>
    (
      db.prepare("SELECT status FROM agents WHERE session_id='ses_1' AND id=?").get(id) as {
        status: string;
      }
    ).status;
  return { db, log, status };
}

describe("P1-09 会话级自动批准", () => {
  test("每个目标都要匹配，且 effect 不高于记住时", () => {
    const { db, log } = setup();
    const approvals = new ApprovalCoordinator(db, log);
    const write = approvals.request("ses_1", "main", {
      toolCallId: "tc_1",
      toolName: "files",
      args: {},
      targets: ["tmp/a.csv"],
      effect: "write",
    });
    approvals.decide(write.id, "approved", undefined, true);
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/a.csv"], "write")).toBe(true);
    // 夹带未批准的文件
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/a.csv", "财务/总账.xlsx"], "write")).toBe(
      false,
    );
    // 记住的是写入，删除仍需审批
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/a.csv"], "destructive")).toBe(false);
    // 无目标调用只认 "*" 规则
    expect(isAutoApproved(db, "ses_1", "files", [], "write")).toBe(false);

    const del = approvals.request("ses_1", "main", {
      toolCallId: "tc_2",
      toolName: "files",
      args: {},
      targets: ["tmp/b.csv", "tmp/c.csv"],
      effect: "destructive",
    });
    approvals.decide(del.id, "approved", undefined, true);
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/c.csv", "tmp/b.csv"], "destructive")).toBe(
      true,
    );
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/b.csv"], "write")).toBe(true);
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/b.csv"], "external")).toBe(false);
    // 重建后同样成立（规则由日志重放生成）
    log.rebuild("ses_1");
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/a.csv", "tmp/b.csv"], "write")).toBe(true);
    expect(isAutoApproved(db, "ses_1", "files", ["tmp/a.csv", "tmp/x.csv"], "write")).toBe(false);
    db.close();
  });
});

describe("P1-02 closed / paused 不被收尾记录覆盖", () => {
  test("closed 终态；paused 只经 idle 离开", () => {
    const { db, log, status } = setup();
    log.append("ses_1", "sub", [{ type: "turn.started", data: { turnId: "t1" } }]);
    log.append("ses_1", "sub", [{ type: "agent.status", data: { status: "paused" } }]);
    log.append("ses_1", "sub", [{ type: "turn.interrupted", data: { turnId: "t1" } }]);
    log.append("ses_1", "sub", [{ type: "agent.status", data: { status: "queued" } }]);
    expect(status("sub")).toBe("paused");
    log.append("ses_1", "sub", [{ type: "agent.status", data: { status: "idle" } }]);
    expect(status("sub")).toBe("idle");
    log.append("ses_1", "sub", [{ type: "turn.started", data: { turnId: "t2" } }]);
    log.append("ses_1", "sub", [{ type: "agent.status", data: { status: "closed" } }]);
    log.append("ses_1", "sub", [{ type: "turn.interrupted", data: { turnId: "t2" } }]);
    log.append("ses_1", "sub", [{ type: "agent.status", data: { status: "running" } }]);
    expect(status("sub")).toBe("closed");
    log.rebuild("ses_1");
    expect(status("sub")).toBe("closed");
    db.close();
  });
});

describe("P1-08 删除会话", () => {
  test("同事务清全部投影；之后的追加被拒绝，不复活会话", () => {
    const { db, log } = setup();
    const approvals = new ApprovalCoordinator(db, log);
    approvals.request("ses_1", "sub", {
      toolCallId: "tc_1",
      toolName: "files",
      args: {},
      targets: ["a.txt"],
      effect: "destructive",
    });
    log.append("ses_1", "main", [{ type: "todo.set", data: { items: [{ id: "1" }] } }]);
    log.deleteSession("ses_1");
    for (const table of [
      "session_log",
      "agents",
      "pending_interactions",
      "todos",
      "agent_context",
    ]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='ses_1'`).get() as {
          n: number;
        }
      ).n;
      expect(n, table).toBe(0);
    }
    expect(
      log.append("ses_1", "main", [{ type: "turn.interrupted", data: { turnId: "t" } }]),
    ).toEqual([]);
    expect(db.prepare("SELECT 1 FROM sessions WHERE id='ses_1'").get()).toBeUndefined();
    db.close();
  });

  test("没有 session.created 的记录不补建会话行", () => {
    const { db, log } = setup();
    log.append("ses_ghost", "main", [{ type: "turn.interrupted", data: { turnId: "t" } }]);
    expect(db.prepare("SELECT 1 FROM sessions WHERE id='ses_ghost'").get()).toBeUndefined();
    db.close();
  });
});
