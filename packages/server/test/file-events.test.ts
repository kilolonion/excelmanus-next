import { SyncBus } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { installFileEvents } from "../src/file-events.ts";

test("agent file writes refresh the owning workspace, including files created by export", () => {
  const bus = new SyncBus();
  const events: unknown[] = [];
  bus.subscribe((e) => {
    if (e.kind === "app") events.push(e.data);
  });
  const off = installFileEvents(bus, (sessionId) => (sessionId === "qa" ? "workspace" : undefined));
  const publish = (toolName: string, status = "ok", resultData: Record<string, unknown> = {}) =>
    bus.publish({
      kind: "rec",
      rec: {
        seq: 1,
        sessionId: "qa",
        agentId: "main",
        createdAt: "2026-10-12T00:00:00Z",
        type: "tool.result",
        data: { toolName, status, result: { status, data: resultData } },
      },
    });
  publish("workbook_read");
  expect(events).toEqual([]);
  publish("workbook_export");
  publish("write");
  publish("workbook_edit", "denied");
  expect(events).toEqual([
    { type: "files.changed", workspaceId: "workspace" },
    { type: "files.changed", workspaceId: "workspace" },
  ]);
  publish("workbook_analyze", "ok", { saved: { path: "query.xlsx" } });
  expect(events).toHaveLength(3);
  off();
  publish("write");
  expect(events).toHaveLength(3);
});
