import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { objectsOf } from "../src/objects.ts";
import { importXlsx } from "../src/xlsx.ts";
import { assertXmlDocument, bytesOf, textOf } from "../src/xml.ts";

const root = {
  id: "{00000000-0000-4000-8000-000000000001}",
  personId: "{00000000-0000-4000-8000-000000000002}",
  ref: "B2",
  text: "核对 <金额> & 单价",
  author: "测试作者",
  dateTime: "2026-10-14T00:00:00Z",
  done: false,
};
test("threaded comments preserve authors, replies, status and untouched XML on export", () => {
  const snap = importCsv(bytesOf("item,amount\na,17"), "qa.csv").snapshot;
  const sid = snap.sheetOrder[0]!;
  snap.sheets[sid]!.custom = {
    excelmanusObjects: { charts: [], images: [], threadedComments: [root] },
  };
  const initial = importXlsx(minimalXlsx(snap), "qa.xlsx");
  const id = initial.snapshot.sheetOrder[0]!;
  expect(objectsOf(initial.snapshot.sheets[id]).threadedComments).toEqual([root]);
  const parts: Record<string, Uint8Array> = unzipSync(minimalXlsx(snap));
  const part = Object.keys(parts).find((p) => /^xl\/threadedComments\/.*\.xml$/.test(p))!;
  parts[part] = bytesOf(
    textOf(parts[part]!).replace(
      "</threadedComment>",
      '<extLst><ext xmlns:q="urn:qa" uri="qa"><q:keep value="untouched"/></ext></extLst></threadedComment>',
    ),
  );
  const imported = importXlsx(zipSync(parts), "qa.xlsx");
  const changed = structuredClone(imported.snapshot);
  const objects = objectsOf(changed.sheets[id]);
  objects.threadedComments![0]!.done = true;
  objects.threadedComments!.push({
    ...root,
    id: "{00000000-0000-4000-8000-000000000003}",
    parentId: root.id,
    personId: "{00000000-0000-4000-8000-000000000004}",
    author: "复核人",
    text: "已核对，17 正确",
    dateTime: "2026-10-14T01:00:00Z",
    done: false,
  });
  changed.sheets[id]!.custom = { ...changed.sheets[id]!.custom, excelmanusObjects: objects };
  const output = exportXlsx(imported, changed);
  const saved = unzipSync(output);
  expect(textOf(saved[part]!)).toContain('<q:keep value="untouched"/>');
  for (const [path, data] of Object.entries(saved))
    if (path.endsWith(".xml") || path.endsWith(".rels")) assertXmlDocument(textOf(data));
  const reopened = importXlsx(output, "qa.xlsx");
  expect(objectsOf(reopened.snapshot.sheets[id]).threadedComments).toEqual(
    objects.threadedComments,
  );
  expect(reopened.snapshot.sheets[id]!.cellData).toEqual(imported.snapshot.sheets[id]!.cellData);
  const reset = structuredClone(reopened.snapshot);
  const back = objectsOf(reset.sheets[id]);
  back.threadedComments![0]!.done = false;
  reset.sheets[id]!.custom = { ...reset.sheets[id]!.custom, excelmanusObjects: back };
  expect(
    objectsOf(importXlsx(exportXlsx(reopened, reset), "qa.xlsx").snapshot.sheets[id])
      .threadedComments?.[0]?.done,
  ).toBe(false);
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { OBJECT_LAYER_MUTATION } from "@excelmanus/protocol";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

test("thread replies and resolved state use actor revisions, checkpoint and undo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "excelmanus-threads-"));
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
    writeFileSync(
      join(dir, "threads.xlsx"),
      minimalXlsx(importCsv(bytesOf("item,amount\na,17"), "a.csv").snapshot),
    );
    const opened = await service.open("w", dir, "threads.xlsx");
    const id = opened.meta.id,
      sid = opened.imported.snapshot.sheetOrder[0]!;
    const objects = { charts: [], images: [], threadedComments: [root] };
    const send = async () =>
      service.submit(id, dir, {
        baseRev: (await service.snapshot(id, dir)).meta.rev,
        source: { kind: "user", id: "qa" },
        mutations: [
          {
            id: OBJECT_LAYER_MUTATION,
            params: { unitId: opened.imported.snapshot.id, subUnitId: sid, objects },
          },
        ],
      });
    const added = await send();
    expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
    await service.checkpoint(id, dir);
    expect(
      objectsOf(
        importXlsx(readFileSync(join(dir, "threads.xlsx")), "threads.xlsx").snapshot.sheets[sid],
      ).threadedComments,
    ).toEqual([root]);
    const blocked = await service.submit(id, dir, {baseRev:(await service.snapshot(id,dir)).meta.rev,source:{kind:"user",id:"qa"},ops:[{op:"rows.insert",sheet:sid,at:1,count:1}]});
    expect(blocked).toMatchObject({ok:false});
    objects.threadedComments = [{ ...root, done: true }];
    const resolved = await send();
    expect(resolved, JSON.stringify(resolved)).toMatchObject({ ok: true });
    if (!resolved.ok) throw Error("resolve failed");
    const undone = await service.revert(id, dir, resolved.rev, { kind: "user", id: "qa" });
    expect(undone, JSON.stringify(undone)).toMatchObject({ ok: true });
    expect(
      objectsOf((await service.snapshot(id, dir)).snapshot.sheets[sid]).threadedComments?.[0]?.done,
    ).toBe(false);
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
