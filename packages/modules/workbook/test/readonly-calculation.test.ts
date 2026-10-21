import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  sha256,
  type ToolContext,
} from "@excelmanus/kernel";
import { TableColumnDataTypeEnum } from "@univerjs/sheets-table";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { workbookRenderTool } from "../src/render.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { setTables } from "../src/tables.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

for (const action of [
  "read",
  "table",
  "dryRun",
  "dryRecalc",
  "recalculate",
  "recalcPending",
  "edit",
  "conflict",
] as const) {
  test(`初始只读计算不改源；${action} 的持久化边界`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "readonly-calculation-"));
    const db = openDb(join(dir, "db.sqlite"), [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    let service = new DocumentService(db);
    try {
      const snapshot = importCsv(
        new TextEncoder().encode("Qty,Price,Amount\n2,12.5,\n"),
        "Template.csv",
      ).snapshot;
      snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData![1]![2] = { f: "=A2*B2" };
      if (action === "table") {
        const sid = snapshot.sheetOrder[0]!;
        snapshot.sheets[sid]!.cellData![1]![2] = { f: "=[@Qty]*[@Price]" };
        setTables(snapshot, {
          [sid]: {
            tables: [
              {
                id: "sales",
                name: "Sales",
                range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
                options: {
                  showHeader: true,
                  showFooter: false,
                  showAutoFilter: true,
                  tableStyleId: "table-default-0",
                },
                filters: {},
                meta: {},
                columns: ["Qty", "Price", "Amount"].map((displayName, i) => ({
                  id: String(i + 1),
                  displayName,
                  dataType: TableColumnDataTypeEnum.None,
                  formula: i === 2 ? "=[@Qty]*[@Price]" : "",
                  meta: {},
                  style: {},
                })),
              },
            ],
          },
        });
      }
      const original = minimalXlsx(snapshot);
      writeFileSync(join(dir, "book.xlsx"), original);
      const { meta } = await service.open("w", dir, "book.xlsx");
      // 与读取/渲染相同的初次打开计算：允许内存更新，但不授权写源或日志。
      const entry = await service.entry(meta.id, dir);
      await entry.live.boot.waitCalc(5000);
      const read = await service.snapshot(meta.id, dir);
      expect(read.snapshot.sheets[read.snapshot.sheetOrder[0]!]!.cellData![1]![2]!.v).toBe(25);
      await service.checkpoint(meta.id, dir);
      expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(original));
      expect(read.meta.rev).toBe(0);
      const ctx: ToolContext = {
        workspaceId: "w",
        workspaceRoot: dir,
        signal: AbortSignal.timeout(10000),
        sessionId: "s",
        agentId: "main",
        toolCallId: "tc",
        role: "main",
        reads: createReadTable(),
        backups: new BackupService(db).bind({
          workspaceId: "w",
          workspaceRoot: dir,
          sessionId: "s",
          agentId: "main",
        }),
      };
      for (const [tool, args] of [
        [
          workbookTools(service).find((t) => t.name === "workbook_read")!,
          { path: "book.xlsx", mode: "range", range: "A1:C2", facets: ["values", "formulas"] },
        ],
        [
          workbookTools(service).find((t) => t.name === "workbook_analyze")!,
          { path: "book.xlsx", mode: "profile", range: "A1:C2" },
        ],
        [workbookRenderTool(service, async () => "cG5n"), { path: "book.xlsx", range: "A1:C2" }],
      ] as const) {
        const receipt = await tool.execute(args as never, ctx);
        expect(receipt).toMatchObject({
          status: "ok",
          data: {
            sourceFile: {
              openedSha256: sha256(original),
              currentSha256: sha256(original),
              changedSinceOpen: false,
              calculation: "computed-in-memory-not-persisted",
              pendingWrite: false,
            },
          },
        });
      }
      if (action === "dryRun" || action === "dryRecalc") {
        expect(
          await service.submit(meta.id, dir, {
            baseRev: 0,
            source: { kind: "agent", id: "main" },
            dryRun: true,
            ops:
              action === "dryRecalc"
                ? [{ op: "recalculate" }]
                : [{ op: "cells.set", range: "A2", values: [[9]] }],
          }),
        ).toMatchObject({ ok: true, dryRun: true });
        await (await service.entry(meta.id, dir)).live.boot.waitCalc(5000);
        await service.checkpoint(meta.id, dir);
        expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(original));
      }
      if (
        action === "recalculate" ||
        action === "recalcPending" ||
        action === "edit" ||
        action === "conflict"
      ) {
        const result = await service.submit(meta.id, dir, {
          baseRev: read.meta.rev,
          source: { kind: "agent", id: "main" },
          sessionId: "s",
          ops:
            action === "recalculate" || action === "recalcPending"
              ? [{ op: "recalculate" }]
              : [{ op: "cells.set", range: "A2", values: [[4]] }],
        });
        expect(result).toMatchObject({ ok: true, calc: "computed" });
        // 复制真实已提交日志和旧磁盘源，模拟进程在检查点前退出后的恢复现场。
        const recoveredPath = join(dir, "recovery.sqlite");
        db.exec(`VACUUM INTO '${recoveredPath.replaceAll("'", "''")}'`);
        const recoveryRoot = mkdtempSync(join(tmpdir(), "readonly-recovery-"));
        const external = structuredClone(snapshot);
        external.sheets[external.sheetOrder[0]!]!.cellData![1]![0] = { v: 9, t: 2 };
        const recoveryBytes = action === "conflict" ? minimalXlsx(external) : original;
        writeFileSync(join(recoveryRoot, "book.xlsx"), recoveryBytes);
        const recoveredDb = openDb(recoveredPath, [
          DOCUMENTS_MIGRATION,
          DOC_OPS_MIGRATION,
          BACKUPS_MIGRATION,
          CHECKPOINT_MIGRATION,
          DOC_MOVES_MIGRATION,
          DOC_OPS_REVERTS_MIGRATION,
        ]);
        if (action === "recalcPending") {
          // 保留显式重算的第一个已提交事务，等价于其后计算结果提交前进程退出。
          const first = recoveredDb
            .prepare(
              "SELECT rev, mutations FROM doc_ops WHERE doc_id=? AND rev>? ORDER BY rev LIMIT 1",
            )
            .get(meta.id, read.meta.rev) as { rev: number; mutations: string };
          expect(JSON.parse(first.mutations)).toEqual([]);
          recoveredDb
            .prepare("DELETE FROM doc_ops WHERE doc_id=? AND rev>?")
            .run(meta.id, first.rev);
          recoveredDb
            .prepare("UPDATE documents SET rev=?,head_rev=? WHERE id=?")
            .run(first.rev, first.rev, meta.id);
        }
        const recovered = new DocumentService(recoveredDb);
        try {
          const reopened = await recovered.open("w", recoveryRoot, "book.xlsx");
          if (action === "conflict") {
            expect(await recovered.sourceStatus(reopened.meta.id, recoveryRoot)).toMatchObject({
              openedSha256: sha256(recoveryBytes),
              currentSha256: sha256(recoveryBytes),
              changedSinceOpen: false,
            });
            await expect(recovered.checkpoint(reopened.meta.id, recoveryRoot)).rejects.toThrow();
            expect(readFileSync(join(recoveryRoot, "book.xlsx"))).toEqual(
              Buffer.from(recoveryBytes),
            );
          } else {
            await recovered.checkpoint(reopened.meta.id, recoveryRoot);
            const back = importXlsx(
              readFileSync(join(recoveryRoot, "book.xlsx")),
              "book.xlsx",
            ).snapshot;
            expect(back.sheets[back.sheetOrder[0]!]!.cellData![1]![2]!.v).toBe(
              action === "recalculate" || action === "recalcPending" ? 25 : 50,
            );
          }
        } finally {
          if (action === "conflict") await expect(recovered.close()).rejects.toThrow();
          else await recovered.close();
          recoveredDb.close();
          rmSync(recoveryRoot, { recursive: true, force: true });
        }
        await service.checkpoint(meta.id, dir);
        expect(await service.sourceStatus(meta.id, dir)).toMatchObject({
          openedSha256: sha256(original),
          changedSinceOpen: true,
          pendingWrite: false,
        });
        expect(readFileSync(join(dir, "book.xlsx"))).not.toEqual(Buffer.from(original));
        const re = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot;
        expect(re.sheets[re.sheetOrder[0]!]!.cellData![1]![2]!.v).toBe(
          action === "recalculate" || action === "recalcPending" ? 25 : 50,
        );
      }
      await service.close();
      const saved = readFileSync(join(dir, "book.xlsx"));
      service = new DocumentService(db);
      await service.open("w", dir, "book.xlsx");
      await service.close();
      expect(readFileSync(join(dir, "book.xlsx"))).toEqual(saved);
    } finally {
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const pendingAction of ["recalculate", "edit", "editUncheckpointed"] as const) {
  test(`待完成 ${pendingAction} 在崩溃后仍恢复；内部授权不进入 xlsx`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "readonly-checkpoint-pending-"));
    const migrations = [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ];
    const db = openDb(join(dir, "db.sqlite"), migrations);
    const service = new DocumentService(db);
    try {
      const snapshot = importCsv(
        new TextEncoder().encode("Qty,Price,Amount\n2,12.5,\n"),
        "book.csv",
      ).snapshot;
      snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData![1]![2] = { f: "=A2*B2" };
      if (pendingAction === "editUncheckpointed") {
        const source = snapshot.sheets[snapshot.sheetOrder[0]!]!;
        snapshot.sheets.s1 = {
          ...structuredClone(source),
          id: "s1",
          name: "Summary",
          cellData: { 1: { 2: { f: `='${source.name}'!A2*'${source.name}'!B2` } } },
        };
        snapshot.sheetOrder.push("s1");
      }
      writeFileSync(join(dir, "book.xlsx"), minimalXlsx(snapshot));
      const { meta } = await service.open("w", dir, "book.xlsx");
      const entry = await service.entry(meta.id, dir);
      await entry.live.boot.waitCalc(5000);
      await service.snapshot(meta.id, dir);
      const savedBefore = db
        .prepare("SELECT checkpoint_snapshot FROM documents WHERE id=?")
        .get(meta.id) as { checkpoint_snapshot: string };
      expect(savedBefore.checkpoint_snapshot).not.toContain("excelmanusPendingCalculation");
      // 模拟计算尚未开始便用尽等待预算，保留真实授权事务、真实检查点与恢复代码。
      const waitCalc = entry.live.boot.waitCalc;
      entry.live.boot.waitCalc = async () => false;
      const pendingResult =
        pendingAction === "recalculate"
          ? await service.recalculate(meta.id, dir, 0)
          : await service.submit(meta.id, dir, {
              baseRev: meta.rev,
              source: { kind: "agent", id: "main" },
              ops: [
                {
                  op: "cells.set",
                  range: `'${snapshot.sheets[snapshot.sheetOrder[0]!]!.name}'!A2`,
                  values: [[4]],
                },
              ],
            });
      expect(pendingResult).toMatchObject({ calc: "pending" });
      if (pendingAction !== "editUncheckpointed") await service.checkpoint(meta.id, dir);
      entry.live.boot.waitCalc = waitCalc;
      const saved = db
        .prepare("SELECT checkpoint_snapshot,head_rev,checkpoint_rev FROM documents WHERE id=?")
        .get(meta.id) as { checkpoint_snapshot: string; head_rev: number; checkpoint_rev: number };
      if (pendingAction !== "editUncheckpointed") {
        expect(saved.head_rev).toBe(saved.checkpoint_rev);
        expect(JSON.parse(saved.checkpoint_snapshot).custom?.excelmanusPendingCalculation).toBe(
          true,
        );
      }
      expect(
        importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx").snapshot.custom
          ?.excelmanusPendingCalculation,
      ).toBeUndefined();
      if (pendingAction === "editUncheckpointed") {
        expect(saved.head_rev).toBeGreaterThan(saved.checkpoint_rev);
        const logs = db.prepare("SELECT mutations FROM doc_ops WHERE doc_id=?").all(meta.id) as {
          mutations: string;
        }[];
        expect(logs).toHaveLength(1);
        const mutations = JSON.parse(logs[0]!.mutations);
        expect(mutations).toHaveLength(1);
        expect(mutations[0].params.subUnitId).toBe(snapshot.sheetOrder[0]);
        expect(mutations[0].params.cellValue).toEqual({ 1: { 0: { v: 4, t: 2 } } });
      }
      const recoveryPath = join(dir, "recovered.sqlite");
      db.exec(`VACUUM INTO '${recoveryPath}'`);
      const recoveryDb = openDb(recoveryPath, migrations);
      const recoveryRoot = mkdtempSync(join(tmpdir(), "pending-recovery-"));
      writeFileSync(join(recoveryRoot, "book.xlsx"), readFileSync(join(dir, "book.xlsx")));
      const recovery = new DocumentService(recoveryDb);
      try {
        await recovery.open("w", recoveryRoot, "book.xlsx");
        await recovery.checkpoint(meta.id, recoveryRoot);
        const back = importXlsx(
          readFileSync(join(recoveryRoot, "book.xlsx")),
          "book.xlsx",
        ).snapshot;
        expect(
          back.sheets[back.sheetOrder[pendingAction === "editUncheckpointed" ? 1 : 0]!]!
            .cellData![1]![2]!.v,
        ).toBe(pendingAction === "recalculate" ? 25 : 50);
        const final = recoveryDb
          .prepare("SELECT checkpoint_snapshot FROM documents WHERE id=?")
          .get(meta.id) as { checkpoint_snapshot: string };
        expect(final.checkpoint_snapshot).not.toContain("excelmanusPendingCalculation");
      } finally {
        await recovery.close();
        recoveryDb.close();
        rmSync(recoveryRoot, { recursive: true, force: true });
      }
    } finally {
      await service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
