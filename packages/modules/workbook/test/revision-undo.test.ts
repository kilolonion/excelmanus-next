import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test("consecutive undo ignores canceled edits but retains live collaborator conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "revision-undo-"));
  const db = openDb(join(root, "db"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    writeFileSync(
      join(root, "book.xlsx"),
      minimalXlsx(importCsv(new TextEncoder().encode("10,keep"), "book.csv").snapshot),
    );
    const { meta } = await svc.open("w", root, "book.xlsx");
    const set = async (value: number, id = "main") => {
      const result = await svc.submit(meta.id, root, {
        baseRev: (await svc.snapshot(meta.id, root)).meta.rev,
        source: { kind: "agent", id },
        sessionId: "s",
        ops: [{ op: "cells.set", range: "A1", values: [[value]] }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      return result.rev;
    };
    const undo = (rev: number) =>
      svc.undoRevision(meta.id, root, rev, { kind: "user", id: "undo" });
    const cell = async () => {
      const { snapshot } = await svc.snapshot(meta.id, root);
      return snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v;
    };
    const first = await set(20);
    const second = await set(30, "collaborator");
    expect(await undo(first)).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await cell()).toBe(30);
    expect(await undo(second)).toMatchObject({ ok: true });
    expect(await cell()).toBe(20);
    expect(await undo(first)).toMatchObject({ ok: true });
    expect(await cell()).toBe(10);
    expect(await undo(first)).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const third = await set(40);
    const fourth = await set(50);
    expect(await undo(fourth)).toMatchObject({ ok: true });
    await set(60, "collaborator");
    expect(await undo(third)).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await cell()).toBe(60);
    // Forced internal rollback can cross live edits: those pairs are not neutral.
    const base = await set(70);
    const crossed = await set(80);
    const intervening = await set(90, "collaborator");
    expect(
      await svc.revert(meta.id, root, crossed, { kind: "user", id: "rollback" }),
    ).toMatchObject({ ok: true });
    expect(
      await svc.revert(meta.id, root, intervening, { kind: "user", id: "rollback" }),
    ).toMatchObject({ ok: true });
    expect(await cell()).toBe(80);
    expect(await undo(base)).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await cell()).toBe(80);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
