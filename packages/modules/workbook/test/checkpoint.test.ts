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
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, test } from "vitest";
import { exportXlsx } from "../src/checkpoint.ts";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
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
    CHECKPOINT_MIGRATION,
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
    const { dir, name, svc, meta, db } = await setup();
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
        { path: "new.xlsx", to: "parts", format: "xlsx", mode: "split", rowsPerFile: 1 },
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
