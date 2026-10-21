import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync } from "fflate";
import { expect, test } from "vitest";
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
import { importXlsx } from "../src/xlsx.ts";

test("工作区图片新增、预览回滚与原始字节保真回读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-image-"));
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
    const png = readFileSync(
      new URL("../../../../fixtures/skill-evals/image-source.png", import.meta.url),
    );
    writeFileSync(join(dir, "source.png"), png);
    writeFileSync(
      join(dir, "image.xlsx"),
      minimalXlsx(importCsv(new TextEncoder().encode("项目,金额\nA,10\n"), "image.csv").snapshot),
    );
    const opened = await service.open("w", dir, "image.xlsx");
    const sid = opened.imported.snapshot.sheetOrder[0]!;
    const sheet = opened.imported.snapshot.sheets[sid]!.name!;
    const apply = async (path: string, dryRun = false) =>
      service.submit(opened.meta.id, dir, {
        baseRev: (await service.snapshot(opened.meta.id, dir)).meta.rev,
        source: { kind: "agent", id: "main" },
        sessionId: "s",
        dryRun,
        ops: [
          {
            op: "image.add",
            sheet,
            path,
            anchor: "D2",
            width: 320,
            height: 240,
            title: "原始图片",
          },
        ],
      });
    expect(await apply("source.png", true)).toMatchObject({ ok: true, dryRun: true });
    expect(
      objectsOf((await service.snapshot(opened.meta.id, dir)).snapshot.sheets[sid]).images,
    ).toHaveLength(0);
    const result = await apply("source.png");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await service.checkpoint(opened.meta.id, dir);
    const bytes = readFileSync(join(dir, "image.xlsx"));
    const imported = importXlsx(bytes, "image.xlsx");
    const image = objectsOf(imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]).images[0]!;
    expect(image).toMatchObject({
      title: "原始图片",
      anchor: "D2",
      width: 320,
      height: 240,
      mediaType: "image/png",
    });
    expect(Buffer.from(unzipSync(bytes)[image.mediaPart!]!)).toEqual(png);
    expect(readFileSync(join(dir, "source.png"))).toEqual(png);
    // Reopen the actual checkpoint: imported images have mediaPart, not inline data.
    writeFileSync(join(dir, "reopened.xlsx"), bytes);
    const reopened = await service.open("w", dir, "reopened.xlsx");
    const plain = await service.snapshot(reopened.meta.id, dir);
    const rich = await service.snapshot(reopened.meta.id, dir, true);
    const rsid = rich.snapshot.sheetOrder[0]!;
    expect(objectsOf(plain.snapshot.sheets[rsid]).images[0]?.data).toBeUndefined();
    expect(Buffer.from(objectsOf(rich.snapshot.sheets[rsid]).images[0]!.data!, "base64")).toEqual(
      png,
    );
    expect(rich.meta.rev).toBe(plain.meta.rev);
    expect(
      objectsOf((await service.snapshot(reopened.meta.id, dir)).snapshot.sheets[rsid]).images[0]
        ?.data,
    ).toBeUndefined();

    const bad = await apply("../outside.png");
    expect(bad.ok).toBe(false);
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
