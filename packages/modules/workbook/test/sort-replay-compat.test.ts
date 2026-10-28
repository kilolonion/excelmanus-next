import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { deriveWriteSetAll } from "../src/writeset.ts";
import { importXlsx } from "../src/xlsx.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(merged = false) {
  const root = mkdtempSync(join(tmpdir(), "sort-replay-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const initial = importCsv(
    new TextEncoder().encode("name,count,double\nb,20,\na,10,\nc,30,\n"),
    "Data.csv",
  ).snapshot;
  const sheet = initial.sheets[initial.sheetOrder[0] ?? ""];
  if (!sheet?.cellData?.[1] || !sheet.cellData[2]) throw new Error("Missing test data");
  sheet.cellData[1][2] = { f: "=B2*2", v: 40, t: 2 };
  sheet.cellData[2][2] = { f: "=B3*2", v: 20, t: 2 };
  if (merged) sheet.mergeData = [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }];
  const path = join(root, "book.xlsx");
  writeFileSync(path, minimalXlsx(initial));
  const original = readFileSync(path);
  let svc = new DocumentService(db);
  const { meta } = await svc.open("ws", root, "book.xlsx");
  const { snapshot } = await svc.snapshot(meta.id, root);
  await svc.close();
  const start = merged ? 2 : 1;
  const end = merged ? 3 : 2;
  const mutation = {
    id: "sheet.mutation.reorder-range",
    params: {
      unitId: snapshot.id,
      subUnitId: snapshot.sheetOrder[0],
      range: { startRow: start, endRow: end, startColumn: 0, endColumn: 2 },
      order: { [start]: end, [end]: start },
    },
  };
  svc = new DocumentService(db);
  return {
    root,
    db,
    svc,
    id: meta.id,
    snapshot,
    mutation,
    original,
    path,
    writeSet: deriveWriteSetAll([mutation]),
    cleanup: async () => {
      try {
        await svc.close();
      } catch (error) {
        // Injected pending logs intentionally lack persisted calculation evidence for checkpoint.
        if (!(error instanceof Error) || !error.message.includes("部分文档写回失败")) throw error;
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

for (const [name, version, merged, expected] of [
  ["legacy pending formula", undefined, false, "=B3*2"],
  ["versioned pending formula", 1, false, "=B2*2"],
  ["legacy merge overlap", undefined, true, undefined],
] as const) {
  test(`${name} recovers its uncheckpointed log and checkpoints the original semantics`, async () => {
    const f = await fixture(merged);
    try {
      const mutations = JSON.stringify([
        {
          ...f.mutation,
          params: {
            ...f.mutation.params,
            ...(version === undefined ? {} : { excelmanusSortVersion: version }),
          },
        },
      ]);
      f.db
        .prepare(`INSERT INTO doc_ops (doc_id,rev,base_rev,source_kind,source_id,write_set,mutations,created_at)
        VALUES (?,1,0,'user','legacy',?,?,?)`)
        .run(f.id, JSON.stringify(f.writeSet), mutations, new Date().toISOString());
      f.db.prepare("UPDATE documents SET head_rev=1,rev=1 WHERE id=?").run(f.id);
      const sha = hash(readFileSync(f.path));
      const reopened = await f.svc.snapshot(f.id, f.root);
      const cells = reopened.snapshot.sheets[reopened.snapshot.sheetOrder[0] ?? ""]?.cellData;
      if (merged) expect(cells?.[2]?.[0]?.v).toBe("c");
      else {
        expect(cells?.[1]?.[0]?.v).toBe("a");
        expect(cells?.[1]?.[2]?.f).toBe(expected);
      }
      expect(reopened.meta.rev).toBe(1);
      expect(hash(readFileSync(f.path))).not.toBe(sha);
      const saved = importXlsx(readFileSync(f.path), "book.xlsx").snapshot;
      const savedCells = saved.sheets[saved.sheetOrder[0] ?? ""]?.cellData;
      if (merged) expect(savedCells?.[2]?.[0]?.v).toBe("c");
      else expect(savedCells?.[1]?.[2]?.f).toBe(expected);
      expect(
        f.db.prepare("SELECT mutations FROM doc_ops WHERE doc_id=? AND rev=1").get(f.id),
      ).toEqual({ mutations });
      expect(
        f.db.prepare("SELECT head_rev,checkpoint_rev FROM documents WHERE id=?").get(f.id),
      ).toMatchObject({ head_rev: 1, checkpoint_rev: 1 });
    } finally {
      await f.cleanup();
    }
  });
}

test.each([null, 0, 99])(
  "historical sort version %s fails instead of silently using legacy semantics",
  async (version) => {
    const f = await fixture();
    try {
      f.db
        .prepare(`INSERT INTO doc_ops (doc_id,rev,base_rev,source_kind,source_id,write_set,mutations,created_at)
      VALUES (?,1,0,'user','legacy',?,?,?)`)
        .run(
          f.id,
          JSON.stringify(f.writeSet),
          JSON.stringify([
            { ...f.mutation, params: { ...f.mutation.params, excelmanusSortVersion: version } },
          ]),
          new Date().toISOString(),
        );
      f.db.prepare("UPDATE documents SET head_rev=1,rev=1 WHERE id=?").run(f.id);
      const sha = hash(readFileSync(f.path));
      await expect(f.svc.snapshot(f.id, f.root)).rejects.toThrow("回放失败");
      expect(hash(readFileSync(f.path))).toBe(sha);
    } finally {
      await f.cleanup();
    }
  },
);

for (const version of [undefined, 0]) {
  test(`fresh raw input cannot select legacy sort with version ${version} or a replay parameter`, async () => {
    const f = await fixture(true);
    try {
      const before = await f.svc.snapshot(f.id, f.root);
      const result = await f.svc.submit(f.id, f.root, {
        baseRev: before.meta.rev,
        source: { kind: "user", id: "editor" },
        mutations: [
          {
            ...f.mutation,
            params: {
              ...f.mutation.params,
              excelmanusReplay: true,
              excelmanusSortRejected: true,
              options: { excelmanusSortRejected: true, applyFormulaCalculationResult: true },
              ...(version === undefined ? {} : { excelmanusSortVersion: version }),
            },
          },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        message: expect.stringContaining("未生效"),
      });
      const after = await f.svc.snapshot(f.id, f.root);
      expect(after.meta.rev).toBe(before.meta.rev);
      expect(after.snapshot.sheets).toEqual(before.snapshot.sheets);
    } finally {
      await f.cleanup();
    }
  });
}

test("fresh old-format reorder is stamped with safe version 1 in its persisted log", async () => {
  const f = await fixture();
  try {
    const result = await f.svc.submit(f.id, f.root, {
      baseRev: 0,
      source: { kind: "user", id: "editor" },
      mutations: [
        {
          ...f.mutation,
          params: { ...f.mutation.params, excelmanusSortVersion: 0, excelmanusReplay: true },
        },
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const record = f.svc.opsAfter(f.id, 0)[0];
    expect(record?.mutations.find((m) => m.id === f.mutation.id)?.params).toMatchObject({
      excelmanusSortVersion: 1,
    });
    const after = await f.svc.snapshot(f.id, f.root);
    expect(after.snapshot.sheets[after.snapshot.sheetOrder[0] ?? ""]?.cellData?.[1]?.[2]?.f).toBe(
      "=B2*2",
    );
  } finally {
    await f.cleanup();
  }
});

test("an already checkpointed workbook stays byte-identical on an ordinary read", async () => {
  const f = await fixture(true);
  try {
    const sha = hash(readFileSync(f.path));
    const read = await f.svc.snapshot(f.id, f.root);
    expect(read.meta.rev).toBe(0);
    expect(hash(readFileSync(f.path))).toBe(sha);
    expect(
      f.db.prepare("SELECT head_rev,checkpoint_rev FROM documents WHERE id=?").get(f.id),
    ).toMatchObject({ head_rev: 0, checkpoint_rev: 0 });
  } finally {
    await f.cleanup();
  }
});

test("new native sort, actual Undo/Redo, and logged replay keep versioned formula semantics", async () => {
  const { bootUniver, createBook, MutationCapture, replayMutations } = await import(
    "../src/engine.ts"
  );
  const snapshot = importCsv(
    new TextEncoder().encode("name,count,double\nb,20,\na,10,\n"),
    "Data.csv",
  ).snapshot;
  const sid = snapshot.sheetOrder[0] ?? "";
  const sheet = snapshot.sheets[sid];
  if (!sheet?.cellData?.[1] || !sheet.cellData[2]) throw new Error("Missing test data");
  sheet.cellData[1][2] = { f: "=B2*2", v: 40, t: 2 };
  sheet.cellData[2][2] = { f: "=B3*2", v: 20, t: 2 };
  const boot = bootUniver();
  const replay = bootUniver();
  try {
    const book = createBook(boot, structuredClone(snapshot));
    // Native Undo uses the focused workbook, which a headless test must select explicitly.
    (
      boot.univerAPI as unknown as {
        _univerInstanceService: { focusUnit(id: string): void };
      }
    )._univerInstanceService.focusUnit(book.unitId);
    const capture = new MutationCapture(boot);
    capture.begin();
    expect(
      await boot.executeCommand("sheet.command.sort-range", {
        unitId: book.unitId,
        subUnitId: sid,
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        hasTitle: true,
        orderRules: [{ colIndex: 0, type: "asc" }],
      }),
    ).toBe(true);
    const history = capture.end();
    expect(history.find((m) => m.id === "sheet.mutation.reorder-range")?.params).toMatchObject({
      excelmanusSortVersion: 1,
    });
    expect(await boot.waitCalc(3000, true)).toBe(true);
    expect(book.workbook.save().sheets[sid]?.cellData?.[1]?.[2]).toMatchObject({
      f: "=B2*2",
      v: 20,
    });
    expect(await boot.executeCommand("univer.command.undo")).toBe(true);
    expect(await boot.waitCalc(3000, true)).toBe(true);
    const restored = book.workbook.save().sheets[sid]?.cellData;
    expect(restored?.[1]?.[0]?.v).toBe("b");
    expect(restored?.[1]?.[2]).toMatchObject({ f: "=B2*2", v: 40 });
    expect(await boot.executeCommand("univer.command.redo")).toBe(true);
    expect(await boot.waitCalc(3000, true)).toBe(true);
    const sorted = book.workbook.save().sheets[sid]?.cellData;
    expect(sorted?.[1]?.[0]?.v).toBe("a");
    expect(sorted?.[1]?.[2]).toMatchObject({ f: "=B2*2", v: 20 });
    const replayed = createBook(replay, structuredClone(snapshot));
    expect(await replayMutations(replay, history)).toEqual([]);
    expect(await replay.waitCalc(3000, true)).toBe(true);
    expect(replayed.workbook.save().sheets[sid]?.cellData).toEqual(sorted);
  } finally {
    await replay.dispose();
    await boot.dispose();
  }
});
