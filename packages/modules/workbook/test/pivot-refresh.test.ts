import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { OBJECT_LAYER_MUTATION } from "@excelmanus/protocol";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import { objectsOf } from "../src/objects.ts";
import { ChangeOp } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

const source = Buffer.from(
  readFileSync(new URL("./fixtures/pivot-slicer.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cachePart = "xl/pivotCache/pivotCacheDefinition1.xml";
const sheetPart = "xl/worksheets/sheet1.xml";
const migrations = [
  ...KERNEL_MIGRATIONS,
  DOCUMENTS_MIGRATION,
  DOC_OPS_MIGRATION,
  BACKUPS_MIGRATION,
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
];
function setup(bytes: Uint8Array = source) {
  const dir = mkdtempSync(join(tmpdir(), "pivot-refresh-"));
  const db = openDb(join(dir, "test.sqlite"), migrations);
  const svc = new DocumentService(db);
  writeFileSync(join(dir, "original.xlsx"), bytes);
  copyFileSync(join(dir, "original.xlsx"), join(dir, "pivot.xlsx"));
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('w','w',?,1,0,'2026-10-20T00:00:00.000Z')",
  ).run(dir);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    agentId: "main",
    sessionId: "s",
    toolCallId: "pivot-test",
    role: "main",
    signal: AbortSignal.timeout(60000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
    }),
  };
  return {
    dir,
    db,
    svc,
    ctx,
    close: async () => {
      await svc.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const editOps = [
  { op: "cells.set", range: "Sheet1!E3", values: [[8]] },
  { op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: "0" },
];
const flags = (sheet: Parameters<typeof objectsOf>[0]) =>
  (objectsOf(sheet) as unknown as { pivotRefreshOnLoad?: Record<string, string | null> })
    .pivotRefreshOnLoad;

test("existing pivot/slicer public read and atomic edit preserve every unrelated ZIP part", async () => {
  const t = setup();
  try {
    const read = workbookTools(t.svc).find((tool) => tool.name === "workbook_read")!;
    const initial = await read.execute({ path: "pivot.xlsx", mode: "objects" }, t.ctx);
    expect(initial.status, JSON.stringify(initial.error)).toBe("ok");
    expect(initial.data).toMatchObject({
      preserved: {
        pivotTableCount: 1,
        cacheCount: 1,
        pivotTables: [{ range: "G14:L20" }],
        pivotCaches: [
          {
            cacheId: "0",
            source: { type: "worksheet", sheet: "Sheet1", ref: "A1:E10" },
            refreshOnLoad: { raw: null, effective: false, defaulted: true },
            enableRefresh: { raw: null, effective: true, defaulted: true },
          },
        ],
        slicerCaches: [{ name: "Slicer_USA", cacheId: "0", pivotCacheId: "1", linked: true }],
        slicers: [{ name: "USA", cacheName: "Slicer_USA", linked: true }],
      },
      checkpointPivots: { source: "last_checkpoint", isCurrent: true },
      pendingPivotRefresh: { source: "current_revision", caches: [] },
    });
    const opened = await t.svc.open("w", t.dir, "pivot.xlsx");
    expect(t.ctx.reads.get(opened.meta.id)?.ranges.length).toBeGreaterThan(0);
    expect(hash(readFileSync(join(t.dir, "pivot.xlsx")))).toBe(
      "bba0d4e7c023a930cb739fb445948fdd1bd925a97612c61e5b1a709e80d840be",
    );
    const evidence = process.env.QA_PIVOT_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
    }
    const edited = await workbookEditTool(t.svc).execute(
      { path: "pivot.xlsx", ops: editOps },
      t.ctx,
    );
    expect(edited.status, JSON.stringify(edited.error)).toBe("ok");
    const current = await read.execute({ path: "pivot.xlsx", mode: "objects" }, t.ctx);
    expect(current.data).toMatchObject({
      checkpointPivots: { source: "last_checkpoint", isCurrent: false },
      pendingPivotRefresh: {
        source: "current_revision",
        caches: [
          { cacheId: "0", refreshOnLoad: { raw: "true", effective: true, defaulted: false } },
        ],
      },
    });
    await t.svc.checkpoint(opened.meta.id, t.dir);
    const output = readFileSync(join(t.dir, "pivot.xlsx"));
    if (evidence) {
      copyFileSync(join(t.dir, "original.xlsx"), join(evidence, "product-3b-source.xlsx"));
      copyFileSync(join(t.dir, "pivot.xlsx"), join(evidence, "product-3b-output.xlsx"));
      writeFileSync(
        join(evidence, "product-3b-read.json"),
        JSON.stringify({ initial: initial.data, current: current.data }, null, 2),
      );
    }
    expect(readFileSync(join(t.dir, "original.xlsx"))).toEqual(source);
    const before = unzipSync(source),
      after = unzipSync(output);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(
      Object.keys(before)
        .filter((part) => hash(before[part]!) !== hash(after[part]!))
        .sort(),
    ).toEqual([cachePart, sheetPart].sort());
    expect(strFromU8(after[cachePart]!).replace(' refreshOnLoad="true"', "")).toBe(
      strFromU8(before[cachePart]!),
    );
    expect(strFromU8(after[sheetPart]!)).toBe(
      strFromU8(before[sheetPart]!).replace(
        /(<c\b[^>]*\br="E3"[^>]*>[\s\S]*?<v>)3(<\/v>)/,
        "$18$2",
      ),
    );
    const saved = importXlsx(output, "saved.xlsx").snapshot;
    const sid = saved.sheetOrder[0]!;
    expect(saved.sheets[sid]!.cellData![2]![4]!.v).toBe(8);
    expect(saved.sheets[sid]!.cellData![19]![11]!.v).toBe(13);
    expect(
      Array.from({ length: 9 }, (_, i) =>
        Number(saved.sheets[sid]!.cellData![i + 1]![4]!.v),
      ).reduce((a, b) => a + b, 0),
    ).toBe(18);
    expect(flags(saved.sheets[sid])).toEqual({ "0": "true" });
  } finally {
    await t.close();
  }
}, 60000);

test("invalid pivot targets reject whole batch before a preceding cell edit and raw mutation cannot clear flags", async () => {
  const variants = [
    { name: "unknown", cacheId: "99" },
    {
      name: "missing slicer owner",
      part: sheetPart,
      patch: (xml: string) => xml.replace(/<x14:slicerList>[\s\S]*?<\/x14:slicerList>/, ""),
    },
    {
      name: "external",
      patch: (xml: string) => xml.replace('type="worksheet"', 'type="external"'),
    },
    { name: "named", patch: (xml: string) => xml.replace('ref="A1:E10"', 'name="SourceData"') },
    {
      name: "ambiguous",
      workbook: true,
      patch: (xml: string) =>
        xml.replace(
          '<pivotCache cacheId="0" r:id="rId2"/>',
          '<pivotCache cacheId="0" r:id="rId2"/><pivotCache cacheId="0" r:id="rId2"/>',
        ),
    },
  ];
  for (const variant of variants) {
    const parts = unzipSync(source);
    const target = variant.part ?? (variant.workbook ? "xl/workbook.xml" : cachePart);
    if (variant.patch) parts[target] = strToU8(variant.patch(strFromU8(parts[target]!)));
    const input = zipSync(parts),
      t = setup(input);
    try {
      const entry = await t.svc.open("w", t.dir, "pivot.xlsx");
      const before = await t.svc.snapshot(entry.meta.id, t.dir);
      const result = await t.svc.submit(entry.meta.id, t.dir, {
        baseRev: before.meta.rev,
        source: { kind: "user", id: "qa" },
        ops: [
          editOps[0]!,
          { op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: variant.cacheId ?? "0" },
        ] as ChangeOp[],
      });
      expect(result, variant.name).toMatchObject({ ok: false });
      expect((await t.svc.snapshot(entry.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
      expect(t.svc.headRev(entry.meta.id)).toBe(before.meta.rev);
      expect(
        t.db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(entry.meta.id),
      ).toEqual({ n: 0 });
      expect(hash(readFileSync(join(t.dir, "pivot.xlsx")))).toBe(hash(input));
    } finally {
      await t.close();
    }
  }
  const t = setup();
  try {
    const entry = await t.svc.open("w", t.dir, "pivot.xlsx"),
      sid = entry.imported.snapshot.sheetOrder[0]!;
    // Force the production large-workbook precheck branch without constructing unrelated cells.
    entry.imported.cellCounts = { Sheet1: 100001 };
    const before = await t.svc.snapshot(entry.meta.id, t.dir);
    const injected = {
      ...objectsOf(before.snapshot.sheets[sid]),
      pivotRefreshOnLoad: { ...flags(before.snapshot.sheets[sid]), "99": "true" },
    };
    const rejected = await t.svc.submit(entry.meta.id, t.dir, {
      baseRev: before.meta.rev,
      source: { kind: "user", id: "qa" },
      mutations: [
        {
          id: OBJECT_LAYER_MUTATION,
          params: { unitId: before.snapshot.id, subUnitId: sid, objects: injected },
        },
      ],
    });
    expect(rejected).toMatchObject({ ok: false });
    expect(t.svc.headRev(entry.meta.id)).toBe(before.meta.rev);
    expect((await t.svc.snapshot(entry.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
    expect(hash(readFileSync(join(t.dir, "pivot.xlsx")))).toBe(hash(source));
    const marked = await t.svc.submit(entry.meta.id, t.dir, {
      baseRev: before.meta.rev,
      source: { kind: "user", id: "qa" },
      ops: [{ op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: "0" }] as ChangeOp[],
    });
    expect(marked).toMatchObject({ ok: true });
    const current = await t.svc.snapshot(entry.meta.id, t.dir);
    const cleared = await t.svc.submit(entry.meta.id, t.dir, {
      baseRev: current.meta.rev,
      source: { kind: "user", id: "qa" },
      mutations: [
        {
          id: OBJECT_LAYER_MUTATION,
          params: {
            unitId: current.snapshot.id,
            subUnitId: sid,
            objects: {
              ...objectsOf(current.snapshot.sheets[sid]),
              pivotRefreshOnLoad: { "0": null },
            },
          },
        },
      ],
    });
    expect(cleared).toMatchObject({ ok: false });
    expect(t.svc.headRev(entry.meta.id)).toBe(current.meta.rev);
    for (const input of [
      { op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: "0", refreshOnLoad: false },
      { op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: "0", part: cachePart },
    ])
      expect(ChangeOp.safeParse(input).success).toBe(false);
  } finally {
    await t.close();
  }
}, 60000);

test("uncheckpointed pivot flag replays and undo restores absent attribute rather than false", async () => {
  const t = setup();
  let recovered: ReturnType<typeof setup> | undefined;
  try {
    const entry = await t.svc.open("w", t.dir, "pivot.xlsx"),
      sid = entry.imported.snapshot.sheetOrder[0]!;
    const marked = await t.svc.submit(entry.meta.id, t.dir, {
      baseRev: 0,
      source: { kind: "user", id: "qa" },
      ops: editOps as ChangeOp[],
    });
    expect(marked).toMatchObject({ ok: true });
    if (!marked.ok) throw Error("mark failed");
    expect(flags((await t.svc.snapshot(entry.meta.id, t.dir)).snapshot.sheets[sid])).toEqual({
      "0": "true",
    });
    const recoveryDir = mkdtempSync(join(tmpdir(), "pivot-recovery-"));
    const recoveryPath = join(recoveryDir, "recovered.sqlite");
    t.db.exec(`VACUUM INTO '${recoveryPath}'`);
    copyFileSync(join(t.dir, "pivot.xlsx"), join(recoveryDir, "pivot.xlsx"));
    const db = openDb(recoveryPath, migrations);
    db.prepare("UPDATE workspaces SET path=? WHERE id='w'").run(recoveryDir);
    const svc = new DocumentService(db);
    recovered = {
      ...t,
      dir: recoveryDir,
      db,
      svc,
      close: async () => {
        await svc.close();
        db.close();
        rmSync(recoveryDir, { recursive: true, force: true });
      },
    };
    const reopen = await svc.open("w", recoveryDir, "pivot.xlsx");
    expect(flags((await svc.snapshot(reopen.meta.id, recoveryDir)).snapshot.sheets[sid])).toEqual({
      "0": "true",
    });
    await svc.checkpoint(reopen.meta.id, recoveryDir);
    expect(
      strFromU8(unzipSync(readFileSync(join(recoveryDir, "pivot.xlsx")))[cachePart]!),
    ).toContain(' refreshOnLoad="true"');
    const undone = await svc.revert(reopen.meta.id, recoveryDir, marked.rev, {
      kind: "user",
      id: "qa",
    });
    expect(undone, JSON.stringify(undone)).toMatchObject({ ok: true });
    expect(flags((await svc.snapshot(reopen.meta.id, recoveryDir)).snapshot.sheets[sid])).toEqual({
      "0": null,
    });
    await svc.checkpoint(reopen.meta.id, recoveryDir);
    const restored = unzipSync(readFileSync(join(recoveryDir, "pivot.xlsx")));
    expect(restored[cachePart]).toEqual(unzipSync(source)[cachePart]);
    expect(
      importXlsx(readFileSync(join(recoveryDir, "pivot.xlsx")), "undo.xlsx").snapshot.sheets[sid]!
        .cellData![2]![4]!.v,
    ).toBe(3);
  } finally {
    await recovered?.close();
    await t.close();
  }
}, 60000);

test("matching legacy checkpoint hydrates missing pivot flags and carries them through old object replay", async () => {
  for (const pending of [false, true]) {
    const t = setup();
    let restarted: DocumentService | undefined;
    try {
      const opened = await t.svc.open("w", t.dir, "pivot.xlsx");
      await t.svc.close();
      const record = t.db
        .prepare("SELECT checkpoint_snapshot AS snapshot FROM documents WHERE id=?")
        .get(opened.meta.id) as { snapshot: string };
      const old = JSON.parse(record.snapshot);
      for (const sheet of Object.values(old.sheets) as Array<{
        custom?: { excelmanusObjects?: { pivotRefreshOnLoad?: unknown } };
      }>)
        if (sheet.custom?.excelmanusObjects)
          delete sheet.custom.excelmanusObjects.pivotRefreshOnLoad;
      t.db
        .prepare("UPDATE documents SET checkpoint_snapshot=? WHERE id=?")
        .run(JSON.stringify(old), opened.meta.id);
      const sid = old.sheetOrder[0] as string;
      const mutation = JSON.stringify([
        {
          id: OBJECT_LAYER_MUTATION,
          params: {
            unitId: old.id,
            subUnitId: sid,
            objects: old.sheets[sid].custom.excelmanusObjects,
          },
        },
      ]);
      if (pending) {
        t.db
          .prepare(
            "INSERT INTO doc_ops (doc_id,rev,base_rev,source_kind,source_id,write_set,mutations,inverse,created_at) VALUES (?,1,0,'user','legacy',?,?,?,?)",
          )
          .run(
            opened.meta.id,
            JSON.stringify({
              ranges: [{ sheetId: sid, r0: 0, c0: 0, r1: 1048575, c1: 16383 }],
              structural: [],
            }),
            mutation,
            JSON.stringify({ mutations: JSON.parse(mutation) }),
            new Date().toISOString(),
          );
        t.db.prepare("UPDATE documents SET rev=1,head_rev=1 WHERE id=?").run(opened.meta.id);
      }
      restarted = new DocumentService(t.db);
      const recovered = await restarted.open("w", t.dir, "pivot.xlsx");
      let current = await restarted.snapshot(recovered.meta.id, t.dir);
      expect(flags(current.snapshot.sheets[sid])).toEqual({ "0": null });
      expect(current.meta.rev).toBe(pending ? 1 : 0);
      if (!pending) expect(readFileSync(join(t.dir, "pivot.xlsx"))).toEqual(source);
      else
        expect(
          t.db
            .prepare("SELECT mutations FROM doc_ops WHERE doc_id=? AND rev=1")
            .get(opened.meta.id),
        ).toEqual({ mutations: mutation });
      if (pending) {
        const undone = await restarted.revert(recovered.meta.id, t.dir, 1, {
          kind: "user",
          id: "qa",
        });
        expect(undone, JSON.stringify(undone)).toMatchObject({ ok: true });
        current = await restarted.snapshot(recovered.meta.id, t.dir);
        expect(flags(current.snapshot.sheets[sid])).toEqual({ "0": null });
      }
      const result = await restarted.submit(recovered.meta.id, t.dir, {
        baseRev: current.meta.rev,
        source: { kind: "user", id: "qa" },
        ops: [{ op: "pivot.mark_refresh_on_load", sheet: "Sheet1", cacheId: "0" }],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, rev: current.meta.rev + 1 });
    } finally {
      await restarted?.close();
      await t.close();
    }
  }
}, 60000);
