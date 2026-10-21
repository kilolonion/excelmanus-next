import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { WorkbookEditJsonSchema } from "../src/edit-input.ts";
import { ChangeOp } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test("原生正则替换支持捕获组，限定范围、跳过公式并保留文本类型；无效模式原子拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-find-replace-"));
  const db = openDb(join(dir, "test.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  try {
    const imported = importCsv(
      new TextEncoder().encode("项目\nORD-001\nORD-007\nord-002\nORD-003\n"),
      "replace.csv",
    );
    writeFileSync(join(dir, "replace.xlsx"), minimalXlsx(imported.snapshot));
    const opened = await service.open("w", dir, "replace.xlsx");
    const id = opened.meta.id;
    const sid = opened.imported.snapshot.sheetOrder[0]!;
    const sheet = opened.imported.snapshot.sheets[sid]!.name!;
    const submit = async (ops: unknown[], dryRun = false) =>
      service.submit(id, dir, {
        baseRev: (await service.snapshot(id, dir)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        dryRun,
        ops: ops.map((op) => ChangeOp.parse(op)),
      });
    expect(
      await submit([
        { op: "cells.set", range: `${sheet}!B2`, values: [['="ORD-001"', "0007", 7, "a.b A.B"]] },
      ]),
    ).toMatchObject({ ok: true });
    const op = {
      op: "find_replace",
      range: `${sheet}!A2:D4`,
      find: "^ORD-([0-9]{3})$",
      replacement: "INV-$1",
      regex: true,
      caseSensitive: true,
    };
    const before = await service.snapshot(id, dir);
    expect(await submit([op], true)).toMatchObject({ ok: true, dryRun: true });
    expect((await service.snapshot(id, dir)).snapshot.sheets).toEqual(before.snapshot.sheets);
    expect(await submit([op])).toMatchObject({ ok: true });
    let cells = (await service.snapshot(id, dir)).snapshot.sheets[sid]!.cellData!;
    expect(cells[1]?.[0]?.v).toBe("INV-001");
    expect(cells[2]?.[0]?.v).toBe("INV-007");
    expect(cells[3]?.[0]?.v).toBe("ord-002");
    expect(cells[4]?.[0]?.v).toBe("ORD-003");
    expect(cells[1]?.[1]?.f).toBe('="ORD-001"');
    expect(cells[1]?.[2]?.v).toBe("0007");
    expect(cells[1]?.[3]?.v).toBe(7);
    expect(
      await submit([
        {
          op: "find_replace",
          range: `${sheet}!C2:D2`,
          find: "^(0+)7$",
          replacement: "$18",
          regex: true,
        },
        { op: "find_replace", range: `${sheet}!E2`, find: "a.b", replacement: "$1$&$$" },
      ]),
    ).toMatchObject({ ok: true });
    cells = (await service.snapshot(id, dir)).snapshot.sheets[sid]!.cellData!;
    expect(cells[1]?.[2]?.v).toBe("0008");
    expect(cells[1]?.[2]?.t).toBe(before.snapshot.sheets[sid]!.cellData![1]?.[2]?.t);
    expect(cells[1]?.[3]?.v).toBe(7);
    expect(cells[1]?.[4]?.v).toBe("$1$&$$ $1$&$$");
    const stable = await service.snapshot(id, dir);
    const invalid = await submit([
      { op: "cells.set", range: `${sheet}!A1`, values: [["不得提交"]] },
      { ...op, find: "[" },
    ]);
    expect(invalid).toMatchObject({ ok: false });
    expect(JSON.stringify(invalid)).toContain("正则");
    const after = await service.snapshot(id, dir);
    expect(after.meta.rev).toBe(stable.meta.rev);
    expect(after.snapshot.sheets).toEqual(stable.snapshot.sheets);
    const schema = JSON.stringify(WorkbookEditJsonSchema);
    expect(schema).toContain('"regex"');
    expect(schema).toContain("$1");
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
