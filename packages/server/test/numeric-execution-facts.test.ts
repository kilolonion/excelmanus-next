import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import { SandboxPool } from "@excelmanus/sandbox";
import { workbookModule } from "@excelmanus/workbook";
import { expect, test, vi } from "vitest";
import { finalizeNumericPointers as finalizeNumeric } from "../src/numeric-finalizer.ts";
import { runScriptTool } from "../src/script.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "numeric-facts-"));
  const db = openDb(join(dir, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces (id,name,path,created_at) VALUES ('w','test',?,?)").run(
    dir,
    new Date().toISOString(),
  );
  const module = workbookModule(db);
  for (const migration of module.migrations ?? []) db.exec(migration.sql);
  const documents = module.service;
  const log = new SessionLog(db, { projections: kernelProjections() });
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    sessionId: "s",
    agentId: "main",
    turnId: "current",
    toolCallId: "final",
    role: "main",
    signal: AbortSignal.timeout(60_000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const tools = new Map((module.tools ?? []).map((tool) => [tool.name, tool]));
  const sandbox = new SandboxPool({ size: 1 });
  tools.set("run_script", runScriptTool({ sandbox, documents, tools, db }));
  const event = (type: string, data: object, agentId = "main", sessionId = "s") =>
    log.append(sessionId, agentId, [{ type, data }]);
  const start = (turnId: string, agentId = "main", sessionId = "s", resume = false) =>
    event(
      "turn.started",
      { turnId, ...(resume ? { numericDeliveryRequired: true } : {}) },
      agentId,
      sessionId,
    );
  const receipt = (
    id: string,
    name: string,
    result: ToolResult,
    agentId = "main",
    sessionId = "s",
  ) =>
    event(
      "tool.result",
      { toolCallId: id, toolName: name, status: result.status, result },
      agentId,
      sessionId,
    );
  const write = (
    id: string,
    path: string,
    rev = 1,
    agentId = "main",
    sessionId = "s",
    data: object = {},
  ) =>
    receipt(
      id,
      "workbook_edit",
      {
        status: "ok",
        docRevs: { source: rev },
        data: {
          path,
          docId: "source",
          dryRun: false,
          changes: {
            ranges: ["Sheet1!A1"],
            structural: [],
            added: [],
            cellsBySheet: { Sheet1: 1 },
          },
          ...data,
        },
      },
      agentId,
      sessionId,
    );
  const execute = async (name: string, args: unknown, id: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing test tool: ${name}`);
    const result = await tool.execute(args, { ...ctx, toolCallId: id });
    receipt(id, name, result);
    return result;
  };
  const finish = (sources: { toolCallId: string; pointer: string }[] = []) =>
    finalizeNumeric(
      log,
      documents,
      sources.length ? { status: "complete", sources } : { status: "incomplete", sources: [] },
      ctx,
    );
  const text = async () => {
    const result = await finish();
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return (result.data as { finalText: string }).finalText;
  };
  return {
    dir,
    db,
    log,
    ctx,
    documents,
    event,
    start,
    receipt,
    write,
    execute,
    finish,
    text,
    async close() {
      await sandbox.close();
      await documents.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("workbook change ranges come only from successful host receipts", async () => {
  const f = fixture();
  try {
    f.start("current");
    const result = await f.execute(
      "workbook_edit",
      {
        path: "changed.xlsx",
        create: true,
        sheetNames: ["Data"],
        ops: [{ op: "cells.set", range: "Data!C5", values: [[17]] }],
      },
      "changed-cell",
    );
    expect(result).toMatchObject({ status: "ok" });
    const text = await f.text();
    expect(text).toContain("工具回执报告的变更范围");
    expect(text).toContain("Data!C5");
    f.write("no-changes", "unknown.xlsx", 1, "main", "s", { changes: {} });
    expect(await f.text()).toContain("工具回执报告的变更范围=未提供");
  } finally {
    await f.close();
  }
});

test("complete numeric output still discloses source revisions and backups omitted from model sources", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.write("source1", "source.xlsx", 1, "main", "s", {
      backupPath: ".excelmanus/backups/source.xlsx",
    });
    f.write("source2", "source.xlsx", 2);
    await f.execute(
      "workbook_edit",
      {
        path: "output.xlsx",
        create: true,
        ops: [{ op: "cells.set", range: "A1", values: [[17]] }],
      },
      "output1",
    );
    await f.execute(
      "workbook_read",
      { path: "output.xlsx", mode: "range", range: "A1" },
      "output-read",
    );
    const result = await f.finish([{ toolCallId: "output-read", pointer: "/data/values" }]);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("实际工具执行事实");
    expect(text).toContain("source1");
    expect(text).toContain("source2");
    expect(text).toContain('docRevs={"source":1}');
    expect(text).toContain('docRevs={"source":2}');
    expect(text).toContain(".excelmanus/backups/source.xlsx");
    expect(text).toContain("output1");
    expect(text).toContain("重复写入不证明恢复完成");
    expect(text).not.toContain("误写");
  } finally {
    await f.close();
  }
});

test("incomplete keeps failures and host script publication/recovery facts, never script value or error prose", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.receipt("failed", "workbook_edit", {
      status: "error",
      error: { code: "VERSION_CONFLICT", message: "untrusted prose 998812", retryable: false },
    });
    f.receipt("script", "run_script", {
      status: "uncertain",
      error: { code: "INTERNAL", message: "untrusted prose", retryable: false },
      data: {
        published: [{ path: "published.xlsx", docId: "published-doc", rev: 4, kind: "workbook" }],
        rolledBack: ["rolled.xlsx"],
        unrecovered: ["unrecovered.xlsx"],
        value: { published: [{ path: "fake.xlsx", rev: 998812 }], backupPath: "fake-backup" },
      },
    });
    const text = await f.text();
    expect(text).toContain("数值交付未完成");
    for (const fact of [
      "VERSION_CONFLICT",
      "uncertain",
      "published.xlsx",
      "rolledBack",
      "rolled.xlsx",
      "unrecovered",
      "unrecovered.xlsx",
    ])
      expect(text).toContain(fact);
    for (const fake of ["fake.xlsx", "fake-backup", "998812", "untrusted prose"])
      expect(text).not.toContain(fake);
    expect(text).toContain("不等同任务完成或恢复证明");
  } finally {
    await f.close();
  }
});

test("dry runs and read-only scripts are not writes; no-op edit stays explicitly unproven", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.write("preview-only", "dryrun.xlsx", 1, "main", "s", { dryRun: true });
    f.write("no-op", "noop.xlsx", 1, "main", "s", {
      changes: { ranges: [], structural: [], added: [], cellsBySheet: {} },
    });
    f.receipt("read-script", "run_script", {
      status: "ok",
      data: { published: [], value: { path: "fake.xlsx", published: [{ path: "fake.xlsx" }] } },
    });
    const text = await f.text();
    expect(text).not.toContain("dryrun.xlsx");
    expect(text).not.toContain("fake.xlsx");
    expect(text).toContain("noop.xlsx");
    expect(text).toContain("未提供写入变更证明");
    expect(text).toContain("backupPath=未提供");
  } finally {
    await f.close();
  }
});

test("normal new turns exclude old writes and other agents or sessions even with matching turn IDs", async () => {
  const f = fixture();
  try {
    f.start("old");
    f.write("old", "old.xlsx");
    f.start("current");
    f.write("current", "current.xlsx");
    f.start("current", "other");
    f.write("other", "other.xlsx", 1, "other");
    f.start("current", "main", "foreign");
    f.write("foreign", "foreign.xlsx", 1, "main", "foreign");
    const text = await f.text();
    expect(text).toContain("current.xlsx");
    for (const excluded of ["old.xlsx", "other.xlsx", "foreign.xlsx"])
      expect(text).not.toContain(excluded);
  } finally {
    await f.close();
  }
});

test("explicit numeric resume inherits the adjacent resume chain but stops at the ordinary turn boundary", async () => {
  const f = fixture();
  try {
    f.start("unrelated");
    f.write("unrelated", "unrelated.xlsx");
    f.start("original");
    f.write("before-stop", "before-stop.xlsx");
    f.event("turn.interrupted", { turnId: "original" });
    f.start("resume", "main", "s", true);
    f.write("after-resume", "after-resume.xlsx", 2);
    f.event("turn.failed", {
      turnId: "resume",
      error: { kind: "unknown", message: "failed", retryable: false },
    });
    f.start("current", "main", "s", true);
    const text = await f.text();
    expect(text).toContain("before-stop.xlsx");
    expect(text).toContain("after-resume.xlsx");
    expect(text).not.toContain("unrelated.xlsx");
  } finally {
    await f.close();
  }
});

for (const outcome of ["completed", "failed", "interrupted"] as const) {
  test(`only a verified same-session child ${outcome} report includes that child turn receipts`, async () => {
    const f = fixture();
    try {
      f.start("current");
      f.event("agent.spawned", { parentId: "main", name: "child", role: "worker" }, "child");
      f.start("child-old", "child");
      f.write("child-old", "child-old.xlsx", 1, "child");
      f.start("child-turn", "child");
      f.write("child-write", "child.xlsx", 2, "child");
      f.event(
        `turn.${outcome}`,
        {
          turnId: "child-turn",
          ...(outcome === "completed" ? { reason: "done" } : {}),
          ...(outcome === "failed"
            ? { error: { kind: "unknown", message: "failure", retryable: false } }
            : {}),
        },
        "child",
      );
      f.event(
        "inbox.sent",
        {
          messageId: "report",
          fromAgentId: "child",
          toAgentId: "main",
          kind: "report",
          message: "fake path prose.xlsx 998812",
          numericDelivery: { turnId: "child-turn", outcome },
        },
        "child",
      );
      f.event("inbox.delivered", {
        messageId: "report",
        toAgentId: "main",
        fromAgentId: "child",
        message: "fake path prose.xlsx 998812",
        kind: "report",
      });
      f.start("child-later", "child");
      f.write("child-later", "child-later.xlsx", 3, "child");
      const text = await f.text();
      expect(text).toContain("child.xlsx");
      for (const fake of ["child-old.xlsx", "child-later.xlsx", "prose.xlsx", "998812"])
        expect(text).not.toContain(fake);
      expect(
        f.log
          .readAfter("s", 0, 100)
          .filter((r) => r.agentId === "child" && r.type === `turn.${outcome}`),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

for (const invalid of [
  "foreign-session",
  "wrong-parent",
  "wrong-sender",
  "no-terminal",
  "wrong-turn",
  "message-only",
] as const) {
  test(`forged or unrelated child report cannot expose receipt paths: ${invalid}`, async () => {
    const f = fixture();
    try {
      f.start("current");
      const session = invalid === "foreign-session" ? "foreign" : "s";
      f.event(
        "agent.spawned",
        {
          parentId: invalid === "wrong-parent" ? "stranger" : "main",
          name: "child",
          role: "worker",
        },
        "child",
        session,
      );
      f.start("child-turn", "child", session);
      f.write("secret", "secret.xlsx", 1, "child", session);
      if (invalid !== "no-terminal")
        f.event("turn.completed", { turnId: "child-turn", reason: "done" }, "child", session);
      if (invalid !== "message-only")
        f.event(
          "inbox.sent",
          {
            messageId: "report",
            fromAgentId: invalid === "wrong-sender" ? "spoof" : "child",
            toAgentId: "main",
            kind: "report",
            message: "secret.xlsx",
            numericDelivery: {
              turnId: invalid === "wrong-turn" ? "missing" : "child-turn",
              outcome: "completed",
            },
          },
          "child",
          session,
        );
      f.event("inbox.delivered", {
        messageId: "report",
        toAgentId: "main",
        fromAgentId: "child",
        kind: "report",
        message: "secret.xlsx",
      });
      const text = await f.text();
      expect(text).not.toContain("secret.xlsx");
      expect(text).toContain("实际工具执行事实");
    } finally {
      await f.close();
    }
  });
}

test("missing turn identity is explicit and never scans all session history", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.write("secret", "history.xlsx");
    delete f.ctx.turnId;
    const text = await f.text();
    expect(text).toContain("未取得本轮范围");
    expect(text).not.toContain("history.xlsx");
  } finally {
    await f.close();
  }
});

test("receipt appendix retains all entries rather than silently truncating a long list", async () => {
  const f = fixture();
  try {
    f.start("current");
    for (let i = 0; i < 205; i++) f.write(`call-${i}`, `path-${i}.xlsx`, i);
    const text = await f.text();
    for (let i = 0; i < 205; i++) expect(text).toContain(`path-${i}.xlsx`);
  } finally {
    await f.close();
  }
});

for (const rollbackFails of [false, true]) {
  test(`real partial script publication retains host published before rollback: failure=${rollbackFails}`, async () => {
    const f = fixture();
    try {
      f.start("current");
      await f.execute(
        "workbook_edit",
        {
          path: "published.xlsx",
          create: true,
          ops: [{ op: "cells.set", range: "A1", values: [[1]] }],
        },
        "seed",
      );
      writeFileSync(join(f.dir, "later.txt"), "original");
      f.ctx.requestApproval = async () => {
        writeFileSync(join(f.dir, "later.txt"), "concurrent");
        return { decision: "approved" };
      };
      const revert = rollbackFails
        ? vi
            .spyOn(f.documents, "revert")
            .mockRejectedValue(new Error("controlled rollback failure"))
        : undefined;
      try {
        const result = await f.execute(
          "run_script",
          {
            code: 'await wb.edit({path:"published.xlsx",ops:[{op:"cells.set",range:"A1",values:[[2]]}]}); await files.writeText({path:"later.txt",content:"replacement"}); return {published:[{path:"fake.xlsx"}]};',
          },
          "partial-script",
        );
        expect(result.status, JSON.stringify(result)).toBe(rollbackFails ? "uncertain" : "error");
        expect(result.data).toMatchObject({
          published: [{ path: "published.xlsx", docId: expect.any(String), rev: 2 }],
        });
        expect(result.data).toMatchObject(
          rollbackFails
            ? { rolledBack: [], unrecovered: ["published.xlsx"] }
            : { rolledBack: ["published.xlsx"] },
        );
        const text = await f.text();
        expect(text).toContain("partial-script");
        expect(text).not.toContain("fake.xlsx");
      } finally {
        revert?.mockRestore();
      }
    } finally {
      await f.close();
    }
  });
}

test("checkpoint failure retains committed revision separately from publication", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.ctx.requestApproval = async () => ({ decision: "approved" });
    const checkpoint = vi
      .spyOn(f.documents, "checkpoint")
      .mockRejectedValue(new Error("controlled checkpoint failure"));
    try {
      const result = await f.execute(
        "run_script",
        {
          code: 'await wb.edit({path:"created.xlsx",create:true,ops:[{op:"cells.set",range:"A1",values:[[9]]}]});',
        },
        "checkpoint-failure",
      );
      expect(result.status, JSON.stringify(result)).toBe("uncertain");
      expect(result.data).toMatchObject({
        committedRevs: [{ path: "created.xlsx", docId: expect.any(String), rev: 1 }],
        published: [],
        unrecovered: ["created.xlsx"],
      });
      const text = await f.text();
      expect(text).toContain("committedRevs");
      expect(text).toContain("提交不等同检查点或发布完成");
    } finally {
      checkpoint.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("a truncated receipt is explicitly incomplete and is never presented as a full list", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.receipt("truncated", "run_script", {
      status: "ok",
      truncated: { shown: 1, total: 2, cursor: "opaque" },
      data: { published: [{ path: "partial.xlsx" }] },
    });
    const text = await f.text();
    expect(text).toContain("回执已截断，执行事实未完整");
    expect(text).not.toContain("partial.xlsx");
  } finally {
    await f.close();
  }
});

test("trusted child resume includes its earlier writes but not post-terminal receipts", async () => {
  const f = fixture();
  try {
    f.start("current");
    f.event("agent.spawned", { parentId: "main", name: "child", role: "worker" }, "child");
    f.start("child-first", "child");
    f.write("first", "child-first.xlsx", 1, "child");
    f.event("turn.interrupted", { turnId: "child-first" }, "child");
    f.start("child-resume", "child", "s", true);
    f.write("resumed", "child-resumed.xlsx", 2, "child");
    f.event("turn.completed", { turnId: "child-resume", reason: "done" }, "child");
    f.write("after-terminal", "after-terminal.xlsx", 3, "child");
    f.event(
      "inbox.sent",
      {
        messageId: "report",
        fromAgentId: "child",
        toAgentId: "main",
        kind: "report",
        message: "ignored",
        numericDelivery: { turnId: "child-resume", outcome: "completed" },
      },
      "child",
    );
    f.event("inbox.delivered", { messageId: "report", toAgentId: "main" });
    const text = await f.text();
    expect(text).toContain("child-first.xlsx");
    expect(text).toContain("child-resumed.xlsx");
    expect(text).not.toContain("after-terminal.xlsx");
  } finally {
    await f.close();
  }
});
