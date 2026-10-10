import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { ChangeOp } from "../src/ops.ts";
import { rulesResource } from "../src/rule-codec.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

test("推荐操作实际闭环：复制移动隐藏工作表、公式填充、自动适配与比例尺寸", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-ops-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
  ]);
  let service = new DocumentService(db);
  try {
    const snapshot = importCsv(
      new TextEncoder().encode("数量,加倍\n1,\n2,\n3,\n4,\n"),
      "Source.csv",
    ).snapshot;
    const source = snapshot.sheets[snapshot.sheetOrder[0]!]!.name!;
    writeFileSync(join(dir, "book.xlsx"), minimalXlsx(snapshot));
    const opened = await service.open("w", dir, "book.xlsx"),
      id = opened.meta.id;
    const apply = async (ops: unknown[], dryRun = false) =>
      service.submit(id, dir, {
        baseRev: (await service.snapshot(id, dir)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        dryRun,
        ops: ops.map((o) => ChangeOp.parse(o)),
      });
    expect(
      await apply([{ op: "cells.set", range: `${source}!B2`, values: [["=A2*2"]] }]),
    ).toMatchObject({ ok: true });
    const copy = await apply([
      { op: "sheet.copy", sheet: source, name: "Copy" },
      { op: "sheet.move", sheet: "Copy", index: 0 },
      { op: "sheet.hide", sheet: source, hidden: true },
    ]);
    expect(copy, JSON.stringify(copy)).toMatchObject({ ok: true });
    expect(await apply([{ op: "sheet.hide", sheet: "Copy", hidden: true }])).toMatchObject({
      ok: false,
    });
    const beforeRaw = await service.snapshot(id, dir);
    expect(
      await service.submit(id, dir, {
        baseRev: beforeRaw.meta.rev,
        source: { kind: "user", id: "ui" },
        mutations: [
          {
            id: "sheet.mutation.set-worksheet-hidden",
            params: {
              unitId: beforeRaw.snapshot.id,
              subUnitId: beforeRaw.snapshot.sheetOrder[0],
              hidden: 1,
            },
          },
        ],
      }),
    ).toMatchObject({ ok: false });
    expect((await service.snapshot(id, dir)).meta.rev).toBe(beforeRaw.meta.rev);
    const fill = await apply([
      { op: "cells.fill", source: "Copy!B2", range: "Copy!B3:B5", mode: "copy" },
    ]);
    expect(fill, JSON.stringify(fill)).toMatchObject({ ok: true });
    const size = await apply([
      { op: "axis.size", sheet: "Copy", axis: "cols", at: 1, count: 2, mode: "auto" },
      { op: "axis.size", sheet: "Copy", axis: "rows", at: 1, count: 1, mode: "pixels", value: 30 },
    ]);
    expect(size, JSON.stringify(size)).toMatchObject({ ok: true });
    const snap = (await service.snapshot(id, dir)).snapshot;
    const copied = snap.sheets[snap.sheetOrder[0]!]!;
    expect(copied.name).toBe("Copy");
    expect(copied.cellData?.[4]?.[1]?.f).toBe("=A5*2");
    expect(copied.rowData?.[0]?.h).toBe(30);
    expect(
      await apply(
        [
          {
            op: "axis.size",
            sheet: "Copy",
            axis: "rows",
            at: 1,
            count: 1,
            mode: "scale",
            value: 2,
          },
        ],
        true,
      ),
    ).toMatchObject({ ok: true, dryRun: true });
    expect((await service.snapshot(id, dir)).snapshot.sheets[copied.id!]?.rowData?.[0]?.h).toBe(30);
    const extras = await apply([
      { op: "filter.set", range: "Copy!A1:B5", columns: [{ column: 1, values: [2, 3] }] },
      {
        op: "hyperlink.set",
        range: "Copy!D2",
        url: "https://example.com/report",
        label: "打开报告",
      },
    ]);
    expect(extras, JSON.stringify(extras)).toMatchObject({ ok: true });
    const filtered = (await service.snapshot(id, dir)).snapshot;
    const filter = rulesResource(filtered, "SHEET_FILTER_PLUGIN")[copied.id!] as unknown as {
      cachedFilteredOut: number[];
    };
    expect(filter.cachedFilteredOut).toEqual([1, 4]);
    expect(
      await apply(
        [{ op: "filter.set", range: "Copy!A1:B5", columns: [{ column: 1, values: [1] }] }],
        true,
      ),
    ).toMatchObject({ ok: true, dryRun: true });
    expect(
      rulesResource((await service.snapshot(id, dir)).snapshot, "SHEET_FILTER_PLUGIN")[copied.id!],
    ).toEqual(rulesResource(filtered, "SHEET_FILTER_PLUGIN")[copied.id!]);
    await service.checkpoint(id, dir);
    writeFileSync(
      join(tmpdir(), "excelmanus-native-ops-proof.xlsx"),
      readFileSync(join(dir, "book.xlsx")),
    );
    const re = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot;
    expect(re.sheets[re.sheetOrder[0]!]!.name).toBe("Copy");
    expect(re.sheets[re.sheetOrder[1]!]!.hidden).toBe(1);
    expect(re.sheets[re.sheetOrder[0]!]!.cellData?.[4]?.[1]?.f).toBe("=A5*2");
    expect(re.sheets[re.sheetOrder[0]!]!.cellData?.[1]?.[3]?.custom?.excelmanusHyperlink).toEqual({
      url: "https://example.com/report",
    });
    expect(
      (
        rulesResource(re, "SHEET_FILTER_PLUGIN")[re.sheetOrder[0]!] as unknown as {
          cachedFilteredOut: number[];
        }
      ).cachedFilteredOut,
    ).toEqual([1, 4]);
    await service.close();
    service = new DocumentService(db);
    await service.open("w", dir, "book.xlsx");
    expect(await apply([{ op: "filter.set", range: "Copy!A1:B5", clear: true }])).toMatchObject({
      ok: true,
    });
    await service.checkpoint(id, dir);
    const cleared = importXlsx(readFileSync(join(dir, "book.xlsx")), "cleared.xlsx").snapshot;
    expect(rulesResource(cleared, "SHEET_FILTER_PLUGIN")).toEqual({});
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
