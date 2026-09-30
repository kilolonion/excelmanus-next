import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@excelmanus/core";
import { afterEach, describe, expect, test } from "vitest";
import { TeamCoordinator } from "../src/agents.ts";
import { openDb } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import { kernelProjections } from "../src/projections.ts";
import { recoverInterruptedAgents } from "../src/runtime.ts";
import { SessionLog } from "../src/session-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M3 代理团队协调", () => {
  test("派生、角色限制、消息投递与投影可恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "excelmanus-agents-"));
    dirs.push(dir);
    const db = openDb(join(dir, "test.db"), KERNEL_MIGRATIONS);
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sessionId = newId("ses");
    log.append(sessionId, null, [
      {
        type: "session.created",
        data: { workspaceId: "w", title: null, permissionMode: "standard" },
      },
    ]);
    log.append(sessionId, "main", [
      { type: "agent.spawned", data: { role: "main", name: "主代理", modelProfileId: null } },
    ]);
    const team = new TeamCoordinator(db, log);
    const queued: string[] = [];
    team.bindRuntime(
      (_session, agent, dispatch) => queued.push(`${agent}:${dispatch}`),
      (_session, agent) => queued.push(`inbox:${agent}`),
    );
    const child = team.spawn({
      sessionId,
      parentAgentId: "main",
      name: "核对员",
      role: "reader",
      task: "检查表头",
    });
    expect("error" in child).toBe(false);
    if ("error" in child) return;
    expect(queued.some((v) => v.startsWith(`${child.agentId}:`))).toBe(true);
    const sent = team.send({
      sessionId,
      fromAgentId: "main",
      to: [child.agentId],
      message: "请报告发现",
    });
    expect("error" in sent).toBe(false);
    expect(
      db.prepare("SELECT status FROM inbox_pending WHERE to_agent_id = ?").get(child.agentId),
    ).toMatchObject({ status: "pending" });
    const context = db
      .prepare("SELECT item FROM agent_context WHERE agent_id = ? ORDER BY idx DESC LIMIT 1")
      .get(child.agentId) as { item: string };
    expect(context.item).toContain("请报告发现");
    const row = db
      .prepare("SELECT parent_id, role FROM agents WHERE id = ?")
      .get(child.agentId) as { parent_id: string; role: string };
    expect(row).toEqual({ parent_id: "main", role: "reader" });
    const denied = team.spawn({
      sessionId,
      parentAgentId: child.agentId,
      name: "越权",
      role: "worker",
      task: "x",
    });
    expect(denied).toMatchObject({ error: { error: { code: "INVALID_ARGUMENT" } } });
    db.close();
  });

  test("重启把 running/waiting 代理收口为 interrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "excelmanus-recovery-"));
    dirs.push(dir);
    const db = openDb(join(dir, "test.db"), KERNEL_MIGRATIONS);
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sessionId = newId("ses");
    log.append(sessionId, null, [
      { type: "session.created", data: { workspaceId: "w", permissionMode: "standard" } },
    ]);
    log.append(sessionId, "main", [
      { type: "agent.spawned", data: { role: "main", name: "主代理" } },
      { type: "turn.started", data: { turnId: "turn-recovery" } },
    ]);
    log.append(sessionId, "main", [{ type: "agent.status", data: { status: "waiting" } }]);
    expect(recoverInterruptedAgents({ db, log })).toBe(1);
    expect(db.prepare("SELECT status FROM agents WHERE id = 'main'").get()).toEqual({
      status: "interrupted",
    });
    db.close();
  });

  test("互发消息超过 10 条会暂停双方并通知主代理", () => {
    const dir = mkdtempSync(join(tmpdir(), "excelmanus-pingpong-"));
    dirs.push(dir);
    const db = openDb(join(dir, "test.db"), KERNEL_MIGRATIONS);
    const log = new SessionLog(db, { projections: kernelProjections() });
    const sessionId = newId("ses");
    log.append(sessionId, null, [
      { type: "session.created", data: { workspaceId: "w", permissionMode: "standard" } },
    ]);
    log.append(sessionId, "main", [
      { type: "agent.spawned", data: { role: "main", name: "主代理" } },
    ]);
    const team = new TeamCoordinator(db, log);
    const a = team.spawn({
      sessionId,
      parentAgentId: "main",
      name: "甲",
      role: "reader",
      task: "a",
    });
    const b = team.spawn({
      sessionId,
      parentAgentId: "main",
      name: "乙",
      role: "reader",
      task: "b",
    });
    expect("error" in a || "error" in b).toBe(false);
    if ("error" in a || "error" in b) return;
    for (let i = 0; i < 6; i += 1) {
      team.send({ sessionId, fromAgentId: a.agentId, to: [b.agentId], message: `a${i}` });
      team.send({ sessionId, fromAgentId: b.agentId, to: [a.agentId], message: `b${i}` });
    }
    expect(
      db
        .prepare("SELECT status FROM agents WHERE id IN (?, ?) ORDER BY id")
        .all(a.agentId, b.agentId),
    ).toEqual([{ status: "interrupted" }, { status: "interrupted" }]);
    expect(
      db.prepare("SELECT 1 FROM inbox_pending WHERE kind = 'notice' LIMIT 1").get(),
    ).toBeTruthy();
    db.close();
  });
});
