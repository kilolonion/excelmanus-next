import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { CF_RESOURCE, rulesResource, setRulesResource } from "../src/rule-codec.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

const rules = [
  {
    type: "colorScale",
    config: [
      { index: 0, color: "#FF0000", value: { type: "min" } },
      { index: 1, color: "#FFFF00", value: { type: "percentile", value: 50 } },
      { index: 2, color: "#00FF00", value: { type: "max" } },
    ],
  },
  {
    type: "dataBar",
    isShowValue: false,
    config: {
      min: { type: "num", value: 0 },
      max: { type: "num", value: 100 },
      positiveColor: "#123456",
      nativeColor: "#123456",
      isGradient: true,
    },
  },
  {
    type: "iconSet",
    isShowValue: true,
    config: [
      {
        operator: "greaterThanOrEqual",
        value: { type: "percent", value: 67 },
        iconType: "3Arrows",
        iconId: "2",
      },
      {
        operator: "greaterThanOrEqual",
        value: { type: "percent", value: 33 },
        iconType: "3Arrows",
        iconId: "1",
      },
      {
        operator: "greaterThanOrEqual",
        value: { type: "percent", value: 0 },
        iconType: "3Arrows",
        iconId: "0",
      },
    ],
  },
];
for (const rule of rules)
  test(`${rule.type} 条件格式可保存、重开、修改和删除`, () => {
    const initial = importXlsx(
      minimalXlsx(importCsv(new TextEncoder().encode("n\n10\n30\n80\n"), "a.csv").snapshot),
      "a.xlsx",
    );
    const snapshot = structuredClone(initial.snapshot);
    const sid = snapshot.sheetOrder[0]!;
    const item = {
      cfId: "visual",
      stopIfTrue: false,
      ranges: [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 0 }],
      rule,
    };
    setRulesResource(snapshot, CF_RESOURCE, { [sid]: [item] });
    const reopened = importXlsx(exportXlsx(initial, snapshot), "a.xlsx");
    expect(rulesResource(reopened.snapshot, CF_RESOURCE)[sid]?.[0]).toEqual(item);
    const edited = structuredClone(reopened.snapshot);
    setRulesResource(edited, CF_RESOURCE, {
      [sid]: [{ ...item, ranges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }] }],
    });
    const twice = importXlsx(exportXlsx(reopened, edited), "a.xlsx");
    expect(rulesResource(twice.snapshot, CF_RESOURCE)[sid]).toHaveLength(1);
    expect(rulesResource(twice.snapshot, CF_RESOURCE)[sid]?.[0]?.ranges[0]?.endRow).toBe(2);
    const cleared = structuredClone(twice.snapshot);
    setRulesResource(cleared, CF_RESOURCE, { [sid]: [] });
    expect(
      rulesResource(importXlsx(exportXlsx(twice, cleared), "a.xlsx").snapshot, CF_RESOURCE)[sid] ??
        [],
    ).toEqual([]);
  });

test("新建色阶不移除无法编辑的现有规则", async () => {
  const { unzipSync, zipSync } = await import("fflate");
  const parts = unzipSync(
    minimalXlsx(importCsv(new TextEncoder().encode("n\n1\n2\n"), "a.csv").snapshot),
  );
  const path = "xl/worksheets/sheet1.xml";
  const unknown =
    '<conditionalFormatting sqref="A2:A3"><cfRule type="top10" rank="1" priority="1"/></conditionalFormatting>';
  parts[path] = new TextEncoder().encode(
    new TextDecoder().decode(parts[path]).replace("</worksheet>", unknown + "</worksheet>"),
  );
  const before = importXlsx(zipSync(parts), "a.xlsx");
  const after = structuredClone(before.snapshot),
    sid = after.sheetOrder[0]!;
  setRulesResource(after, CF_RESOURCE, {
    [sid]: [
      {
        cfId: "new",
        stopIfTrue: false,
        ranges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }],
        rule: rules[0],
      },
    ],
  });
  const bytes = exportXlsx(before, after);
  expect(new TextDecoder().decode(unzipSync(bytes)[path])).toContain(unknown);
  expect(rulesResource(importXlsx(bytes, "a.xlsx").snapshot, CF_RESOURCE)[sid]).toHaveLength(1);
});

test("三种视觉规则通过活文档提交、检查点与撤销", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-live-"));
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
    writeFileSync(
      join(root, "a.xlsx"),
      minimalXlsx(importCsv(new TextEncoder().encode("n\n10\n30\n80\n"), "a.csv").snapshot),
    );
    const { meta } = await svc.open("ws", root, "a.xlsx");
    const before = await svc.snapshot(meta.id, root),
      sid = before.snapshot.sheetOrder[0]!;
    const result = await svc.submit(meta.id, root, {
      baseRev: before.meta.rev,
      source: { kind: "user", id: "cf-ui" },
      mutations: rules.map((rule, i) => ({
        id: "sheet.mutation.add-conditional-rule",
        params: {
          unitId: before.snapshot.id,
          subUnitId: sid,
          rule: {
            cfId: `cf${i}`,
            stopIfTrue: false,
            ranges: [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 0 }],
            rule,
          },
        },
      })),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    await svc.checkpoint(meta.id, root);
    const reopened = importXlsx(readFileSync(join(root, "a.xlsx")), "a.xlsx");
    expect(
      rulesResource(reopened.snapshot, CF_RESOURCE)
        [sid]?.map((r) => r.rule.type)
        .sort(),
    ).toEqual(["colorScale", "dataBar", "iconSet"]);
    expect(
      await svc.undoRevision(meta.id, root, result.rev, { kind: "user", id: "undo" }),
    ).toMatchObject({ ok: true });
    await svc.checkpoint(meta.id, root);
    expect(
      rulesResource(importXlsx(readFileSync(join(root, "a.xlsx")), "a.xlsx").snapshot, CF_RESOURCE)[
        sid
      ] ?? [],
    ).toEqual([]);
  } finally {
    await svc.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
