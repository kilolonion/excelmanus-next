import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { AXIS_GROUP_MUTATION } from "@excelmanus/protocol";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

function fixture() {
  const bytes = Buffer.from(
    readFileSync(new URL("./fixtures/grouping.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "6e21b2963e638dce4593444c1097c976614dd159459dad61632e8415e1e828bf",
  );
  return bytes;
}

async function setup(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "outline-tools-"));
  const db = openDb(join(dir, "test.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  db.prepare(
    "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('w', 'w', ?, 1, 0, '2026-10-20T00:00:00.000Z')",
  ).run(dir);
  writeFileSync(join(dir, "grouping.xlsx"), bytes);
  const svc = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    agentId: "main",
    sessionId: "s",
    toolCallId: "outline-test",
    role: "main",
    signal: AbortSignal.timeout(60000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const read = workbookTools(svc).find((tool) => tool.name === "workbook_read")!;
  return {
    dir,
    svc,
    ctx,
    read,
    async close() {
      await svc.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("public outline edit is atomic and preserves independent hidden and nested groups through checkpoint, undo and direct mutations", async () => {
  const bytes = fixture();
  const { dir, svc, ctx, read, close } = await setup(bytes);
  try {
    const before = await read.execute(
      { path: "grouping.xlsx", mode: "range", range: "A1:G14", facets: ["layout"] },
      ctx,
    );
    expect(before.status, JSON.stringify(before.error)).toBe("ok");
    expect(before.data).toMatchObject({
      layout: {
        rows: {
          2: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
          3: { hd: 1, custom: { excelmanusOutlineLevel: 2 } },
          8: { custom: { excelmanusCollapsed: true } },
          10: { hd: 1 },
        },
        columns: { 4: { custom: { excelmanusCollapsed: true } }, 5: { hd: 1 } },
        outline: {
          raw: {},
          effective: {
            summaryBelow: true,
            summaryRight: true,
            showOutlineSymbols: true,
            applyStyles: false,
          },
          defaulted: ["summaryBelow", "summaryRight", "showOutlineSymbols", "applyStyles"],
        },
      },
    });
    expect(readFileSync(join(dir, "grouping.xlsx"))).toEqual(bytes);
    const opened = await svc.open("w", dir, "grouping.xlsx");
    const original = (await svc.snapshot(opened.meta.id, dir)).snapshot;
    const sid = original.sheetOrder[0]!;
    const edited = await workbookEditTool(svc).execute(
      {
        path: "grouping.xlsx",
        ops: [
          { op: "axis.hide", sheet: sid, axis: "rows", at: 3, count: 6, hidden: false },
          { op: "axis.hide", sheet: sid, axis: "cols", at: 2, count: 3, hidden: false },
          { op: "axis.collapse", sheet: sid, axis: "rows", at: 9, count: 1, collapsed: false },
          { op: "axis.collapse", sheet: sid, axis: "cols", at: 5, count: 1, collapsed: false },
          { op: "cells.set", range: "B2", values: [[25]] },
        ],
      },
      ctx,
    );
    expect(edited.status, JSON.stringify(edited.error)).toBe("ok");
    const current = await svc.snapshot(opened.meta.id, dir);
    const sheet = current.snapshot.sheets[sid]!;
    expect(sheet.rowData?.[2]?.hd ?? 0).toBe(0);
    expect(sheet.columnData?.[1]?.hd ?? 0).toBe(0);
    expect(sheet.rowData?.[3]?.custom?.excelmanusOutlineLevel).toBe(2);
    expect(sheet.columnData?.[2]?.custom?.excelmanusOutlineLevel).toBe(2);
    expect(sheet.rowData?.[10]?.hd).toBe(1);
    expect(sheet.columnData?.[5]?.hd).toBe(1);
    expect(sheet.rowData?.[8]?.custom?.excelmanusCollapsed ?? false).toBe(false);
    expect(sheet.columnData?.[4]?.custom?.excelmanusCollapsed ?? false).toBe(false);
    await svc.checkpoint(opened.meta.id, dir);
    const unchangedBytes = readFileSync(join(dir, "grouping.xlsx"));
    const invalid = await svc.submit(opened.meta.id, dir, {
      baseRev: current.meta.rev,
      source: { kind: "user", id: "qa" },
      mutations: [
        {
          id: AXIS_GROUP_MUTATION,
          params: {
            unitId: current.snapshot.id,
            subUnitId: sid,
            axis: "rows",
            collapsed: { 8: true },
          },
        },
        {
          id: AXIS_GROUP_MUTATION,
          params: {
            unitId: current.snapshot.id,
            subUnitId: sid,
            axis: "cols",
            collapsed: { 16384: true },
          },
        },
      ],
    });
    expect(invalid).toMatchObject({ ok: false, code: "BAD_OPERATION" });
    expect((await svc.snapshot(opened.meta.id, dir)).meta.rev).toBe(current.meta.rev);
    expect((await svc.snapshot(opened.meta.id, dir)).snapshot.sheets[sid]?.rowData).toEqual(
      sheet.rowData,
    );
    expect(readFileSync(join(dir, "grouping.xlsx"))).toEqual(unchangedBytes);
    await svc.checkpoint(opened.meta.id, dir);
    const reopened = importXlsx(readFileSync(join(dir, "grouping.xlsx")), "grouping.xlsx").snapshot;
    const reopenedSheet = reopened.sheets[reopened.sheetOrder[0]!]!;
    expect(reopenedSheet.rowData?.[8]?.custom?.excelmanusCollapsed ?? false).toBe(false);
    expect(reopenedSheet.columnData?.[4]?.custom?.excelmanusCollapsed ?? false).toBe(false);
    expect(reopenedSheet.rowData?.[3]?.custom?.excelmanusOutlineLevel).toBe(2);
    expect(reopenedSheet.rowData?.[10]?.hd).toBe(1);
    expect(reopenedSheet.cellData?.[1]?.[1]?.v).toBe(25);
    const undo = await svc.revert(opened.meta.id, dir, current.meta.rev, {
      kind: "user",
      id: "qa",
    });
    expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
    await svc.checkpoint(opened.meta.id, dir);
    const restored = (await svc.snapshot(opened.meta.id, dir)).snapshot.sheets[sid]!;
    expect(restored.rowData?.[8]?.custom?.excelmanusCollapsed).toBe(true);
    expect(restored.columnData?.[4]?.custom?.excelmanusCollapsed).toBe(true);
    expect(restored.rowData?.[2]?.hd).toBe(1);
    const undoReopened = importXlsx(
      readFileSync(join(dir, "grouping.xlsx")),
      "grouping.xlsx",
    ).snapshot;
    const undoSheet = undoReopened.sheets[undoReopened.sheetOrder[0]!]!;
    expect(undoSheet.rowData?.[8]?.custom?.excelmanusCollapsed).toBe(true);
    expect(undoSheet.columnData?.[4]?.custom?.excelmanusCollapsed).toBe(true);
    expect(undoSheet.rowData?.[2]?.hd).toBe(1);
    const direct = await svc.submit(opened.meta.id, dir, {
      baseRev: (await svc.snapshot(opened.meta.id, dir)).meta.rev,
      source: { kind: "user", id: "qa" },
      mutations: [
        {
          id: AXIS_GROUP_MUTATION,
          params: {
            unitId: current.snapshot.id,
            subUnitId: sid,
            axis: "rows",
            collapsed: { 8: false },
          },
        },
      ],
    });
    expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true });
    await svc.checkpoint(opened.meta.id, dir);
    const directReopened = importXlsx(
      readFileSync(join(dir, "grouping.xlsx")),
      "grouping.xlsx",
    ).snapshot;
    const directSheet = directReopened.sheets[directReopened.sheetOrder[0]!]!;
    expect(directSheet.rowData?.[8]?.custom?.excelmanusCollapsed ?? false).toBe(false);
    expect(directSheet.rowData?.[2]?.hd).toBe(1);
    expect(directSheet.rowData?.[3]?.custom?.excelmanusOutlineLevel).toBe(2);
  } finally {
    await close();
  }
}, 60000);

test("layout reports every imported column in an interval and distinguishes raw outline attributes from defaults", async () => {
  const parts = unzipSync(fixture());
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(parts["xl/worksheets/sheet1.xml"]!)
      .replace(
        "<outlinePr/>",
        '<outlinePr summaryBelow="0" summaryRight="false" showOutlineSymbols="off" applyStyles="1" vendor="keep"/>',
      )
      .replace(
        '<col min="7" max="16" width="9.140625"/>',
        '<col min="7" max="16" width="9.140625" hidden="1" outlineLevel="2" collapsed="1"/>',
      ),
  );
  const { ctx, read, close } = await setup(zipSync(parts));
  try {
    const result = await read.execute(
      { path: "grouping.xlsx", mode: "range", range: "G1:P14", facets: ["layout"] },
      ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      layout: {
        columns: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            i + 6,
            { hd: 1, custom: { excelmanusOutlineLevel: 2, excelmanusCollapsed: true } },
          ]),
        ),
        outline: {
          raw: {
            summaryBelow: "0",
            summaryRight: "false",
            showOutlineSymbols: "off",
            applyStyles: "1",
            vendor: "keep",
          },
          effective: {
            summaryBelow: false,
            summaryRight: false,
            showOutlineSymbols: false,
            applyStyles: true,
          },
          defaulted: [],
        },
      },
    });
  } finally {
    await close();
  }
}, 60000);
