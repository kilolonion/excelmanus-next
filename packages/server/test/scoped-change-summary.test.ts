import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  BACKUPS_MIGRATION,
  BackupService,
  type ChangeSummarySource,
  describeDocChange,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  SessionLog,
  SyncBus,
  TeamCoordinator,
} from "@excelmanus/kernel";
import { workbookModule } from "@excelmanus/workbook";
import { expect, test, vi } from "vitest";
import { workbookChangeSummary } from "../src/change-summary.ts";

for (const target of ["main", "child", "unbounded"] as const)
  test(`afterTurn ${target} uses stored metadata only when scoped`, async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "scoped-summary-"));
    fs.mkdirSync(join(dir, "allowed"));
    const db = openDb(join(dir, "state.db"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
    db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('w','test',?,?)").run(
      dir,
      new Date().toISOString(),
    );
    const module = workbookModule(db);
    for (const migration of module.migrations ?? []) db.exec(migration.sql);
    const log = new SessionLog(db, { projections: kernelProjections() });
    log.append("s", null, [
      { type: "session.created", data: { workspaceId: "w", permissionMode: "auto" } },
    ]);
    log.append("s", "main", [
      { type: "agent.spawned", data: { role: "main", name: "main", modelProfileId: null } },
    ]);
    let agentId = "main",
      dispatchId = "d";
    if (target === "child") {
      log.append("s", "main", [
        {
          type: "turn.started",
          data: {
            turnId: "parent-t",
            accessBinding: {
              originAgentId: "main",
              originTurnId: "parent-t",
              sourceDispatchIds: [],
              ruleVersion: 1,
              decision: { kind: "restricted", root: "allowed" },
              accessDeliveryRequired: true,
            },
          },
        },
      ]);
      const child = new TeamCoordinator(db, log).spawn({
        sessionId: "s",
        parentAgentId: "main",
        sourceTurnId: "parent-t",
        name: "worker",
        role: "worker",
        task: "修改allowed/book.xlsx",
      });
      if ("error" in child) throw new Error("spawn failed");
      agentId = child.agentId;
      dispatchId = (
        db.prepare("SELECT id FROM dispatches WHERE agent_id=?").get(agentId) as { id: string }
      ).id;
    } else
      log.append("s", agentId, [
        {
          type: "user.message",
          data: {
            dispatchId,
            clientMessageId: dispatchId,
            text:
              target === "unbounded" ? "创建allowed/book.xlsx" : "仅访问目录 allowed，创建工作簿",
            mode: "steer",
            accessInputOrigin: "user",
          },
        },
      ]);
    const original = workbookChangeSummary(db, module.service);
    let inSummary = false;
    let physical = 0;
    let calls = 0;
    const observed: Parameters<ChangeSummarySource["summarize"]>[0][] = [];
    const snapshot = vi.spyOn(module.service, "snapshot");
    const stat = fs.statSync;
    Reflect.set(fs, "statSync", ((...args: Parameters<typeof fs.statSync>) => {
      if (inSummary && String(args[0]).endsWith("book.xlsx")) physical++;
      return Reflect.apply(stat, fs, args);
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    const runtime = new AgentRuntime({
      db,
      log,
      bus: new SyncBus(),
      backups: new BackupService(db),
      tools: new Map(module.tools!.map((t) => [t.name, t])),
      toolSpecsFor: () => [],
      workspaceRoot: () => dir,
      workspaceId: () => "w",
      resolveModel: () => ({ provider: "mock", model: "mock", profileId: "mock" }) as never,
      changeSummary: {
        async summarize(input) {
          observed.push(input);
          expect(
            db
              .prepare(
                "SELECT 1 FROM session_log WHERE session_id='s' AND agent_id=? AND type IN ('turn.completed','turn.failed')",
              )
              .get(agentId),
          ).toBeTruthy();
          inSummary = true;
          try {
            return await original.summarize(input);
          } finally {
            inSummary = false;
          }
        },
      },
      gateway: {
        async *step() {
          if (calls++ === 0) {
            const args = {
              path: "allowed/book.xlsx",
              create: true,
              sheetNames: ["Data"],
              ops: [{ op: "cells.set", range: "Data!A1", values: [["hello"]] }],
            };
            yield {
              kind: "tool.call",
              toolCallId: "edit",
              toolName: "workbook_edit",
              args,
              rawArgs: JSON.stringify(args),
            };
            yield { kind: "finish", reason: "tool-calls" };
          } else {
            yield { kind: "text.delta", text: "done" };
            yield { kind: "finish", reason: "stop" };
          }
        },
      },
    });
    try {
      runtime.enqueue("s", agentId, dispatchId, "steer");
      const end = Date.now() + 10000;
      while (runtime.isRunning("s", agentId) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 10));
      expect(runtime.isRunning("s", agentId)).toBe(false);
      expect(observed).toHaveLength(1);
      expect(observed[0]?.storedOnly).toBe(target !== "unbounded");
      const summary = db
        .prepare(
          "SELECT data FROM session_log WHERE session_id='s' AND agent_id=? AND type='change.summary'",
        )
        .get(agentId) as { data: string } | undefined;
      expect(summary).toBeDefined();
      expect(JSON.parse(summary!.data).changes.docs[0]).toMatchObject({
        path: "allowed/book.xlsx",
        cellsBySheet: { Data: 1 },
      });
      if (target === "unbounded") {
        expect(snapshot).toHaveBeenCalled();
        expect(physical).toBeGreaterThan(0);
      } else {
        expect(snapshot).not.toHaveBeenCalled();
        expect(physical).toBe(0);
        db.exec("UPDATE documents SET checkpoint_snapshot=NULL; UPDATE doc_ops SET inverse='{}'");
        const fallback = await original.summarize({ ...observed[0]!, storedOnly: true });
        expect(fallback[0]?.metadataLimited).toBe(true);
        expect(describeDocChange(fallback[0]!)).toContain("已存工作表名称元数据不足");
        expect(snapshot).not.toHaveBeenCalled();
      }
    } finally {
      Reflect.set(fs, "statSync", stat);
      syncBuiltinESMExports();
      snapshot.mockRestore();
      await module.service.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
