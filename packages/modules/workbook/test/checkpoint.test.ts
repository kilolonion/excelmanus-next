import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  sha256,
} from "@excelmanus/kernel";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, test } from "vitest";
import { exportXlsx } from "../src/checkpoint.ts";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";
import { elements, textOf } from "../src/xml.ts";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/xlsx/m2b/preservation.xlsm", import.meta.url),
);
const dirs: string[] = [];
const setups: Array<{ svc: DocumentService; db: ReturnType<typeof openDb> }> = [];
async function setup(file = fixture) {
  const dir = mkdtempSync(join(tmpdir(), "m2b-checkpoint-"));
  dirs.push(dir);
  const name = file.endsWith("xlsm") ? "book.xlsm" : "book.xlsx";
  copyFileSync(file, join(dir, name));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION, DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  setups.push({ svc, db });
  const { meta } = await svc.open("ws", dir, name);
  const ctx = {
    workspaceId: "ws",
    workspaceRoot: dir,
    sessionId: "session",
    agentId: "main",
    toolCallId: "call",
    role: "main" as const,
    signal: AbortSignal.timeout(30000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "ws",
      workspaceRoot: dir,
      sessionId: "session",
      agentId: "main",
    }),
  };
  return { dir, name, db, svc, meta, ctx };
}
afterAll(async () => {
  for (const x of setups) {
    await x.svc.close().catch(() => {});
    x.db.close();
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const source = { kind: "agent" as const, id: "session/main" };

describe("M2b checkpoints at real file/SQLite boundaries", () => {
  test("preserves source text whitespace through creation and checkpoint", async () => {
    const { dir, svc, ctx } = await setup();
    const values = [
      [" 001 ", " 华东 ", " 1,200.50 ", " "],
      ["002", "\ttext\n", "", "尾部 "],
    ];
    const result = await workbookEditTool(svc).execute(
      {
        create: true,
        path: "whitespace.xlsx",
        sheetNames: ["原始"],
        ops: [{ op: "cells.set", range: "原始!A1:D2", values }],
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const imported = importXlsx(readFileSync(join(dir, "whitespace.xlsx")), "whitespace.xlsx");
    const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
    for (let r = 0; r < values.length; r++)
      for (let c = 0; c < values[r]!.length; c++)
        expect(sheet.cellData?.[r]?.[c]?.v ?? "").toBe(values[r]![c]);

    // Shared-string rich-text runs must preserve their boundary whitespace too.
    const parts = unzipSync(readFileSync(join(dir, "whitespace.xlsx")));
    const path = imported.preservation!.sheetParts[imported.snapshot.sheetOrder[0]!]!.path;
    parts[path] = strToU8(
      textOf(parts[path]!).replace(/<c r="A1"[^>]*>.*?<\/c>/s, '<c r="A1" t="s"><v>0</v></c>'),
    );
    parts["xl/sharedStrings.xml"] = strToU8(
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t xml:space="preserve"> 00</t></r><r><t xml:space="preserve">1 </t></r></si></sst>',
    );
    const shared = importXlsx(zipSync(parts), "shared.xlsx").snapshot;
    expect(shared.sheets[shared.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v).toBe(" 001 ");
  });

  test("新建缺失工作表时提示实际目标与 sheetNames，失败仍原子回滚", async () => {
    const { dir, svc, ctx } = await setup();
    const tool = workbookEditTool(svc);
    const result = await tool.execute({ create: true, path: "named.xlsx", ops: [
      { op: "cells.set", range: "汇总!A1", values: [[42]] },
    ] }, ctx);
    expect(result.status).toBe("error");
    expect(result.error?.hint).toContain('sheetNames: ["汇总"]');
    expect(result.error?.hint).not.toContain("收款收据");
    expect(existsSync(join(dir, "named.xlsx"))).toBe(false);
    const corrected = await tool.execute({ create: true, path: "named.xlsx", sheetNames: ["汇总"], ops: [
      { op: "cells.set", range: "汇总!A1", values: [[42]] },
      { op: "cols.width", axis: "cols", sheet: "汇总", at: 2, count: 1, mode: "pixels", value: 100 },
    ] }, ctx);
    expect(corrected.status).toBe("ok");
    const book = importXlsx(readFileSync(join(dir, "named.xlsx")), "named.xlsx").snapshot;
    expect(book.sheets[book.sheetOrder[0]!]!.columnData?.[1]?.w).toBe(100);
  });
  test("cleaned numeric sort and multi-column filter preserve source and hidden rows", async () => {
    const { dir, svc, ctx } = await setup();
    const sourceRows = [
      [" 001 ", " 华东 ", " 1,200.50 ", "已完成"],
      ["002 ", "华南 ", "900", "已完成"],
    ];
    const result = await workbookEditTool(svc).execute(
      {
        create: true,
        path: "clean.xlsx",
        sheetNames: ["原始", "清洗"],
        ops: [
          { op: "cells.set", range: "原始!A1:D2", values: sourceRows },
          {
            op: "cells.set",
            range: "清洗!A1:D6",
            values: [
              ["订单号", "地区", "金额", "状态"],
              ["003", "华东", -50.25, "已完成"],
              ["004", "华北", null, "待处理"],
              ["005", "华南", 300, "已完成"],
              ["001", "华东", 1200.5, "已完成"],
              ["002", "华南", 900, "已完成"],
            ],
          },
          { op: "style.set", range: "清洗!C2:C6", numFmt: "0.00" },
          { op: "sort", range: "清洗!A1:D6", header: true, keys: [{ column: 3, order: "desc" }] },
          {
            op: "filter.set",
            range: "清洗!A1:D6",
            columns: [
              { column: 3, condition: { operator: "greaterThanOrEqual", value: 300 } },
              { column: 4, values: ["已完成"] },
            ],
          },
        ],
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const book = importXlsx(readFileSync(join(dir, "clean.xlsx")), "clean.xlsx").snapshot;
    const sourceSheet = Object.values(book.sheets).find((s) => s.name === "原始")!;
    expect(sourceSheet.cellData?.[0]?.[0]?.v).toBe(" 001 ");
    const clean = Object.values(book.sheets).find((s) => s.name === "清洗")!;
    expect([1, 2, 3, 4, 5].map((r) => clean.cellData?.[r]?.[0]?.v)).toEqual([
      "001",
      "002",
      "005",
      "003",
      "004",
    ]);
    expect(clean.cellData?.[5]?.[2]?.v ?? null).toBe(null);
    const filter = JSON.parse(book.resources!.find((r) => r.name === "SHEET_FILTER_PLUGIN")!.data)[
      clean.id!
    ];
    expect(filter.cachedFilteredOut).toEqual([4, 5]);
    expect(filter.filterColumns.find((c: {colId: number}) => c.colId === 2).customFilters.customFilters)
      .toEqual([{operator: "greaterThanOrEqual", val: 300}]);
    const cleared = await workbookEditTool(svc).execute({
      path: "clean.xlsx", ops: [{op: "filter.set", range: "清洗!A1:D6", clear: true}],
    }, ctx);
    expect(cleared.status, JSON.stringify(cleared.error)).toBe("ok");
    const {meta} = await svc.open("ws", dir, "clean.xlsx");
    await svc.checkpoint(meta.id, dir);
    const reopened = importXlsx(readFileSync(join(dir, "clean.xlsx")), "clean.xlsx").snapshot;
    const unfiltered = Object.values(reopened.sheets).find(s => s.name === "清洗")!;
    expect(Object.values(unfiltered.rowData ?? {}).some(r => r.hd === 1)).toBe(false);
    expect(JSON.parse(reopened.resources!.find(r => r.name === "SHEET_FILTER_PLUGIN")!.data)).toEqual({});
  });
  test("explicit sheetNames failure explains the actual names and rolls back", async () => {
    const { dir, svc, ctx } = await setup();
    const result = await workbookEditTool(svc).execute({create: true, path: "redundant.xlsx", sheetNames: ["数据"], ops: [
      {op: "sheet.rename", sheet: "Sheet1", name: "数据"},
    ]}, ctx);
    expect(result.status).toBe("error");
    expect(result.error?.hint).toContain("数据");
    expect(result.error?.hint).toContain("Sheet1");
    expect(existsSync(join(dir, "redundant.xlsx"))).toBe(false);
  });
  test("reopening a cached workbook updates its last-opened timestamp", async () => {
    const { dir, name, db, svc, meta } = await setup();
    const old = "2000-01-01T00:00:00.000Z";
    db.prepare("UPDATE documents SET last_opened_at = ? WHERE id = ?").run(old, meta.id);
    const reopened = await svc.open("ws", dir, name);
    const row = db.prepare("SELECT last_opened_at FROM documents WHERE id = ?").get(meta.id);
    expect(row?.last_opened_at).not.toBe(old);
    expect(reopened.meta.id).toBe(meta.id);
    expect(reopened.meta.rev).toBe(meta.rev);
  });
  test("多表写入缺少表名时原子拒绝，不能把新表内容静默覆盖到首表", async () => {
    const { dir, svc, ctx } = await setup();
    const result = await workbookEditTool(svc).execute(
      {
        create: true,
        path: "ambiguous.xlsx",
        ops: [
          { op: "sheet.rename", sheet: "Sheet1", name: "数据" },
          { op: "cells.set", range: "A1", values: [[42]] },
          { op: "sheet.add", name: "回归结果" },
          { op: "cells.set", range: "A1", values: [["误写到主表"]] },
        ],
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "error", error: { code: "BAD_OPERATION" } });
    expect(result.error?.message).toContain("工作表名称");
    expect(existsSync(join(dir, "ambiguous.xlsx"))).toBe(false);
  });
  test("删除唯一默认表失败时给出可执行的改名方案，并允许纠正后重试", async () => {
    const { dir, svc, ctx } = await setup();
    const tool = workbookEditTool(svc);
    const result = await tool.execute(
      {
        create: true,
        path: "receipt.xlsx",
        ops: [{ op: "sheet.delete", sheet: "Sheet1" }],
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "error", error: { code: "BAD_OPERATION" } });
    expect(result.error?.hint).toContain("sheet.rename");
    expect(result.error?.hint).toContain("range 必须明确表名");
    expect(existsSync(join(dir, "receipt.xlsx"))).toBe(false);
    const corrected = await tool.execute(
      {
        create: true,
        path: "receipt.xlsx",
        ops: [
          { op: "sheet.rename", sheet: "Sheet1", name: "收款收据" },
          { op: "sheet.add", name: "核对" },
          { op: "cells.set", range: "'收款收据'!A1", values: [["主表"]] },
          { op: "cells.set", range: "'核对'!A1", values: [["核对表"]] },
        ],
      },
      { ...ctx, toolCallId: "corrected" },
    );
    expect(corrected.status).toBe("ok");
    const book = importXlsx(readFileSync(join(dir, "receipt.xlsx")), "receipt.xlsx").snapshot;
    expect(book.sheetOrder.map((id) => book.sheets[id]?.cellData?.[0]?.[0]?.v)).toEqual([
      "主表",
      "核对表",
    ]);
  });
  test("空创建共用路径预检；失败不留文件，成功日志可恢复且不能覆盖同路径", async () => {
    const { dir, svc, ctx, db } = await setup();
    const edit = workbookEditTool(svc);
    const args = { create: true, path: "empty.xlsx", ops: [] };
    expect(edit.input.safeParse(args).success).toBe(true);
    expect(edit.input.safeParse({ path: "book.xlsm", ops: [] }).success).toBe(false);
    const invalid = { create: true, path: "invalid.csv", ops: [] };
    expect(await edit.execute({ ...invalid, dryRun: true }, ctx)).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(await edit.execute(invalid, ctx)).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(existsSync(join(dir, "invalid.csv"))).toBe(false);
    const created = await edit.execute(args, ctx);
    expect(created.status).toBe("ok");
    const bytes = readFileSync(join(dir, args.path));
    const imported = importXlsx(bytes, args.path);
    expect(imported.snapshot.sheetOrder).toEqual(["s0"]);
    expect(imported.snapshot.sheets.s0?.name).toBe("Sheet1");
    expect(imported.cellCounts).toEqual({ Sheet1: 0 });
    expect(
      edit.recover?.({
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        toolCallId: ctx.toolCallId,
        args,
      }),
    ).toMatchObject({ status: "ok", data: { alreadyCommitted: true, rev: 1 } });
    expect(await edit.execute({ ...args, dryRun: true }, ctx)).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
    expect(await edit.execute(args, ctx)).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
    expect(readFileSync(join(dir, args.path))).toEqual(bytes);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM documents WHERE path='empty.xlsx'").get(),
    ).toMatchObject({ n: 1 });
    expect(
      await edit.execute(
        { path: args.path, ops: [{ op: "sheet.add", name: "临时" }] },
        { ...ctx, toolCallId: "add-temp" },
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      await edit.execute(
        {
          path: args.path,
          ops: [
            { op: "sheet.delete", sheet: "Sheet1" },
            { op: "sheet.delete", sheet: "临时" },
          ],
        },
        { ...ctx, toolCallId: "delete-all" },
      ),
    ).toMatchObject({ status: "error", error: { message: "不能删除最后一个工作表" } });
    const { snapshot } = await svc.snapshot((created.data as { docId: string }).docId, dir);
    expect(snapshot.sheetOrder).toHaveLength(2);
  });

  test("edit XLSM preserves every untouched part including macro, drawing and unknown worksheet XML; backup once", async () => {
    const { dir, name, svc, meta, db } = await setup();
    const original = readFileSync(join(dir, name));
    const before = unzipSync(original);
    const noOp = exportXlsx(importXlsx(original, name), importXlsx(original, name).snapshot);
    const noOpParts = unzipSync(noOp);
    for (const [p, b] of Object.entries(before))
      expect(Buffer.from(noOpParts[p] ?? [])).toEqual(Buffer.from(b));
    const r = await svc.submit(meta.id, dir, {
      baseRev: 0,
      source,
      sessionId: "session",
      ops: [{ op: "cells.set", range: "销售!D3", values: [[12345]] }],
    });
    expect(r).toMatchObject({ ok: true, rev: 1 });
    expect(r.ok && r.backupPath).toMatch(/^\.excelmanus\/backups\//);
    expect(readFileSync(join(dir, name))).toEqual(original);
    await svc.checkpoint(meta.id, dir);
    const after = unzipSync(readFileSync(join(dir, name)));
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [p, b] of Object.entries(before))
      if (p !== "xl/worksheets/sheet1.xml")
        expect(Buffer.from(after[p] ?? []), p).toEqual(Buffer.from(b));
    expect(textOf(after["xl/worksheets/sheet1.xml"] as Uint8Array)).toContain(
      '<custom xmlns="urn:m2b:test">保留原文</custom>',
    );
    expect(
      importXlsx(readFileSync(join(dir, name)), name).snapshot.sheets.s0?.cellData?.[2]?.[3]?.v,
    ).toBe(12345);
    await svc.submit(meta.id, dir, {
      baseRev: 1,
      source,
      sessionId: "session",
      ops: [{ op: "cells.set", range: "销售!D4", values: [[99]] }],
    });
    expect(db.prepare("SELECT COUNT(*) n FROM backups WHERE kind='backup'").get()).toMatchObject({
      n: 1,
    });
    const backup = db.prepare("SELECT backup_path FROM backups WHERE kind='backup'").get() as {
      backup_path: string;
    };
    expect(readFileSync(join(dir, backup.backup_path))).toEqual(original);
  });

  test("style appends cellXfs and retains original style indices; same batch can add/populate a sheet and survives checkpoint reopen", async () => {
    const { dir, name, svc, meta, db } = await setup(
      fileURLToPath(new URL("../../../../samples/sales.xlsx", import.meta.url)),
    );
    const before = unzipSync(readFileSync(join(dir, name)));
    const oldXfs = elements(
      elements(textOf(before["xl/styles.xml"] as Uint8Array), "cellXfs")[0]?.inner ?? "",
      "xf",
    ).map((e) => e.raw);
    const result = await svc.submit(meta.id, dir, {
      baseRev: 0,
      source,
      sessionId: "session",
      ops: [
        { op: "style.set", range: "销售!A2", bold: true, fill: "#ff0000", numFmt: "0.000" },
        { op: "sheet.add", name: "新汇总" },
        {
          op: "cells.set",
          range: "新汇总!A1:B2",
          values: [
            ["类别", "金额"],
            ["合计", 42],
          ],
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, rev: 1 });
    await svc.checkpoint(meta.id, dir);
    const after = unzipSync(readFileSync(join(dir, name)));
    const xfs = elements(
      elements(textOf(after["xl/styles.xml"] as Uint8Array), "cellXfs")[0]?.inner ?? "",
      "xf",
    ).map((e) => e.raw);
    expect(xfs.slice(0, oldXfs.length)).toEqual(oldXfs);
    expect(xfs.length).toBeGreaterThan(oldXfs.length);
    expect(Buffer.from(after["xl/worksheets/sheet2.xml"] ?? [])).toEqual(
      Buffer.from(before["xl/worksheets/sheet2.xml"] ?? []),
    );
    const written = importXlsx(readFileSync(join(dir, name)), name).snapshot;
    expect(written.sheetOrder.length).toBe(3);
    expect(written.sheets[written.sheetOrder[2] ?? ""]?.cellData?.[1]?.[1]?.v).toBe(42);
    const stable = (await svc.snapshot(meta.id, dir)).snapshot.sheetOrder;
    const svc2 = new DocumentService(db);
    try {
      expect((await svc2.snapshot(meta.id, dir)).snapshot.sheetOrder).toEqual(stable);
      expect(svc2.opsAfter(meta.id, 0).length).toBe(1);
    } finally {
      await svc2.close();
    }
  });

  test("unsafe structures and signed packages fail before revision, backup or file writes; macros do not block cells", async () => {
    const { dir, name, svc, meta, db } = await setup();
    const original = readFileSync(join(dir, name));
    for (const ops of [
      [{ op: "rows.insert" as const, sheet: "销售", at: 3, count: 1 }],
      [{ op: "sheet.delete" as const, sheet: "销售" }],
    ]) {
      const r = await svc.submit(meta.id, dir, { baseRev: 0, source, sessionId: "session", ops });
      expect(r).toMatchObject({ ok: false, code: "UNSUPPORTED_FEATURE" });
    }
    expect(db.prepare("SELECT COUNT(*) n FROM backups").get()).toMatchObject({ n: 0 });
    expect(svc.headRev(meta.id)).toBe(0);
    expect(readFileSync(join(dir, name))).toEqual(original);
    const signed = unzipSync(original);
    signed["_xmlsignatures/sig1.xml"] = Buffer.from("<Signature/>");
    writeFileSync(join(dir, "signed.xlsx"), zipSync(signed));
    const opened = await svc.open("ws", dir, "signed.xlsx");
    expect(
      await svc.submit(opened.meta.id, dir, {
        baseRev: 0,
        source,
        sessionId: "session",
        ops: [{ op: "cells.set", range: "销售!A2", values: [["x"]] }],
      }),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_FEATURE" });
  });

  test("external clean change reloads as external revision; dirty conflict pauses checkpoint and preserves both versions", async () => {
    const { dir, name, svc, meta, db } = await setup();
    const fresh = unzipSync(readFileSync(join(dir, name)));
    fresh["customXml/item1.xml"] = Buffer.from("<custom>external</custom>");
    writeFileSync(join(dir, name), zipSync(fresh));
    expect((await svc.snapshot(meta.id, dir)).meta.rev).toBe(1);
    expect(svc.opsAfter(meta.id, 0)[0]?.sourceKind).toBe("external");
    await svc.submit(meta.id, dir, {
      baseRev: 1,
      source,
      sessionId: "session",
      ops: [{ op: "cells.set", range: "销售!A60", values: [["durable"]] }],
    });
    const external = zipSync({
      ...fresh,
      "customXml/item1.xml": Buffer.from("<custom>external2</custom>"),
    });
    writeFileSync(join(dir, name), external);
    await expect(svc.checkpoint(meta.id, dir)).rejects.toThrow("暂停");
    expect(readFileSync(join(dir, name))).toEqual(Buffer.from(external));
    const snapshot = await svc.snapshot(meta.id, dir);
    expect(snapshot.meta.checkpointError).toContain("冲突");
    expect(snapshot.snapshot.sheets.s0?.cellData?.[59]?.[0]?.v).toBe("durable");
    expect(
      db.prepare("SELECT head_rev,checkpoint_rev FROM documents WHERE id=?").get(meta.id),
    ).toMatchObject({ head_rev: 2, checkpoint_rev: 1 });
    // P0-07：重启后仍能打开（处于待选择状态），保留应用版本：外部版本进备份区、应用版本写回、写入恢复
    await svc.close().catch(() => {});
    const svc2 = new DocumentService(db);
    const reopened = await svc2.open("ws", dir, name);
    expect(reopened.meta.externalConflict).toBe(true);
    const kept = await svc2.resolveExternal(meta.id, dir, "keepApp");
    expect(readFileSync(join(dir, kept.backup.backupPath))).toEqual(Buffer.from(external));
    expect(svc2.opsAfter(meta.id, 2)[0]).toMatchObject({ sourceKind: "external", rev: 3 });
    expect(kept.meta).toMatchObject({ rev: 3, checkpointRev: 3 });
    expect(kept.meta.externalConflict).toBeUndefined();
    const back = importXlsx(readFileSync(join(dir, name)), name).snapshot;
    expect(back.sheets[back.sheetOrder[0] ?? ""]?.cellData?.[59]?.[0]?.v).toBe("durable");
    // 载入外部版本：应用版本进备份区，内容换成外部文件
    await svc2.submit(meta.id, dir, {
      baseRev: 3,
      source,
      sessionId: "session",
      ops: [{ op: "cells.set", range: "销售!A61", values: [["app-only"]] }],
    });
    writeFileSync(join(dir, name), external);
    const loaded = await svc2.resolveExternal(meta.id, dir, "loadExternal");
    expect(existsSync(join(dir, loaded.backup.backupPath))).toBe(true);
    const after = await svc2.snapshot(meta.id, dir);
    expect(after.snapshot.sheets.s0?.cellData?.[60]?.[0]?.v).toBeUndefined();
    expect(
      await svc2.submit(meta.id, dir, {
        baseRev: after.meta.rev,
        source,
        sessionId: "session",
        ops: [{ op: "cells.set", range: "销售!A62", values: [["resumed"]] }],
      }),
    ).toMatchObject({ ok: true });
    await svc2.close().catch(() => {});
  });

  test("new-file create/dryRun, export and SQL saveTo are executable; no backup for same-session creation", async () => {
    const { dir, svc, ctx, db, meta } = await setup();
    const edit = workbookEditTool(svc);
    expect(
      await edit.execute(
        {
          path: "new.xlsx",
          create: true,
          dryRun: true,
          ops: [{ op: "cells.set", range: "A1", values: [["preview"]] }],
        },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    expect(existsSync(join(dir, "new.xlsx"))).toBe(false);
    const created = await edit.execute(
      {
        path: "new.xlsx",
        create: true,
        ops: [
          {
            op: "cells.set",
            range: "A1:B2",
            values: [
              ["名称", "值"],
              ["总计", 42],
            ],
          },
        ],
      },
      ctx,
    );
    expect(created.status).toBe("ok");
    expect(
      importXlsx(readFileSync(join(dir, "new.xlsx")), "new.xlsx").snapshot.sheets.s0
        ?.cellData?.[1]?.[1]?.v,
    ).toBe(42);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM backups WHERE kind='backup' AND original_path='new.xlsx'")
        .get(),
    ).toMatchObject({ n: 0 });
    const tools = workbookTools(svc);
    const analyze = tools.find((t) => t.name === "workbook_analyze");
    const exp = tools.find((t) => t.name === "workbook_export");
    const saved = await analyze?.execute(
      { path: "new.xlsx", mode: "sql", sql: "SELECT * FROM data", saveTo: { sheet: "查询结果" } },
      ctx,
    );
    expect(saved).toMatchObject({ status: "ok" });
    const savedFile = await analyze?.execute(
      {
        path: "new.xlsx",
        mode: "sql",
        sql: "SELECT * FROM data",
        saveTo: { path: "analysis.xlsx", sheet: "数据" },
      },
      ctx,
    );
    expect(savedFile?.status, JSON.stringify(savedFile)).toBe("ok");
    expect(
      await exp?.execute({ docId: meta.id, to: "copy.xlsm", format: "xlsx" }, ctx),
    ).toMatchObject({ status: "error" });
    expect(
      await exp?.execute({ path: "new.xlsx", to: "out.csv", format: "csv" }, ctx),
    ).toMatchObject({ status: "ok" });
    expect(readFileSync(join(dir, "out.csv"), "utf8")).toContain("总计,42");
    expect(
      await exp?.execute(
        { path: "new.xlsx", to: "parts", mode: "split", rowsPerFile: 1 },
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
  });

  test("CSV checkpoints retain GBK/UTF8 BOM, delimiter and quoted text; formatting rejects", async () => {
    const { dir, svc, db } = await setup();
    const csvFixture = fileURLToPath(
      new URL("../../../../samples/catalog-gbk.csv", import.meta.url),
    );
    copyFileSync(csvFixture, join(dir, "gbk.csv"));
    for (const [name, bytes] of [
      ["bom.tsv", Buffer.from('\ufeff列一\t列二\r\n" 原文 "\t42\r\n')],
      ["gbk.csv", readFileSync(join(dir, "gbk.csv"))],
    ] as const) {
      writeFileSync(join(dir, name), bytes);
      const opened = await svc.open("ws", dir, name);
      expect(
        await svc.submit(opened.meta.id, dir, {
          baseRev: 0,
          source,
          sessionId: "session",
          ops: [{ op: "style.set", range: "A2", bold: true }],
        }),
      ).toMatchObject({ ok: false, code: "UNSUPPORTED_FEATURE" });
      expect(
        await svc.submit(opened.meta.id, dir, {
          baseRev: 0,
          source,
          sessionId: "session",
          ops: [{ op: "cells.set", range: "B2", values: [[123]] }],
        }),
      ).toMatchObject({ ok: true });
      await svc.checkpoint(opened.meta.id, dir);
      const result = readFileSync(join(dir, name));
      if (name === "bom.tsv") {
        expect([...result.subarray(0, 3)]).toEqual([239, 187, 191]);
        expect(result.toString("utf8")).toContain(" 原文 \t123\r\n");
      }
      expect(
        db.prepare("SELECT checkpoint_rev FROM documents WHERE id=?").get(opened.meta.id),
      ).toMatchObject({ checkpoint_rev: 1 });
    }
  });

  test("rename/metadata crash window recovers from durable publication intent without replaying checkpointed operations", async () => {
    const { dir, name, svc, meta, db } = await setup();
    const originalHash = sha256(readFileSync(join(dir, name)));
    await svc.submit(meta.id, dir, {
      baseRev: 0,
      source,
      sessionId: "session",
      ops: [{ op: "sheet.add", name: "已落盘" }],
    });
    await svc.checkpoint(meta.id, dir);
    const row = db
      .prepare("SELECT checkpoint_snapshot,checkpoint_hash FROM documents WHERE id=?")
      .get(meta.id) as { checkpoint_snapshot: string; checkpoint_hash: string };
    db.prepare(
      "UPDATE documents SET checkpoint_rev=0,checkpoint_hash=?,checkpoint_snapshot=NULL WHERE id=?",
    ).run(originalHash, meta.id);
    db.prepare("INSERT INTO doc_checkpoints VALUES (?,?,?,?)").run(
      meta.id,
      1,
      row.checkpoint_hash,
      row.checkpoint_snapshot,
    );
    const svc2 = new DocumentService(db);
    try {
      const reopened = await svc2.open("ws", dir, name);
      expect(reopened.meta.rev).toBe(1);
      expect((await svc2.snapshot(meta.id, dir)).snapshot.sheetOrder.length).toBe(3);
      expect(
        db.prepare("SELECT checkpoint_rev FROM documents WHERE id=?").get(meta.id),
      ).toMatchObject({ checkpoint_rev: 1 });
    } finally {
      await svc2.close();
    }
  });

  test("5 LibreOffice-generated samples: edit/checkpoint/reimport and real LibreOffice opening", async () => {
    let available = false;
    try {
      execFileSync("soffice", ["--version"], { timeout: 10000 });
      available = true;
    } catch {}
    const reports: Array<{ name: string; opened: boolean }> = [];
    for (let n = 1; n <= 5; n++) {
      const file = fileURLToPath(
        new URL(`../../../../fixtures/xlsx/m2b/lo-${n}.xlsx`, import.meta.url),
      );
      const { dir, name, svc, meta } = await setup(file);
      const before = unzipSync(readFileSync(join(dir, name)));
      expect(
        await svc.submit(meta.id, dir, {
          baseRev: 0,
          source,
          sessionId: "session",
          ops: [{ op: "cells.set", range: "B2", values: [[5678]] }],
        }),
      ).toMatchObject({ ok: true });
      await svc.checkpoint(meta.id, dir);
      const after = unzipSync(readFileSync(join(dir, name)));
      for (const [p, b] of Object.entries(before))
        if (!p.startsWith("xl/worksheets/sheet1.xml"))
          expect(Buffer.from(after[p] ?? []), p).toEqual(Buffer.from(b));
      expect(
        importXlsx(readFileSync(join(dir, name)), name).snapshot.sheets.s0?.cellData?.[1]?.[1]?.v,
      ).toBe(5678);
      if (available) {
        const out = join(dir, "lo-open");
        execFileSync(
          "soffice",
          [
            `-env:UserInstallation=file://${dir}/lo-profile`,
            "--headless",
            "--convert-to",
            "xlsx",
            "--outdir",
            out,
            join(dir, name),
          ],
          { timeout: 30000 },
        );
        expect(
          importXlsx(readFileSync(join(out, name)), name).snapshot.sheets.s0?.cellData?.[1]?.[1]?.v,
        ).toBe(5678);
      }
      reports.push({ name: `lo-${n}.xlsx`, opened: available });
    }
    process.stdout.write(`M2b LibreOffice verification: ${JSON.stringify(reports)}\n`);
  }, 120000);
});

test("manual worksheet edits also preserve a first-edit backup", async () => {
  const { svc, meta, dir, name, db } = await setup();
  const original = readFileSync(join(dir, name));
  const result = await svc.submit(meta.id, dir, {
    baseRev: 0,
    readSet: [],
    source: { kind: "user", id: "browser-qa" },
    ops: [{ op: "cells.set", range: "销售!D3", values: [[12345]] }],
  });
  expect(result.ok).toBe(true);
  expect(result.ok && result.backupPath).toMatch(/^\.excelmanus\/backups\//);
  const backup = db.prepare("SELECT backup_path FROM backups WHERE kind='backup'").get() as {
    backup_path: string;
  };
  expect(readFileSync(join(dir, backup.backup_path))).toEqual(original);
});
