// M2a 活文档写入测试：真实 samples/sales.xlsx + 临时 SQLite。
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import type { ICellData } from "@univerjs/core";
import { describe, expect, it } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

const SAMPLE_XLSX = fileURLToPath(new URL("../../../../samples/sales.xlsx", import.meta.url));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xman-edit-"));
  copyFileSync(SAMPLE_XLSX, join(dir, "sales.xlsx"));
  const db = openDb(join(dir, "test.db"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  const { meta } = await svc.open("ws1", dir, "sales.xlsx");
  return { dir, db, svc, docId: meta.id };
}

async function sheetId(svc: DocumentService, root: string, docId: string): Promise<string> {
  const { snapshot } = await svc.snapshot(docId, root);
  return snapshot.sheetOrder[0] ?? "";
}

async function cellAt(
  svc: DocumentService,
  root: string,
  docId: string,
  row: number,
  col: number,
): Promise<ICellData | undefined> {
  const { snapshot } = await svc.snapshot(docId, root);
  const sheet = snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
  return (sheet?.cellData?.[row] as Record<number, ICellData> | undefined)?.[col];
}

describe("DocumentService.submit", () => {
  it("cells.set 提交后 rev=1 且读回值/公式正确", async () => {
    const { dir, svc, docId } = await setup();
    const result = await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "s1:main" },
      ops: [{ op: "cells.set", range: "销售!A60", values: [["测试", 42, "=B60*2"]] }],
    });
    expect(result).toMatchObject({ ok: true, rev: 1 });
    expect(await cellAt(svc, dir, docId, 59, 0)).toMatchObject({ v: "测试" });
    expect(await cellAt(svc, dir, docId, 59, 1)).toMatchObject({ v: 42 });
    expect(await cellAt(svc, dir, docId, 59, 2)).toMatchObject({ f: "=B60*2" });
  });

  it("stale baseRev + 读集重叠 → VERSION_CONFLICT；不重叠 → 成功", async () => {
    const { dir, svc, docId } = await setup();
    const sid = await sheetId(svc, dir, docId);
    await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "s1:main" },
      ops: [{ op: "cells.set", range: "销售!B5", values: [["已改"]] }],
    });
    const overlap = await svc.submit(docId, dir, {
      baseRev: 0,
      readSet: [{ sheetId: sid, r0: 4, c0: 0, r1: 4, c1: 2 }],
      source: { kind: "agent", id: "s2:main" },
      ops: [{ op: "cells.set", range: "销售!C5", values: [["x"]] }],
    });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.code).toBe("VERSION_CONFLICT");
      expect(overlap.conflicts?.[0]?.rev).toBe(1);
      expect(overlap.conflicts?.[0]?.cells.join(",")).toContain("B5");
    }
    const disj = await svc.submit(docId, dir, {
      baseRev: 0,
      readSet: [{ sheetId: sid, r0: 10, c0: 0, r1: 10, c1: 2 }],
      source: { kind: "agent", id: "s2:main" },
      ops: [{ op: "cells.set", range: "销售!A11", values: [["另一处"]] }],
    });
    expect(disj).toMatchObject({ ok: true, rev: 2 });
    expect(await cellAt(svc, dir, docId, 10, 0)).toMatchObject({ v: "另一处" });
  });

  it("rows.insert 后旧 baseRev 的坐标被平移写入", async () => {
    const { dir, svc, docId } = await setup();
    await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "user", id: "u1" },
      ops: [{ op: "rows.insert", sheet: "销售", at: 3, count: 1 }],
    });
    // 代理仍拿着旧快照：写原坐标 B8（行索引 7）应平移到新 B9（行索引 8）
    const res = await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "s1:main" },
      ops: [{ op: "cells.set", range: "销售!B8", values: [["平移"]] }],
    });
    expect(res).toMatchObject({ ok: true, rev: 2 });
    expect(await cellAt(svc, dir, docId, 8, 1)).toMatchObject({ v: "平移" });
  });

  it("dryRun 不改 rev 且状态回滚", async () => {
    const { dir, svc, docId } = await setup();
    const dry = await svc.submit(docId, dir, {
      baseRev: 0,
      dryRun: true,
      source: { kind: "agent", id: "s1:main" },
      ops: [{ op: "cells.set", range: "销售!A60", values: [["预览"]] }],
    });
    expect(dry).toMatchObject({ ok: true, dryRun: true, rev: 0 });
    expect(dry.ok && dry.preview && dry.preview.length > 0).toBe(true);
    expect(svc.headRev(docId)).toBe(0);
    expect(await cellAt(svc, dir, docId, 59, 0)).toBeUndefined();
  });

  it("同一 db 新建 DocumentService 重开后重放值一致", async () => {
    const { dir, db, svc, docId } = await setup();
    await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "s1:main" },
      ops: [{ op: "cells.set", range: "销售!A60:C60", values: [["x", 7, "=B60*10"]] }],
    });
    const svc2 = new DocumentService(db);
    const { meta } = await svc2.snapshot(docId, dir);
    expect(meta.rev).toBe(1);
    expect(await cellAt(svc2, dir, docId, 59, 0)).toMatchObject({ v: "x" });
    expect(await cellAt(svc2, dir, docId, 59, 2)).toMatchObject({ f: "=B60*10" });
  });

  it("recover：已提交的 tool_call_id 返回幂等 ok，未提交返回 undefined", async () => {
    const { dir, svc, docId } = await setup();
    await svc.submit(docId, dir, {
      baseRev: 0,
      source: { kind: "agent", id: "s1:main" },
      sessionId: "s1",
      toolCallId: "tc-1",
      ops: [{ op: "cells.set", range: "销售!A60", values: [["y"]] }],
    });
    const tool = workbookEditTool(svc);
    const hit = tool.recover?.({
      sessionId: "s1",
      agentId: "main",
      toolCallId: "tc-1",
      args: { docId, ops: [] },
    });
    expect(hit?.status).toBe("ok");
    const miss = tool.recover?.({
      sessionId: "s1",
      agentId: "main",
      toolCallId: "tc-x",
      args: { docId, ops: [] },
    });
    expect(miss).toBeUndefined();
  });
});
