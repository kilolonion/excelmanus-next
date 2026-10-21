// 活文档并发回归（审计 P0-02/03/08、P1-07/23/32/34/37）：真实 samples/sales.xlsx + 临时 SQLite。
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDerivedWorkbookMutation } from "@excelmanus/core";
import type { ToolContext, ToolDefinition } from "@excelmanus/kernel";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  persistedReads,
} from "@excelmanus/kernel";
import type { ToolResult } from "@excelmanus/protocol";
import type { ICellData } from "@univerjs/core";
import { afterAll, describe, expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import { bootUniver, createBook } from "../src/engine.ts";
import { workbookRenderTool } from "../src/render.ts";
import {
  CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { deriveWriteSet } from "../src/writeset.ts";

const SAMPLE = fileURLToPath(new URL("../../../../samples/sales.xlsx", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MIGRATIONS = [
  ...KERNEL_MIGRATIONS,
  DOCUMENTS_MIGRATION,
  DOC_OPS_MIGRATION,
  BACKUPS_MIGRATION,
  CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
];

function workspace(base: string, id: string) {
  const root = join(base, id);
  mkdirSync(root, { recursive: true });
  cpSync(SAMPLE, join(root, "sales.xlsx"));
  return root;
}

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "xman-conc-"));
  dirs.push(base);
  const root = workspace(base, "ws1");
  const dbPath = join(base, "db.sqlite");
  const db = openDb(dbPath, MIGRATIONS);
  db.prepare(
    "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('ws1', 'ws1', ?, 1, 0, '2026-01-01T00:00:00.000Z')",
  ).run(root);
  const svc = new DocumentService(db);
  const { meta } = await svc.open("ws1", root, "sales.xlsx");
  return { base, root, db, dbPath, svc, docId: meta.id };
}

function ctxOf(
  db: ReturnType<typeof openDb>,
  root: string,
  agentId: string,
  reads = createReadTable(),
): ToolContext {
  return {
    workspaceId: "ws1",
    workspaceRoot: root,
    signal: AbortSignal.timeout(30_000),
    sessionId: "ses1",
    agentId,
    toolCallId: `tc-${Math.random()}`,
    role: "main",
    reads,
    backups: new BackupService(db).bind({
      workspaceId: "ws1",
      workspaceRoot: root,
      sessionId: "ses1",
      agentId,
    }),
  };
}

async function cell(svc: DocumentService, root: string, docId: string, a1Row: number, col = 0) {
  const { snapshot } = await svc.snapshot(docId, root);
  const sheet = snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
  return (sheet?.cellData?.[a1Row - 1] as Record<number, ICellData> | undefined)?.[col]?.v;
}

const user = { kind: "user" as const, id: "u1" };
const agentY = { kind: "agent" as const, id: "ses1/Y" };
const agentZ = { kind: "agent" as const, id: "ses1/Z" };

function tool(svc: DocumentService, name: string): ToolDefinition {
  const t = [...workbookTools(svc), workbookEditTool(svc)].find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
}

describe("读集按区域记录读取修订（P0-02）", () => {
  test("真实引擎事件区分用户公式/样式与派生结果；截图观察在重建读集中保留", async () => {
    const { db, root, svc, docId } = await setup();
    const { snapshot } = await svc.snapshot(docId, root);
    const boot = bootUniver();
    const seen: { id: string; params: unknown }[] = [];
    boot.onCommandExecuted((info) => {
      if (info.id.includes(".mutation.")) seen.push({ id: info.id, params: info.params });
    });
    try {
      const book = createBook(boot, structuredClone(snapshot));
      await boot.executeCommand("sheet.command.set-range-values", {
        unitId: book.unitId,
        subUnitId: "s0",
        range: { startRow: 59, endRow: 59, startColumn: 0, endColumn: 1 },
        value: [[{ v: 12345 }, { f: "=A60*2" }]],
      });
      await boot.executeCommand("sheet.command.set-style", {
        unitId: book.unitId,
        subUnitId: "s0",
        range: { startRow: 59, endRow: 59, startColumn: 0, endColumn: 1 },
        style: { type: "n", value: { pattern: "#,##0" } },
      });
      await boot.waitCalc(3000);
      const authored = seen.filter((m) => !isDerivedWorkbookMutation(m));
      expect(
        authored.some(
          (m) =>
            m.id === "sheet.mutation.set-range-values" &&
            (m.params as { trigger?: string }).trigger === "sheet.command.set-range-values",
        ),
      ).toBe(true);
      expect(
        authored.some(
          (m) =>
            m.id === "sheet.mutation.set-range-values" &&
            (m.params as { trigger?: string }).trigger === "sheet.command.set-style",
        ),
      ).toBe(true);
      expect(
        seen.some(
          (m) => m.id === "sheet.mutation.set-range-values" && isDerivedWorkbookMutation(m),
        ),
      ).toBe(true);
      expect(authored.some((m) => m.id.startsWith("formula.mutation."))).toBe(false);
      const renderer = workbookRenderTool(svc, async () => "rendered");
      const ctx = ctxOf(db, root, "main");
      const rendered = await renderer.execute({ docId, range: "销售!A1:F4" }, ctx);
      expect(ctx.reads.get(docId)?.ranges).toEqual([
        { sheetId: "s0", r0: 0, c0: 0, r1: 3, c1: 5, rev: 0 },
      ]);
      db.prepare(
        "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES ('main', 'ses1', 0, ?, 1)",
      ).run(
        JSON.stringify({
          kind: "toolResult",
          toolCallId: "render",
          toolName: "workbook_render",
          output: rendered,
        }),
      );
      const restored = createReadTable(() => persistedReads(db, "ses1", "main"));
      expect(restored.get(docId)?.ranges).toEqual([
        { sheetId: "*", sheetName: "销售", r0: 0, c0: 0, r1: 3, c1: 5, rev: 0 },
      ]);
    } finally {
      await boot.dispose();
      await svc.close();
      db.close();
    }
  });

  test("稀疏写集不扩大到未改格；分块重读后可继续写，未读空洞仍冲突", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A1:C4" }, ctx);
    const mutation = {
      id: "sheet.mutation.set-range-values",
      params: {
        unitId: (await svc.snapshot(docId, root)).snapshot.id,
        subUnitId: "s0",
        trigger: "sheet.command.set-range-values",
        cellValue: { 0: { 0: { v: "a" }, 2: { v: "c" } }, 3: { 0: { v: "d" }, 1: { v: "e" } } },
      },
    };
    expect(deriveWriteSet(mutation).ranges).toEqual([
      { sheetId: "s0", r0: 0, c0: 0, r1: 0, c1: 0 },
      { sheetId: "s0", r0: 0, c0: 2, r1: 0, c1: 2 },
      { sheetId: "s0", r0: 3, c0: 0, r1: 3, c1: 1 },
    ]);
    expect(
      await svc.submit(docId, root, { baseRev: 0, source: user, mutations: [mutation] }),
    ).toMatchObject({ ok: true, rev: 1 });
    await read.execute({ docId, mode: "range", range: "销售!A1" }, ctx);
    await read.execute({ docId, mode: "range", range: "销售!A4" }, ctx);
    expect(
      (
        await edit.execute(
          { docId, baseRev: 1, ops: [{ op: "style.set", range: "销售!H17", bold: true }] },
          ctx,
        )
      ).error?.code,
    ).toBe("VERSION_CONFLICT");
    await read.execute({ docId, mode: "range", range: "销售!C1" }, ctx);
    await read.execute({ docId, mode: "range", range: "销售!B4" }, ctx);
    expect(
      await edit.execute({ docId, ops: [{ op: "style.set", range: "销售!H17", bold: true }] }, ctx),
    ).toMatchObject({ status: "ok" });
    // 单一连续写集由相邻两次重读的并集覆盖，也须放行。
    await svc.submit(docId, root, {
      baseRev: svc.headRev(docId),
      source: user,
      ops: [{ op: "cells.set", range: "销售!A2:C2", values: [[1, 2, 3]] }],
    });
    await read.execute({ docId, mode: "range", range: "销售!A2:B2" }, ctx);
    await read.execute({ docId, mode: "range", range: "销售!C2" }, ctx);
    expect(
      await edit.execute({ docId, ops: [{ op: "style.set", range: "销售!H18", bold: true }] }, ctx),
    ).toMatchObject({ status: "ok" });
    await svc.close();
    db.close();
  });

  test("用户改了读过的格 → 冲突；重读该格后可写，旧读集不再造成永久冲突", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A2" }, ctx);
    await read.execute({ docId, mode: "range", range: "销售!F1:F3" }, ctx);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "cells.set", range: "销售!A2", values: [["用户"]] }],
    });
    const first = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A2", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(first.error?.code).toBe("VERSION_CONFLICT");
    const reread = (await read.execute(
      { docId, mode: "range", range: "销售!A2" },
      ctx,
    )) as ToolResult;
    expect(reread.status).toBe("ok");
    const second = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A2", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(second.status).toBe("ok");
    expect(await cell(svc, root, docId, 2)).toBe("代理");
  });
});

describe("结构操作后的冲突判定在同一坐标系（P0-03）", () => {
  test("插行后 stale 写同一格 → 冲突（不再静默覆盖用户值）", async () => {
    const { root, svc, docId } = await setup();
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "cells.set", range: "销售!A11", values: [["用户"]] }],
    });
    const ins = await svc.submit(docId, root, {
      baseRev: 1,
      source: agentY,
      ops: [{ op: "rows.insert", sheet: "销售", at: 2, count: 1 }],
    });
    expect(ins.ok).toBe(true);
    const z = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "cells.set", range: "销售!A11", values: [["代理Z"]] }],
    });
    expect(z).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await cell(svc, root, docId, 12)).toBe("用户");
  });

  test("插行后 stale 写相邻格 → 不再报假冲突，且落到平移后位置", async () => {
    const { root, svc, docId } = await setup();
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "cells.set", range: "销售!A12", values: [["用户"]] }],
    });
    await svc.submit(docId, root, {
      baseRev: 1,
      source: agentY,
      ops: [{ op: "rows.insert", sheet: "销售", at: 2, count: 1 }],
    });
    const z = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "cells.set", range: "销售!A11", values: [["代理Z"]] }],
    });
    expect(z.ok).toBe(true);
    expect(await cell(svc, root, docId, 12)).toBe("代理Z");
    expect(await cell(svc, root, docId, 13)).toBe("用户");
  });
});

describe("代理自动读集路径的坐标依据（审查 DC-1/DC-2）", () => {
  test("读过的区域被用户在上方插行平移 → 自动变换后写入，不报冲突（03 §6.1）", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A5:B20" }, ctx);
    const orig = await cell(svc, root, docId, 11);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.insert", sheet: "销售", at: 2, count: 1 }],
    });
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!B11", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.status, JSON.stringify(r.error)).toBe("ok");
    expect(await cell(svc, root, docId, 12, 1)).toBe("代理");
    expect(await cell(svc, root, docId, 12)).toBe(orig);
  });

  test("读 A5:A10 → 用户删 5-10 行 → 读同表 Z1 → 写 A5：冲突，不覆盖上移来的数据", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A5:A10" }, ctx);
    const moved = await cell(svc, root, docId, 11);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.delete", sheet: "销售", at: 5, count: 6 }],
    });
    await read.execute({ docId, mode: "range", range: "销售!Z1" }, ctx);
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A5", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.error?.code).toBe("VERSION_CONFLICT");
    expect(await cell(svc, root, docId, 5)).toBe(moved);
    // 写无关区域也提示删除（读集依据已失效）；在 head 坐标重读删除点后可写
    await read.execute({ docId, mode: "range", range: "销售!A5:A10" }, ctx);
    const ok = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A5", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(ok.status, JSON.stringify(ok.error)).toBe("ok");
    expect(await cell(svc, root, docId, 5)).toBe("代理");
  });

  test("读集外目标在两次读取之间被他人插删移动 → 冲突（坐标依据不明确）", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A1:A20" }, ctx);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.insert", sheet: "销售", at: 25, count: 1 }],
    });
    await read.execute({ docId, mode: "range", range: "销售!Z1" }, ctx);
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!C30", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.error?.code).toBe("VERSION_CONFLICT");
    // 读集外、坐标未被移动的目标照常写入
    const ok = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!C22", values: [["代理"]] }] },
      ctx,
    )) as ToolResult;
    expect(ok.status, JSON.stringify(ok.error)).toBe("ok");
  });
});

describe("读集边缘被部分删除（审查 DC-6）", () => {
  test("读 A5:A10 → 用户删 9-12 行 → 代理写 B1：冲突；重读收缩后的区域可写", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A5:A10" }, ctx);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.delete", sheet: "销售", at: 9, count: 4 }],
    });
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!B1", values: [["汇总"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.error?.code).toBe("VERSION_CONFLICT");
    await read.execute({ docId, mode: "range", range: "销售!A5:A8" }, ctx);
    const ok = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!B1", values: [["汇总"]] }] },
      ctx,
    )) as ToolResult;
    expect(ok.status, JSON.stringify(ok.error)).toBe("ok");
  });

  test("读 A1:D1 → 用户删 C-F 列 → 代理写 A20：冲突", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A1:D1" }, ctx);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "cols.delete", sheet: "销售", at: 3, count: 4 }],
    });
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A20", values: [["汇总"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.error?.code).toBe("VERSION_CONFLICT");
  });

  test("删除只在读集下方（不重叠）→ 不冲突", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const edit = tool(svc, "workbook_edit");
    const ctx = ctxOf(db, root, "main");
    await read.execute({ docId, mode: "range", range: "销售!A5:A10" }, ctx);
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.delete", sheet: "销售", at: 11, count: 2 }],
    });
    const r = (await edit.execute(
      { docId, ops: [{ op: "cells.set", range: "销售!B1", values: [["汇总"]] }] },
      ctx,
    )) as ToolResult;
    expect(r.status, JSON.stringify(r.error)).toBe("ok");
  });
});

describe("读集容量（审查 DC-3）", () => {
  test("同修订被包含的条目被替换；超限时旧条目折叠为整表粗粒度条目而非丢弃", () => {
    const t = createReadTable();
    t.record("d", [{ sheetId: "s", r0: 0, c0: 0, r1: 0, c1: 0 }], 0);
    t.record("d", [{ sheetId: "s", r0: 0, c0: 0, r1: 9, c1: 9 }], 0);
    expect(t.get("d")?.ranges).toHaveLength(1);
    for (let i = 0; i < 1005; i++)
      t.record("d", [{ sheetId: "s", r0: 100 + i, c0: 0, r1: 100 + i, c1: 0 }], 1);
    const got = t.get("d");
    const coarse = got?.ranges.filter((r) => r.coarse) ?? [];
    expect(coarse).toHaveLength(1);
    expect(coarse[0]).toMatchObject({ sheetId: "s", r0: 0, rev: 0 });
    expect(got?.minRev).toBe(0);
    expect(got?.ranges.filter((r) => !r.coarse)).toHaveLength(1000);
  });
});

describe("区域被压缩时 cells.set 不错位（P0-08）", () => {
  test("目标内部删行 → 拒绝；目标整体在删除区之下 → 平移写入", async () => {
    const { root, svc, docId } = await setup();
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "rows.delete", sheet: "销售", at: 4, count: 2 }],
    });
    const inside = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [
        {
          op: "cells.set",
          range: "销售!H2",
          values: [["r2"], ["r3"], ["r4"], ["r5"], ["r6"], ["r7"], ["r8"]],
        },
      ],
    });
    expect(inside).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const below = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "cells.set", range: "销售!H10:H11", values: [["r10"], ["r11"]] }],
    });
    expect(below.ok).toBe(true);
    expect(await cell(svc, root, docId, 8, 7)).toBe("r10");
    expect(await cell(svc, root, docId, 9, 7)).toBe("r11");
  });
});

describe("编译与变换边界", () => {
  test("cells.set 区域大于 values 只写 values 覆盖部分（P1-34）", async () => {
    const { root, svc, docId } = await setup();
    const before = await cell(svc, root, docId, 3, 1);
    expect(before).not.toBeUndefined();
    const r = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "cells.set", range: "销售!B1:B12", values: [["表头"]] }],
    });
    expect(r.ok).toBe(true);
    expect(await cell(svc, root, docId, 1, 1)).toBe("表头");
    expect(await cell(svc, root, docId, 3, 1)).toBe(before);
  });

  test("rows/cols.insert 在第 1 行/列与超出现有行数时可用（P1-23）", async () => {
    const { root, svc, docId } = await setup();
    const { snapshot } = await svc.snapshot(docId, root);
    const rows = snapshot.sheets[snapshot.sheetOrder[0] ?? ""]?.rowCount ?? 0;
    const a1 = await cell(svc, root, docId, 1);
    for (const op of [
      { op: "rows.insert", sheet: "销售", at: 1, count: 1 },
      { op: "cols.insert", sheet: "销售", at: 1, count: 1 },
      { op: "rows.insert", sheet: "销售", at: rows + 6, count: 2 },
    ] as const) {
      const r = await svc.submit(docId, root, {
        baseRev: svc.headRev(docId),
        source: agentZ,
        ops: [op],
      });
      expect(r, JSON.stringify(op)).toMatchObject({ ok: true });
    }
    expect(await cell(svc, root, docId, 2, 1)).toBe(a1);
    const after = await svc.snapshot(docId, root);
    // 首次插 1 行 → rows+1；at=rows+6 先扩到 rows+5 行再插 2 行
    expect(after.snapshot.sheets[after.snapshot.sheetOrder[0] ?? ""]?.rowCount).toBe(rows + 7);
  });

  test("baseRev 落后的整行/整列编辑正常平移或报冲突，不抛内部异常（P1-37）", async () => {
    const { root, svc, docId } = await setup();
    await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [
        { op: "cols.insert", sheet: "销售", at: 1, count: 1 },
        { op: "rows.insert", sheet: "销售", at: 1, count: 1 },
      ],
    });
    // 同源结构修订只平移
    const row = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "style.set", range: "销售!40:40", bold: true }],
    });
    expect(row.ok).toBe(true);
    if (row.ok) expect(row.writeSet.ranges[0]).toMatchObject({ r0: 40, r1: 40, c0: 0 });
    const col = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentZ,
      ops: [{ op: "cells.clear", range: "销售!K:K", what: "contents" }],
    });
    expect(col.ok).toBe(true);
    if (col.ok) expect(col.writeSet.ranges[0]).toMatchObject({ c0: 11, c1: 11, r0: 0 });
    // 其他来源的插入条带与整行相交 → 正常 VERSION_CONFLICT
    const other = await svc.submit(docId, root, {
      baseRev: 0,
      source: agentY,
      ops: [{ op: "style.set", range: "销售!40:40", bold: true }],
    });
    expect(other).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  }, 20_000);
});

describe("重启后读集从 agent_context 重建（P1-07）", () => {
  test("重启前读过的格被用户改了 → 重启后写入报冲突而不是覆盖", async () => {
    const { db, root, svc, docId } = await setup();
    const read = tool(svc, "workbook_read");
    const before = (await read.execute(
      { docId, mode: "range", range: "销售!A2" },
      ctxOf(db, root, "main"),
    )) as ToolResult;
    db.prepare(
      "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES ('main', 'ses1', 0, ?, 1)",
    ).run(
      JSON.stringify({
        kind: "toolResult",
        toolCallId: "tc0",
        toolName: "workbook_read",
        output: before,
      }),
    );
    await svc.submit(docId, root, {
      baseRev: 0,
      source: user,
      ops: [{ op: "cells.set", range: "销售!A2", values: [["用户"]] }],
    });
    // 模拟重启：新 actor 的读集由 agent_context 惰性重建
    const reads = createReadTable(() => persistedReads(db, "ses1", "main"));
    const r = (await tool(svc, "workbook_edit").execute(
      { docId, ops: [{ op: "cells.set", range: "销售!A2", values: [["代理"]] }] },
      ctxOf(db, root, "main", reads),
    )) as ToolResult;
    expect(r.error?.code).toBe("VERSION_CONFLICT");
    expect(await cell(svc, root, docId, 2)).toBe("用户");
  });
});

describe("docId 不能绑到其他工作区（P1-32）", () => {
  test("重启后以其他工作区根访问 → OUT_OF_WORKSPACE，原工作区仍可用", async () => {
    const { base, root, dbPath, docId } = await setup();
    const rootB = workspace(base, "ws2");
    const db2 = openDb(dbPath, MIGRATIONS);
    db2
      .prepare(
        "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('ws2', 'ws2', ?, 0, 1, '2026-01-01T00:00:00.000Z')",
      )
      .run(rootB);
    const fresh = new DocumentService(db2);
    await expect(fresh.entry(docId, rootB)).rejects.toMatchObject({ code: "OUT_OF_WORKSPACE" });
    const ok = await fresh.entry(docId, root);
    expect(ok.meta.workspaceId).toBe("ws1");
  });
});

test("确定种子并发模糊：用户与两代理不重叠写不丢失，重叠写只接受一次", async () => {
  const { root, svc, docId, db } = await setup();
  let seed = 20261010;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const expected = new Map<number, string>();
  try {
    for (let round = 0; round < 30; round++) {
      const row = 20 + (random() % 60);
      const baseRev = (await svc.snapshot(docId, root)).meta.rev;
      const writes = await Promise.all(
        [user, agentY, agentZ].map((source, index) =>
          svc.submit(docId, root, {
            baseRev,
            source,
            ops: [
              {
                op: "cells.set",
                range: `销售!${String.fromCharCode(65 + index)}${row}`,
                values: [[`${round}/${index}`]],
              },
            ],
          }),
        ),
      );
      expect(writes.every((result) => result.ok)).toBe(true);
      for (let index = 0; index < 3; index++)
        expect(await cell(svc, root, docId, row, index)).toBe(`${round}/${index}`);
      const currentRev = (await svc.snapshot(docId, root)).meta.rev;
      const overlapping = await Promise.all(
        [user, agentY].map((source, index) =>
          svc.submit(docId, root, {
            baseRev: currentRev,
            source,
            ops: [
              { op: "cells.set", range: `销售!D${row}`, values: [[`winner-${round}-${index}`]] },
            ],
          }),
        ),
      );
      expect(overlapping.filter((result) => result.ok)).toHaveLength(1);
      expect(overlapping.find((result) => !result.ok)).toMatchObject({ code: "VERSION_CONFLICT" });
      expected.set(row, `winner-${round}-${overlapping.findIndex((result) => result.ok)}`);
    }
    for (const [row, value] of expected) expect(await cell(svc, root, docId, row, 3)).toBe(value);
    await svc.checkpoint(docId, root);
  } finally {
    await svc.close();
    db.close();
  }
  // 150 次提交与逐格快照读取；较慢的机器上接近 60 秒，放宽上限避免偶发超时。
}, 180000);

describe("用户在冲突条里选择保留自己的值（overwrite）", () => {
  async function userSet(
    svc: DocumentService,
    docId: string,
    root: string,
    row: number,
    v: string,
  ) {
    const unitId = (await svc.snapshot(docId, root)).snapshot.id;
    return {
      id: "sheet.mutation.set-range-values",
      params: {
        unitId,
        subUnitId: "s0",
        trigger: "sheet.command.set-range-values",
        cellValue: { [row]: { 0: { v } } },
      },
    };
  }

  test("先被拒绝并指出对方；带 overwrite 重提交后产生新修订并覆盖对方", async () => {
    const { db, root, svc, docId } = await setup();
    try {
      await svc.submit(docId, root, {
        baseRev: 0,
        source: agentY,
        ops: [{ op: "cells.set", range: "销售!A2", values: [["代理"]] }],
      });
      const mine = await userSet(svc, docId, root, 1, "用户");
      const rejected = await svc.submit(docId, root, {
        baseRev: 0,
        source: user,
        mutations: [mine],
      });
      expect(rejected).toMatchObject({
        ok: false,
        code: "VERSION_CONFLICT",
        conflicts: [{ source: "agent:ses1/Y", cells: ["'销售'!A2"] }],
      });
      expect(await cell(svc, root, docId, 2)).toBe("代理");
      const again = await svc.submit(docId, root, {
        baseRev: 0,
        source: user,
        mutations: [mine],
        overwrite: true,
      });
      expect(again).toMatchObject({ ok: true, rev: 2 });
      expect(await cell(svc, root, docId, 2)).toBe("用户");
    } finally {
      await svc.close();
      db.close();
    }
  });

  test("overwrite 仍按 baseRev 之后的插行平移坐标，不会写到错位的格子", async () => {
    const { db, root, svc, docId } = await setup();
    try {
      // 用户基于修订 0 的 A11；代理先在第 2 行前插一行（A11 → A12），再改写移位后的 A12
      await svc.submit(docId, root, {
        baseRev: 0,
        source: agentY,
        ops: [{ op: "rows.insert", sheet: "销售", at: 2, count: 1 }],
      });
      await svc.submit(docId, root, {
        baseRev: 1,
        source: agentZ,
        ops: [{ op: "cells.set", range: "销售!A12", values: [["代理Z"]] }],
      });
      const before11 = await cell(svc, root, docId, 11);
      const mine = await userSet(svc, docId, root, 10, "用户");
      expect(
        await svc.submit(docId, root, { baseRev: 0, source: user, mutations: [mine] }),
      ).toMatchObject({
        ok: false,
        code: "VERSION_CONFLICT",
        conflicts: [{ cells: ["'销售'!A12"] }],
      });
      expect(
        await svc.submit(docId, root, {
          baseRev: 0,
          source: user,
          mutations: [mine],
          overwrite: true,
        }),
      ).toMatchObject({ ok: true });
      expect(await cell(svc, root, docId, 12)).toBe("用户");
      expect(await cell(svc, root, docId, 11)).toBe(before11);
    } finally {
      await svc.close();
      db.close();
    }
  });

  test("overwrite 只对用户来源生效，代理写入仍按冲突处理", async () => {
    const { db, root, svc, docId } = await setup();
    try {
      await svc.submit(docId, root, {
        baseRev: 0,
        source: user,
        ops: [{ op: "cells.set", range: "销售!A2", values: [["用户"]] }],
      });
      expect(
        await svc.submit(docId, root, {
          baseRev: 0,
          source: agentY,
          overwrite: true,
          ops: [{ op: "cells.set", range: "销售!A2", values: [["代理"]] }],
        }),
      ).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
      expect(await cell(svc, root, docId, 2)).toBe("用户");
    } finally {
      await svc.close();
      db.close();
    }
  });
});
