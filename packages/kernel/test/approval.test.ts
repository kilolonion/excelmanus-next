import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ApprovalCoordinator, needsApproval } from "../src/approvals.ts";
import { openDb } from "../src/db.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import { kernelProjections } from "../src/projections.ts";
import { SessionLog } from "../src/session-log.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M2c approval", () => {
  test("permission matrix and durable idempotent decision", () => {
    expect(needsApproval("standard", "write")).toBe(false);
    expect(needsApproval("standard", "destructive")).toBe(true);
    expect(needsApproval("confirm", "write")).toBe(true);
    expect(needsApproval("auto", "destructive")).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "excelmanus-approval-"));
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
    const coordinator = new ApprovalCoordinator(db, log);
    const requested = coordinator.request("ses_1", "main", {
      toolCallId: "tc_1",
      toolName: "files",
      args: { ops: [{ op: "delete", path: "a.txt" }] },
      targets: ["a.txt"],
      effect: "destructive",
    });
    expect(requested.status).toBe("pending");
    expect(
      (
        db.prepare("SELECT status FROM agents WHERE session_id='ses_1' AND id='main'").get() as {
          status: string;
        }
      ).status,
    ).toBe("blocked");
    const first = coordinator.decide(requested.id, "approved", undefined, true);
    expect(first.idempotent).toBe(false);
    expect(first.row.status).toBe("approved");
    expect(
      (
        db.prepare("SELECT COUNT(*) n FROM auto_approve_rules WHERE session_id='ses_1'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    const second = coordinator.decide(requested.id, "denied", "重复决定");
    expect(second.idempotent).toBe(true);
    expect(second.row.decision).toBe("approved");
    db.close();
  });
});
