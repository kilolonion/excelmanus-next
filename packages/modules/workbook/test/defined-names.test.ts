import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { namesOf, setNames } from "../src/defined-names.ts";
import { importXlsx } from "../src/xlsx.ts";

test("定义名按作用域保存、修改和删除，保留未知属性", () => {
  const parts = unzipSync(
    minimalXlsx(importCsv(new TextEncoder().encode("x\n2\n4"), "a.csv").snapshot),
  );
  const text = new TextDecoder().decode(parts["xl/workbook.xml"]);
  parts["xl/workbook.xml"] = new TextEncoder().encode(
    text.replace(
      "</workbook>",
      '<definedNames><definedName name="Keep" hidden="1" description="原始属性">42</definedName></definedNames></workbook>',
    ),
  );
  const initial = importXlsx(zipSync(parts), "a.xlsx");
  const next = structuredClone(initial.snapshot),
    sid = next.sheetOrder[0]!;
  const existing = namesOf(next);
  expect(Object.values(existing)[0]?.name).toBe("Keep");
  setNames(next, {
    ...existing,
    global: { id: "global", name: "数量", formulaOrRefString: "'Sheet1'!$A$2:$A$3" },
    local: { id: "local", name: "数量", localSheetId: sid, formulaOrRefString: "5" },
  });
  const bytes = exportXlsx(initial, next),
    reopened = importXlsx(bytes, "a.xlsx");
  expect(Object.values(namesOf(reopened.snapshot)).map((n) => n.name)).toEqual([
    "Keep",
    "数量",
    "数量",
  ]);
  expect(new TextDecoder().decode(unzipSync(bytes)["xl/workbook.xml"])).toContain(
    'description="原始属性"',
  );
  const again = structuredClone(reopened.snapshot),
    all = namesOf(again),
    local = Object.values(all).find((n) => n.localSheetId === sid)!;
  setNames(again, { ...all, [local.id]: { ...local, formulaOrRefString: "9" } });
  const changed = importXlsx(exportXlsx(reopened, again), "a.xlsx");
  expect(
    Object.values(namesOf(changed.snapshot)).find((n) => n.localSheetId === sid)
      ?.formulaOrRefString,
  ).toBe("9");
  setNames(changed.snapshot, {});
  expect(
    Object.keys(namesOf(importXlsx(exportXlsx(reopened, changed.snapshot), "a.xlsx").snapshot)),
  ).toHaveLength(0);
});

test.each(["user", "agent"] as const)("%s 名称变更走活文档计算、保存与撤销", async (kind) => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb, BACKUPS_MIGRATION } = await import("@excelmanus/kernel");
  const {
    DocumentService,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  } = await import("../src/service.ts");
  const root = mkdtempSync(join(tmpdir(), "names-"));
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
    const snap = importCsv(new TextEncoder().encode("n\n2\n4"), "a.csv").snapshot;
    snap.sheets[snap.sheetOrder[0]!]!.cellData![0]![1] = { f: "=SUM(Amounts)" };
    writeFileSync(join(root, "a.xlsx"), minimalXlsx(snap));
    const { meta } = await svc.open("ws", root, "a.xlsx");
    const before = await svc.snapshot(meta.id, root);
    const r = await svc.submit(meta.id, root, {
      baseRev: before.meta.rev,
      source: { kind, id: "names" },
      sessionId: "name-qa",
      ...(kind === "agent"
        ? { ops: [{ op: "name.set" as const, name: "Amounts", range: "Sheet1!A2:A3" }] }
        : {
            mutations: [
              {
                id: "formula.mutation.set-defined-name",
                params: {
                  unitId: before.snapshot.id,
                  id: "amounts",
                  name: "Amounts",
                  formulaOrRefString: "'Sheet1'!$A$2:$A$3",
                },
              },
            ],
          }),
    });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    if (!r.ok) return;
    const after = await svc.snapshot(meta.id, root);
    expect(Object.values(namesOf(after.snapshot))).toHaveLength(1);
    expect(after.snapshot.sheets[after.snapshot.sheetOrder[0]!]!.cellData?.[0]?.[1]?.v).toBe(6);
    await svc.checkpoint(meta.id, root);
    expect(
      Object.values(namesOf(importXlsx(readFileSync(join(root, "a.xlsx")), "a.xlsx").snapshot)),
    ).toHaveLength(1);
    expect(
      await svc.undoRevision(meta.id, root, r.rev, { kind: "user", id: "undo" }),
    ).toMatchObject({ ok: true });
    expect(Object.values(namesOf((await svc.snapshot(meta.id, root)).snapshot))).toHaveLength(0);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("新文件保留名称资源", () => {
  const s = importCsv(new TextEncoder().encode("n\n2"), "a.csv").snapshot;
  setNames(s, { one: { id: "one", name: "Amount", formulaOrRefString: "2" } });
  expect(Object.values(namesOf(importXlsx(minimalXlsx(s), "a.xlsx").snapshot))[0]?.name).toBe(
    "Amount",
  );
});

test("名称重命名通过引擎命令同步更新公式引用", async () => {
  const { bootUniver, createBook } = await import("../src/engine.ts");
  const boot = bootUniver();
  try {
    const snap = importCsv(new TextEncoder().encode("n\n2\n4"), "a.csv").snapshot;
    setNames(snap, {
      a: {
        id: "a",
        name: "Amounts",
        formulaOrRefString: "'Sheet1'!$A$2:$A$3",
        localSheetId: "AllDefaultWorkbook",
      },
    });
    snap.sheets[snap.sheetOrder[0]!]!.cellData![0]![1] = { f: "=SUM(Amounts)" };
    const book = createBook(boot, snap);
    await boot.waitCalc(2000);
    expect(
      await boot.executeCommand("sheet.command.set-defined-name", {
        unitId: book.unitId,
        id: "a",
        name: "Totals",
        formulaOrRefString: "'Sheet1'!$A$2:$A$3",
        localSheetId: "AllDefaultWorkbook",
      }),
    ).toBe(true);
    await boot.waitCalc(2000);
    const saved = book.workbook.save();
    expect(saved.sheets[saved.sheetOrder[0]!]!.cellData?.[0]?.[1]?.f).toBe("=SUM(Totals)");
    expect(saved.sheets[saved.sheetOrder[0]!]!.cellData?.[0]?.[1]?.v).toBe(6);
  } finally {
    await boot.dispose();
  }
});
