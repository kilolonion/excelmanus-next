import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test, vi } from "vitest";
import { utils, write } from "xlsx";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import * as xlsx from "../src/xlsx.ts";

function bytes(value: number): Uint8Array {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Value"], [value]]), "Data");
  return write(book, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

test("相同源字节复开跳过 XLSX 解析，外部变化仍校验并载入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cached-open-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const spy = vi.spyOn(xlsx, "importXlsx");
  try {
    writeFileSync(join(dir, "test.xlsx"), bytes(1));
    const first = await service.open("w", dir, "test.xlsx");
    spy.mockClear();
    const same = await service.open("w", dir, "test.xlsx");
    expect(same.meta.id).toBe(first.meta.id);
    expect(spy).not.toHaveBeenCalled();
    writeFileSync(join(dir, "test.xlsx"), bytes(2));
    const changed = await service.open("w", dir, "test.xlsx");
    expect(spy).toHaveBeenCalled();
    const sheet = changed.imported.snapshot.sheets[changed.imported.snapshot.sheetOrder[0]!]!;
    expect(sheet.cellData![1]![0]!.v).toBe(2);
    writeFileSync(join(dir, "test.xlsx"), "broken");
    await expect(service.open("w", dir, "test.xlsx")).rejects.toThrow();
    writeFileSync(join(dir, "test.xlsx"), bytes(2));
    const edited = await service.submit(first.meta.id, dir, {
      baseRev: changed.meta.rev,
      source: { kind: "agent", id: "session/main" },
      sessionId: "session",
      ops: [{ op: "cells.set", range: "Data!A2", values: [[9]] }],
    });
    expect(edited.ok).toBe(true);
    const external = bytes(3);
    writeFileSync(join(dir, "test.xlsx"), external);
    const conflict = await service.open("w", dir, "test.xlsx");
    expect(conflict.meta.externalConflict).toBe(true);
    expect(readFileSync(join(dir, "test.xlsx"))).toEqual(Buffer.from(external));
    await expect(service.checkpoint(first.meta.id, dir)).rejects.toThrow();
    expect(readFileSync(join(dir, "test.xlsx"))).toEqual(Buffer.from(external));
    await service.resolveExternal(first.meta.id, dir, "loadExternal");
  } finally {
    spy.mockRestore();
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
