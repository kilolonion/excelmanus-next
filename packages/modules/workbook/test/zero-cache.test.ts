import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx, pendingChanges } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("changed formula with the same calculated zero survives checkpoint and styling", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-cache-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    const snap = importCsv(new TextEncoder().encode("key\n"), "report.csv").snapshot;
    const sid = snap.sheetOrder[0]!;
    snap.sheets[sid]!.name = "汇总";
    writeFileSync(join(root, "report.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "report.xlsx");
    const source = { kind: "agent" as const, id: "test" };
    expect(
      await svc.submit(meta.id, root, {
        baseRev: 0,
        source,
        ops: [
          { op: "cells.set", range: "汇总!C26:C27", values: [[0], [0]] },
          { op: "cells.set", range: "汇总!B34", values: [["=C27"]] },
        ],
      }),
    ).toMatchObject({ ok: true, calc: "computed" });
    await svc.checkpoint(meta.id, root);
    expect(
      await svc.submit(meta.id, root, {
        baseRev: 1,
        source,
        ops: [{ op: "cells.set", range: "汇总!B34", values: [["=C26"]] }],
      }),
    ).toMatchObject({ ok: true, calc: "computed" });
    expect(
      await svc.submit(meta.id, root, {
        baseRev: 2,
        source,
        ops: [{ op: "style.set", range: "汇总!B34", bold: true }],
      }),
    ).toMatchObject({ ok: true });
    for (let rev = 3; rev <= 5; rev++) {
      await svc.checkpoint(meta.id, root);
      const back = importXlsx(readFileSync(join(root, "report.xlsx")), "report.xlsx").snapshot;
      expect(back.sheets[back.sheetOrder[0]!]!.cellData?.[33]?.[1]).toMatchObject({
        f: "=C26",
        v: 0,
      });
      if (rev < 5)
        expect(
          await svc.submit(meta.id, root, {
            baseRev: rev,
            source,
            ops: [
              { op: "style.set", range: "汇总!B34", bold: true, fill: "#FFF2CC", numFmt: "0.00" },
            ],
          }),
        ).toMatchObject({ ok: true });
    }
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("only matching engine evidence publishes equal-value caches and repairs missing caches", () => {
  const initial = importCsv(new TextEncoder().encode("0\n"), "t.csv").snapshot;
  const imported = importXlsx(minimalXlsx(initial), "t.xlsx");
  const sid = imported.snapshot.sheetOrder[0]!;
  const after = structuredClone(imported.snapshot);
  after.sheets[sid]!.cellData![0]![0] = { f: "=0", v: 0, t: 2 };
  const range = { sheetId: sid, r0: 0, c0: 0, r1: 0, c1: 0 };
  const author = { sourceKind: "agent", writeSet: { ranges: [range], structural: [] } };
  const engine = {
    sourceKind: "engine",
    writeSet: { ranges: [range], structural: [] },
    mutations: [
      {
        id: "sheet.mutation.set-range-values",
        params: { subUnitId: sid, cellValue: { 0: { 0: { f: "=0", v: 0, t: 2 } } } },
      },
    ],
  };
  const value = (bytes: Uint8Array) => {
    const snap = importXlsx(bytes, "t.xlsx").snapshot;
    return snap.sheets[snap.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v;
  };
  // Equal old/new values without an actual calculation remain suspect.
  const missing = exportXlsx(imported, after);
  expect(value(missing)).toBeUndefined();
  expect(
    value(exportXlsx(imported, after, imported.snapshot, pendingChanges([author, engine]))),
  ).toBe(0);
  expect(
    value(exportXlsx(imported, after, imported.snapshot, pendingChanges([engine, author]))),
  ).toBeUndefined();
  const mismatched = structuredClone(after);
  mismatched.sheets[sid]!.cellData![0]![0]!.f = "=1";
  expect(
    value(exportXlsx(imported, mismatched, imported.snapshot, pendingChanges([engine]))),
  ).toBeUndefined();
  // Old checkpoint versions stored the live value in the baseline but omitted XML <v>.
  const broken = importXlsx(missing, "t.xlsx");
  broken.snapshot = structuredClone(after);
  expect(value(exportXlsx(broken, after, after, pendingChanges([engine])))).toBe(0);
});

test("re-enter same formula repairs missing cache after reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-reopen-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  let svc = new DocumentService(db);
  try {
    const snap = importCsv(new TextEncoder().encode("key\n"), "t.csv").snapshot;
    const sid = snap.sheetOrder[0]!;
    snap.sheets[sid]!.name = "汇总";
    snap.sheets[sid]!.cellData = { 25: { 2: { v: 0, t: 2 } }, 33: { 1: { f: "=C26" } } };
    writeFileSync(join(root, "report.xlsx"), minimalXlsx(snap));
    await svc.open("ws", root, "report.xlsx");
    await svc.close();
    svc = new DocumentService(db);
    const { meta } = await svc.open("ws", root, "report.xlsx");
    const read = () => {
      const back = importXlsx(readFileSync(join(root, "report.xlsx")), "report.xlsx").snapshot;
      return back.sheets[back.sheetOrder[0]!]!.cellData?.[33]?.[1];
    };
    expect(read()?.v).toBeUndefined();
    const result = await svc.submit(meta.id, root, {
      baseRev: meta.rev,
      source: { kind: "agent", id: "test" },
      ops: [{ op: "cells.set", range: "汇总!B34", values: [["=C26"]] }],
    });
    expect(result).toMatchObject({ ok: true, calc: "computed" });
    await svc.checkpoint(meta.id, root);
    expect(read()).toMatchObject({ f: "=C26", v: 0 });
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("a later precedent content write invalidates earlier formula calculation evidence", () => {
  const initial = importCsv(new TextEncoder().encode("0,0\n"), "t.csv").snapshot;
  const imported = importXlsx(minimalXlsx(initial), "t.xlsx");
  const sid = imported.snapshot.sheetOrder[0]!;
  const after = structuredClone(imported.snapshot);
  after.sheets[sid]!.cellData![0]![0] = { f: "=B1", v: 0, t: 2 };
  after.sheets[sid]!.cellData![0]![1] = { v: 1, t: 2 };
  const engine = {
    sourceKind: "engine",
    writeSet: { ranges: [{ sheetId: sid, r0: 0, r1: 0, c0: 0, c1: 0 }], structural: [] },
    mutations: [
      {
        id: "sheet.mutation.set-range-values",
        params: {
          subUnitId: sid,
          cellValue: { 0: { 0: { f: "=B1", v: 0, t: 2 } } },
        },
      },
    ],
  };
  const author = {
    sourceKind: "agent",
    writeSet: { ranges: [{ sheetId: sid, r0: 0, r1: 0, c0: 1, c1: 1 }], structural: [] },
    mutations: [
      {
        id: "sheet.mutation.set-range-values",
        params: {
          subUnitId: sid,
          trigger: "sheet.command.set-range-values",
          cellValue: { 0: { 1: { v: 1, t: 2 } } },
        },
      },
    ],
  };
  const changes = pendingChanges([engine, author]);
  expect(changes.calculated).toEqual([]);
  const back = importXlsx(
    exportXlsx(imported, after, imported.snapshot, changes),
    "t.xlsx",
  ).snapshot;
  expect(back.sheets[back.sheetOrder[0]!]!.cellData?.[0]?.[0]).toMatchObject({ f: "=B1" });
  expect(back.sheets[back.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v).toBeUndefined();
});

test.each(["op", "service"])(
  "explicit recalculate (%s) repairs an idle persisted formula cache without rewriting formula",
  async (route) => {
    const root = mkdtempSync(join(tmpdir(), "recalc-persisted-"));
    const db = openDb(join(root, "db.sqlite"), [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      DOC_MOVES_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
      BACKUPS_MIGRATION,
    ]);
    let svc = new DocumentService(db);
    try {
      const snap = importCsv(new TextEncoder().encode("key\n"), "t.csv").snapshot;
      const sid = snap.sheetOrder[0]!;
      snap.sheets[sid]!.name = "汇总";
      snap.sheets[sid]!.cellData = {
        0: { 0: { v: 80, t: 2 }, 1: { f: "=A1" }, 2: { f: "=A1-A1" } },
      };
      const missing = minimalXlsx(snap);
      writeFileSync(join(root, "report.xlsx"), missing);
      const opened = await svc.open("ws", root, "report.xlsx");
      await svc.recalculate(opened.meta.id, root);
      const { snapshot } = await svc.snapshot(opened.meta.id, root);
      await svc.close();
      // Model the old checkpoint discrepancy: XML lacks caches but its persisted
      // snapshot already holds equal computed values. This is not an external edit.
      snapshot.sheets[sid]!.cellData![0]![1] = { f: "=A1", v: 80, t: 2 };
      snapshot.sheets[sid]!.cellData![0]![2] = { f: "=A1-A1", v: 0, t: 2 };
      writeFileSync(join(root, "report.xlsx"), missing);
      db.prepare("UPDATE documents SET checkpoint_hash=?, checkpoint_snapshot=? WHERE id=?").run(
        createHash("sha256").update(missing).digest("hex"),
        JSON.stringify(snapshot),
        opened.meta.id,
      );
      svc = new DocumentService(db);
      const { meta } = await svc.open("ws", root, "report.xlsx");
      // Let opening settle, then test an explicit request on an idle actor.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const read = () => {
        const back = importXlsx(readFileSync(join(root, "report.xlsx")), "report.xlsx").snapshot;
        return back.sheets[sid]!.cellData![0]!;
      };
      expect(read()[1]?.v).toBeUndefined();
      const before = (await svc.snapshot(meta.id, root)).meta.rev;
      const result =
        route === "op"
          ? await svc.submit(meta.id, root, {
              baseRev: before,
              source: { kind: "agent", id: "test" },
              ops: [{ op: "recalculate" }],
            })
          : await svc.recalculate(meta.id, root);
      expect(result).toMatchObject({ calc: "computed" });
      await svc.checkpoint(meta.id, root);
      expect(read()[1]).toMatchObject({ f: "=A1", v: 80 });
      expect(read()[2]).toMatchObject({ f: "=A1-A1", v: 0 });
      const authored = db
        .prepare("SELECT source_kind FROM doc_ops WHERE doc_id=? AND rev>?")
        .all(meta.id, before);
      expect(authored.length).toBeGreaterThan(0);
      expect(authored.every((row) => row.source_kind === "engine")).toBe(true);
    } finally {
      await svc.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
