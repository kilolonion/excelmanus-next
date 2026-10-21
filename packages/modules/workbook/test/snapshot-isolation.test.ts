import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test, vi } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { objectsOf } from "../src/objects.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test("snapshot 复用 Univer 1.0.2 已深拷贝的 save，嵌套数据和并发返回仍完全隔离", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-isolation-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    const input = importCsv(new TextEncoder().encode("Name,Value\nA,10\n"), "Data.csv").snapshot;
    const sid = input.sheetOrder[0]!;
    input.styles = { red: { bg: { rgb: "#FF0000" } } };
    input.sheets[sid]!.cellData![1]![1]!.s = "red";
    writeFileSync(join(dir, "test.xlsx"), minimalXlsx(input));
    writeFileSync(
      join(dir, "source.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const doc = await service.open("w", dir, "test.xlsx");
    let id = doc.meta.id;
    const sheetId = doc.imported.snapshot.sheetOrder[0]!;
    const name = doc.imported.snapshot.sheets[sheetId]!.name!;
    expect(
      await service.submit(id, dir, {
        baseRev: doc.meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [
          {
            op: "image.add",
            sheet: name,
            path: "source.png",
            anchor: "D2",
            width: 100,
            height: 100,
            title: "Original",
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    await service.checkpoint(id, dir);
    writeFileSync(join(dir, "reimported.xlsx"), readFileSync(join(dir, "test.xlsx")));
    id = (await service.open("w", dir, "reimported.xlsx")).meta.id;
    const plainBaseline = (await service.snapshot(id, dir)).snapshot;
    expect(objectsOf(plainBaseline.sheets[sheetId]).images[0]!.data).toBeUndefined();
    const [first, peer] = await Promise.all([
      service.snapshot(id, dir, true),
      service.snapshot(id, dir, true),
    ]);
    const pristine = structuredClone(peer.snapshot);
    const styleId = String(first.snapshot.sheets[sheetId]!.cellData![1]![1]!.s);
    expect(first.snapshot.styles[styleId]).toBeDefined();
    expect(first.snapshot.resources!.length).toBeGreaterThan(0);
    expect(objectsOf(first.snapshot.sheets[sheetId]).images[0]!.data).toBeTruthy();
    first.snapshot.sheets[sheetId]!.cellData![1]![1]!.v = 999;
    first.snapshot.styles[styleId]!.bg = { rgb: "#000000" };
    const custom = first.snapshot.sheets[sheetId]!.custom!.excelmanusObjects as {
      images: Array<{ title: string; data?: string }>;
    };
    custom.images[0]!.title = "Corrupted";
    custom.images[0]!.data = "corrupted";
    first.snapshot.resources![0]!.data = "corrupted";
    first.snapshot.sheetOrder.push("not-a-sheet");
    expect(peer.snapshot).toEqual(pristine);
    expect((await service.snapshot(id, dir, true)).snapshot).toEqual(pristine);
    const plain = await service.snapshot(id, dir);
    expect(plain.snapshot).toEqual(plainBaseline);
    expect(
      await service.submit(id, dir, {
        baseRev: plain.meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        ops: [{ op: "cells.set", range: name + "!B2", values: [[42]] }],
      }),
    ).toMatchObject({ ok: true });
    expect(peer.snapshot).toEqual(pristine);
    expect((await service.snapshot(id, dir)).snapshot.sheets[sheetId]!.cellData![1]![1]!.v).toBe(
      42,
    );
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await service.snapshot(id, dir);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
