import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkBudget, emptyBudgetUsage, parseBudget } from "../src/budget.ts";
import { openDb } from "../src/db.ts";
import { FileLeaseError, LeaseService } from "../src/leases.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M3 文件租约", () => {
  test("写目标冲突时拒绝，释放后可继续", () => {
    const dir = mkdtempSync(join(tmpdir(), "excelmanus-lease-"));
    dirs.push(dir);
    const db = openDb(join(dir, "db.sqlite"), KERNEL_MIGRATIONS);
    const leases = new LeaseService(db);
    const held = leases.acquire({
      sessionId: "ses_1",
      agentId: "agt_a",
      targets: ["outputs/a.xlsx"],
    });
    expect(held).toHaveLength(1);
    expect(() =>
      leases.assertAvailable({ sessionId: "ses_1", agentId: "agt_b", targets: ["outputs/a.xlsx"] }),
    ).toThrow(FileLeaseError);
    expect(() =>
      leases.acquire({ sessionId: "ses_1", agentId: "agt_b", targets: ["outputs/a.xlsx"] }),
    ).toThrow(FileLeaseError);
    expect(leases.releaseForAgent("ses_1", "agt_a")).toBe(1);
    expect(() =>
      leases.assertAvailable({ sessionId: "ses_1", agentId: "agt_b", targets: ["outputs/a.xlsx"] }),
    ).not.toThrow();
    db.close();
  });

  test("不同 sheet 区域不冲突，同区域冲突", () => {
    const dir = mkdtempSync(join(tmpdir(), "excelmanus-lease-range-"));
    dirs.push(dir);
    const db = openDb(join(dir, "db.sqlite"), KERNEL_MIGRATIONS);
    const leases = new LeaseService(db);
    leases.acquire({ sessionId: "ses_1", agentId: "agt_a", targets: ["book.xlsx!Sheet1!A1:B2"] });
    expect(() =>
      leases.assertAvailable({
        sessionId: "ses_1",
        agentId: "agt_b",
        targets: ["book.xlsx!Sheet2!A1:B2"],
      }),
    ).not.toThrow();
    expect(() =>
      leases.assertAvailable({
        sessionId: "ses_1",
        agentId: "agt_b",
        targets: ["book.xlsx!Sheet1!B2:C3"],
      }),
    ).toThrow(FileLeaseError);
    db.close();
  });
});

describe("M3 预算护栏", () => {
  test("步数与工具调用达到上限时返回 LIMIT", () => {
    const budget = parseBudget('{"maxSteps":2,"maxToolCalls":3}');
    const usage = { ...emptyBudgetUsage(), steps: 3, toolCalls: 1 };
    expect(checkBudget(budget, usage)).toMatchObject({ ok: false, limit: "maxSteps", max: 2 });
    expect(checkBudget(budget, { ...usage, steps: 1, toolCalls: 4 })).toMatchObject({
      ok: false,
      limit: "maxToolCalls",
      max: 3,
    });
  });
});
