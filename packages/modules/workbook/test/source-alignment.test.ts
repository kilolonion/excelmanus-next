import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  runWithToolAccess,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { z } from "zod";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { verifySourceAlignment } from "../src/source-alignment.ts";
import { workbookTools } from "../src/tools.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/source-alignment-round6.json", import.meta.url), "utf8"),
);
const docs = (name: string) => {
  const f = structuredClone(fixtures[name]);
  return {
    target: { docId: "target", path: "output.xlsx", rev: 0, ...f.target },
    source: { name: "source", docId: "source", path: "source.xlsx", rev: 0, ...f.source },
  };
};
function run(
  name: string,
  range: string,
  requiredColumns: readonly string[],
  bindings: readonly any[],
  change?: (d: any) => void,
) {
  const d = docs(name);
  change?.(d);
  return verifySourceAlignment({
    target: d.target,
    range,
    headerRow: 1,
    requiredColumns: [...requiredColumns],
    bindings: [...bindings],
    sources: [
      {
        ...d.source,
        range:
          name === "merged"
            ? "销售月报!A1:G11"
            : name === "wide"
              ? "部门预算!A1:G12"
              : "数据!A1:E" + (name === "orders" ? 10 : 8),
      },
    ],
  });
}
const cell = (column: string, referenceColumn: string) => ({
  kind: "cell" as const,
  column,
  source: "source",
  referenceColumn,
});
test("fixed merged artifact rejects both wrong source rows and accepts corrected references", () => {
  const args = ["merged", "明细!A2:N9", ["客户ID"], [cell("客户ID", "客户来源")]] as const;
  const bad = run(...args);
  expect(bad.failedCount).toBe(2);
  expect(bad.failures.map((x: any) => x.targetCell)).toEqual(["明细!B8", "明细!B9"]);
  const good = run(...args, (d) => {
    for (const r of [7, 8]) d.target.sheets["明细"].cellData[r][9].v = "销售月报!B8";
  });
  expect(good.status).toBe("verified");
  expect(good.scope).toBe("declared_fields_only");
  expect(good.uncoveredColumns).toContain("收入元");
});
test("fixed wide artifact catches shifted raw values even when totals were made self consistent", () => {
  const bad = run("wide", "明细!A2:P13", ["原始值"], [cell("原始值", "金额来源")]);
  expect(bad.failedCount).toBe(2);
  expect(bad.failures.map((x: any) => x.targetCell)).toEqual(["明细!F5", "明细!F6"]);
  const good = run("wide", "明细!A2:P13", ["原始值"], [cell("原始值", "金额来源")], (d) => {
    d.target.sheets["明细"].cellData[4][5] = { v: 200 };
    delete d.target.sheets["明细"].cellData[5][5];
  });
  expect(good.status).toBe("verified");
});
const lookup = {
  kind: "lookup",
  column: "客户ID",
  source: "source",
  keys: [{ targetColumn: "订单ID", sourceColumn: "订单ID" }],
  valueColumn: "客户ID",
  where: [{ column: "状态", equals: "DONE" }],
  duplicatePolicy: "identical_rows",
  duplicateColumns: ["订单ID", "客户ID", "完成时间", "状态", "金额分"],
  conflictPolicy: "expect_blank",
};
for (const name of ["orders", "cutoff"])
  test(`fixed ${name} preserves identity even for excluded rows`, () => {
    const range = name === "orders" ? "逐行!A11:J21" : "逐行!A9:J20";
    const bad = run(name, range, ["客户ID"], [lookup]);
    expect(bad.failedCount).toBe(4);
    const good = run(name, range, ["客户ID"], [lookup], (d) => {
      const patch: [number, string][] =
        name === "orders"
          ? [
              [11, "1"],
              [14, "001"],
              [19, "1"],
              [20, "1"],
            ]
          : [
              [11, "001"],
              [12, "1"],
              [13, "001"],
              [19, "1"],
            ];
      for (const [row, v] of patch) d.target.sheets["逐行"].cellData[row][5] = { v };
    });
    expect(good.status).toBe("verified");
    expect(good.failedCount).toBe(0);
  });
test("missing declaration is unverified and duplicate matches are not silently collapsed", () => {
  expect(
    run("merged", "明细!A2:N9", ["客户ID", "商品ID"], [cell("客户ID", "客户来源")]).unverifiedCount,
  ).toBeGreaterThan(0);
  const result = run(
    "orders",
    "逐行!A11:J21",
    ["客户ID"],
    [{ ...lookup, conflictPolicy: "unverified" }],
  );
  expect(result.unverifiedCount).toBeGreaterThan(0);
  expect(result.conflictKeyCount).toBe(1);
});
test("period derives actual year and month and rejects an amount reference moved to another month", () => {
  const p = {
    kind: "period",
    column: "月份",
    source: "source",
    yearReferenceColumn: "年份来源",
    monthReferenceColumn: "月份来源",
    valueReferenceColumn: "金额来源",
  };
  expect(run("wide", "明细!A2:P13", ["月份"], [p]).status).toBe("verified");
  const bad = run("wide", "明细!A2:P13", ["月份"], [p], (d) => {
    d.target.sheets["明细"].cellData[4][15].v = "部门预算!F6";
  });
  expect(bad.failedCount).toBe(1);
  expect(bad.failures[0]?.code).toBe("SOURCE_COLUMN_MISMATCH");
  expect(
    run("wide", "明细!A2:P13", ["月份"], [p], (d) => {
      d.target.sheets["明细"].cellData[4][3].v = "2026-08";
    }).failedCount,
  ).toBe(1);
});
test("null, empty string, zero and text identities are not coerced", () => {
  const d = docs("merged");
  const s = d.source.sheets["销售月报"],
    t = d.target.sheets["明细"];
  for (const [sourceValue, targetValue] of [
    [null, ""],
    ["001", 1],
    [0, null],
    ["1", 1],
  ]) {
    s.cellData[4][1] = { v: sourceValue };
    t.cellData[1][1] = { v: targetValue };
    const out = verifySourceAlignment({
      target: d.target,
      range: "明细!A2:N2",
      headerRow: 1,
      requiredColumns: ["客户ID"],
      bindings: [cell("客户ID", "客户来源")],
      sources: [{ ...d.source, range: "销售月报!A1:G11" }],
    });
    expect(out.failedCount).toBe(1);
  }
});
test("merged source row rules use actual merge geometry, never arbitrary fill down", () => {
  const b = { ...cell("客户ID", "客户来源"), mergeAnchor: true, rowColumn: "源行" };
  expect(run("merged", "明细!A2:N5", ["客户ID"], [b]).status).toBe("verified");
  expect(
    run("merged", "明细!A2:N5", ["客户ID"], [b], (d) => {
      d.source.sheets["销售月报"].mergeData = [];
    }).failedCount,
  ).toBe(2);
});
test("unknown transformations and external source refs cannot produce verified receipts", () => {
  expect(
    run(
      "merged",
      "明细!A2:N2",
      ["客户ID"],
      [{ kind: "arbitrary", column: "客户ID", source: "source" }],
    ).status,
  ).toBe("unverified");
  expect(
    run("merged", "明细!A2:N2", ["客户ID"], [cell("客户ID", "客户来源")], (d) => {
      d.target.sheets["明细"].cellData[1][9].v = "[else.xlsx]销售月报!B5";
    }).status,
  ).toBe("unverified");
});
test("duplicate declarations and partial duplicate comparisons are unverified", () => {
  expect(
    run(
      "merged",
      "明细!A2:N2",
      ["客户ID"],
      [cell("客户ID", "客户来源"), cell("客户ID", "客户来源")],
    ).status,
  ).toBe("unverified");
  expect(
    run(
      "orders",
      "逐行!A11:J21",
      ["客户ID"],
      [{ ...lookup, duplicateColumns: ["订单ID", "客户ID"] }],
    ).status,
  ).toBe("unverified");
});
test("review regressions: fractional worksheet rows and duplicate required columns cannot verify", () => {
  expect(
    run(
      "merged",
      "明细!A2:N2",
      ["客户ID"],
      [{ ...cell("客户ID", "客户来源"), mergeAnchor: true, rowColumn: "源行" }],
      (d) => {
        d.target.sheets["明细"].cellData[1][7].v = 5.5;
      },
    ).status,
  ).not.toBe("verified");
  expect(
    run("merged", "明细!A2:N2", ["客户ID", "客户ID"], [cell("客户ID", "客户来源")]).status,
  ).toBe("unverified");
});
test("declared numeric types cannot silently become text and boolean storage stays boolean", () => {
  expect(
    run("merged", "明细!A2:N2", ["客户ID"], [cell("客户ID", "客户来源")], (d) => {
      d.source.sheets["销售月报"].cellData[4][1] = { v: "001", t: 2 };
    }).status,
  ).toBe("unverified");
  expect(
    run("merged", "明细!A2:N2", ["客户ID"], [cell("客户ID", "客户来源")], (d) => {
      d.source.sheets["销售月报"].cellData[4][1] = { v: 1, t: 3 };
      d.target.sheets["明细"].cellData[1][1] = { v: true };
    }).status,
  ).toBe("verified");
});
test("year provenance must cover the actual amount column even if month reference uses a merged nonanchor", () => {
  const d = docs("wide");
  const s = d.source.sheets["部门预算"];
  s.cellData[2][4] = { v: 2025 };
  s.cellData[2][5] = { v: 2026 };
  s.mergeData = s.mergeData.filter((m: any) => m.startRow !== 2 && m.startRow !== 3);
  s.mergeData.push({ startRow: 3, endRow: 3, startColumn: 4, endColumn: 5 });
  s.cellData[3][4] = { v: "7月" };
  const t = d.target.sheets["明细"];
  t.cellData[4][13] = { v: "部门预算!F3" };
  t.cellData[4][14] = { v: "部门预算!F4" };
  t.cellData[4][15] = { v: "部门预算!E6" };
  t.cellData[4][3] = { v: "2026-07" };
  const out = verifySourceAlignment({
    target: d.target,
    range: "明细!A5:P5",
    headerRow: 1,
    requiredColumns: ["月份"],
    bindings: [
      {
        kind: "period",
        column: "月份",
        source: "source",
        yearReferenceColumn: "年份来源",
        monthReferenceColumn: "月份来源",
        valueReferenceColumn: "金额来源",
      },
    ],
    sources: [{ ...d.source, range: "部门预算!A1:G12" }],
  });
  expect(out.failedCount).toBe(1);
  expect(out.failures[0]?.code).toBe("YEAR_COLUMN_MISMATCH");
});
test("real tool source alignment binds saved versions and reads without changing either file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "source-alignment-"));
  const db = openDb(join(dir, "db.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    DOC_MOVES_MIGRATION,
    CHECKPOINT_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('ws','ws',?,1,0,'2026-10-22T00:00:00.000Z')",
  ).run(dir);
  const service = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "ws",
    workspaceRoot: dir,
    sessionId: "s",
    agentId: "main",
    toolCallId: "test",
    role: "main",
    signal: AbortSignal.timeout(30000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "ws",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
    }),
  };
  try {
    const edit = workbookEditTool(service),
      analyze = workbookTools(service).find((t) => t.name === "workbook_analyze")!;
    const publicSchema = analyze.inputJsonSchema ?? z.toJSONSchema(analyze.input);
    const schemaText = JSON.stringify(publicSchema);
    for (const field of [
      "source_alignment",
      "alignment",
      "referenceColumn",
      "yearReferenceColumn",
      "conflictPolicy",
    ])
      expect(schemaText).toContain(field);
    expect(analyze.roles).toContain("reader");
    expect(analyze.description).toContain("未调用或未覆盖不得声称全面正确");
    for (const [path, values] of [
      ["source.xlsx", [["id"], ["001"]]],
      [
        "target.xlsx",
        [
          ["id", "reference"],
          ["001", "Sheet1!A2"],
        ],
      ],
    ] as const) {
      const created = await edit.execute(
        {
          path,
          create: true,
          ops: [
            { op: "cells.set", range: `Sheet1!A1:${path === "source.xlsx" ? "A" : "B"}2`, values },
          ],
        },
        ctx,
      );
      expect(created.status, JSON.stringify(created)).toBe("ok");
    }
    const before = Object.fromEntries(
      ["source.xlsx", "target.xlsx"].map((p) => [p, readFileSync(join(dir, p)).toString("base64")]),
    );
    const args = {
      path: "target.xlsx",
      mode: "source_alignment",
      range: "Sheet1!A2:B2",
      sources: [{ name: "s", path: "source.xlsx", range: "Sheet1!A1:A2" }],
      alignment: {
        headerRow: 1,
        requiredColumns: ["id"],
        bindings: [{ kind: "cell", column: "id", source: "s", referenceColumn: "reference" }],
      },
    };
    const result = await analyze.execute(args, ctx);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(result.data).toMatchObject({
      mode: "source_alignment",
      verification: { status: "verified", scope: "declared_fields_only" },
      versionBindings: [{ isCurrentSaved: true }, { isCurrentSaved: true }],
    });
    for (const p of Object.keys(before))
      expect(readFileSync(join(dir, p)).toString("base64")).toBe(before[p]);
    const sameDoc = await analyze.execute(
      {
        ...args,
        sources: [{ name: "s", range: "Sheet1!A1:B2" }],
        alignment: {
          headerRow: 1,
          requiredColumns: ["id"],
          bindings: [
            {
              kind: "lookup",
              column: "id",
              source: "s",
              keys: [{ targetColumn: "id", sourceColumn: "id" }],
              valueColumn: "id",
            },
          ],
        },
      },
      ctx,
    );
    expect(sameDoc.data).toMatchObject({ verification: { status: "verified" } });
    const savedStatus = service.sourceStatus.bind(service);
    let hashCalls = 0;
    service.sourceStatus = async (id, root) => {
      const status = await savedStatus(id, root);
      return ++hashCalls === 4 ? { ...status, currentSha256: "changed-during-read" } : status;
    };
    const hashChanged = await analyze.execute(args, ctx);
    expect(hashChanged.data).toMatchObject({
      verification: { status: "unverified" },
      versionBindings: [{ isCurrentSaved: true }, { isCurrentSaved: false }],
    });
    service.sourceStatus = savedStatus;
    const denied = await runWithToolAccess(
      {
        db,
        log: new SessionLog(db),
        workspaceRoot: dir,
        sessionId: "s",
        agentId: "main",
        turnId: "t",
        toolCallId: "c",
        originAgentId: "main",
        originTurnId: "t",
        auditFailed: false,
        binding: () => ({
          originAgentId: "main",
          originTurnId: "t",
          sourceDispatchIds: [],
          ruleVersion: 1,
          decision: { kind: "restricted", root: "target.xlsx" },
          accessDeliveryRequired: true,
        }),
      },
      () => analyze.execute(args, ctx),
    );
    expect(denied.status).toBe("error");
    // A stale observed revision is not certified even when the cell values still match.
    const original = service.sourceStatus.bind(service);
    let calls = 0;
    service.sourceStatus = async (id, root) => {
      const status = await original(id, root);
      if (++calls === 3) {
        const e = await service.entry(id, root);
        e.meta.rev++;
      }
      return status;
    };
    const stale = await analyze.execute(args, ctx);
    expect(stale.data).toMatchObject({ verification: { status: "unverified" } });
    // Pending cold state is rejected before open can replay/checkpoint. No file or ledger mutation.
    const meta = await service.open("ws", dir, "source.xlsx");
    expect(
      await service.submit(meta.meta.id, dir, {
        baseRev: meta.meta.rev,
        source: { kind: "agent", id: "session/main" },
        sessionId: "session",
        ops: [{ op: "cells.set", range: "Sheet1!A2", values: [["002"]] }],
      }),
    ).toMatchObject({ ok: true });
    clearTimeout((await service.entry(meta.meta.id, dir)).timer); // Simulated crash: durable op, no scheduled flush.
    const beforePending = readFileSync(join(dir, "source.xlsx")),
      mtime = statSync(join(dir, "source.xlsx")).mtimeMs;
    const cold = new DocumentService(db),
      coldOpen = cold.open.bind(cold);
    let sourceOpenCalls = 0;
    cold.open = async (...params) => {
      if (params[2] === "source.xlsx") sourceOpenCalls++;
      return coldOpen(...params);
    };
    const backupCount = db.prepare("SELECT COUNT(*) AS n FROM backups").get();
    const ledger = db
      .prepare("SELECT head_rev,rev,checkpoint_rev,checkpoint_hash FROM documents WHERE id=?")
      .get(meta.meta.id);
    const pending = await workbookTools(cold)
      .find((t) => t.name === "workbook_analyze")!
      .execute(args, ctx);
    expect(pending.status).toBe("error");
    expect(pending.error?.code).toBe("VERSION_CONFLICT");
    expect(sourceOpenCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM backups").get()).toEqual(backupCount);
    expect(
      db
        .prepare("SELECT head_rev,rev,checkpoint_rev,checkpoint_hash FROM documents WHERE id=?")
        .get(meta.meta.id),
    ).toEqual(ledger);
    expect(readFileSync(join(dir, "source.xlsx"))).toEqual(beforePending);
    expect(statSync(join(dir, "source.xlsx")).mtimeMs).toBe(mtime);
    // Control: the unchanged legacy cold-open path really restores and checkpoints these durable ops.
    await coldOpen("ws", dir, "source.xlsx");
    expect(readFileSync(join(dir, "source.xlsx"))).not.toEqual(beforePending);
    expect(
      db
        .prepare("SELECT head_rev=checkpoint_rev AS saved FROM documents WHERE id=?")
        .get(meta.meta.id),
    ).toMatchObject({ saved: 1 });
    await cold.close();
  } finally {
    await service.close().catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work budgets fail closed and display truncation never truncates verification counts", () => {
  const d = docs("merged"),
    sheet = d.target.sheets["明细"];
  const row = structuredClone(sheet.cellData[7]);
  sheet.cellData = { 0: sheet.cellData[0] };
  for (let i = 1; i <= 120; i++) sheet.cellData[i] = structuredClone(row);
  sheet.rowCount = 121;
  const args = {
    target: d.target,
    range: "明细!A2:N121",
    headerRow: 1,
    requiredColumns: ["客户ID"],
    bindings: [cell("客户ID", "客户来源")],
    sources: [{ ...d.source, range: "销售月报!A1:G11" }],
  };
  const limited = verifySourceAlignment(args);
  expect(limited.failedCount).toBe(120);
  expect(limited.failures).toHaveLength(100);
  expect(limited.failuresTruncated).toBe(true);
  sheet.rowCount = 300000;
  const budget = verifySourceAlignment({ ...args, range: "明细!A2:N300000" });
  expect(budget.status).toBe("unverified");
  expect(budget.checkedCellCount).toBe(0);
});
test("finite scale is host computed and never coerces text or blank to zero", () => {
  const b = { ...cell("收入元", "收入来源"), scale: 2 };
  expect(
    run("merged", "明细!A2:N2", ["收入元"], [b], (d) => {
      d.target.sheets["明细"].cellData[1][5] = { v: 60 };
    }).status,
  ).toBe("verified");
  expect(
    run("merged", "明细!A2:N2", ["收入元"], [b], (d) => {
      d.source.sheets["销售月报"].cellData[4][4] = { v: "30" };
    }).status,
  ).toBe("unverified");
});

test("public analyze input schema matches defaults and keeps existing mode requirements", () => {
  const tool = workbookTools({} as DocumentService).find((t) => t.name === "workbook_analyze")!;
  const schema = JSON.parse(JSON.stringify(tool.inputJsonSchema ?? z.toJSONSchema(tool.input)));
  expect(schema.required).toEqual(["mode"]);
  expect(schema.properties.mode.enum).toEqual([
    "sql",
    "profile",
    "diff",
    "check",
    "sort_preflight",
    "source_alignment",
  ]);
  expect(schema.properties.alignment.properties.requiredColumns.uniqueItems).toBe(true);
  const bindings = schema.properties.alignment.properties.bindings.items.oneOf;
  expect(bindings[0].required).toEqual(["column", "source", "kind", "referenceColumn"]);
  expect(bindings[2].required).toEqual(["column", "source", "kind", "keys", "valueColumn"]);
  expect(tool.input.safeParse({ path: "source.xlsx", mode: "profile" }).success).toBe(true);
  expect(tool.input.safeParse({ docId: "existing", mode: "profile" }).success).toBe(true);
  expect(tool.input.safeParse({ path: "source.xlsx" }).success).toBe(false);
  expect(
    tool.input.safeParse({
      mode: "source_alignment",
      alignment: {
        headerRow: 1,
        requiredColumns: ["客户ID"],
        bindings: [{ ...lookup, where: [{ column: "状态", equals: "DONE", not: true }] }],
      },
    }).success,
  ).toBe(false);
  expect(
    tool.input.safeParse({
      mode: "source_alignment",
      alignment: {
        headerRow: 1,
        requiredColumns: ["客户ID"],
        bindings: [
          {
            ...lookup,
            keys: [{ targetColumn: "订单ID", sourceColumn: "订单ID", normalize: "number" }],
          },
        ],
      },
    }).success,
  ).toBe(false);
});

test("source guidance is advertised early with callable examples and precise input meanings", () => {
  const tool = workbookTools({} as DocumentService).find((t) => t.name === "workbook_analyze")!;
  const schema = JSON.parse(JSON.stringify(tool.inputJsonSchema));
  expect(tool.roles).toContain("main");
  expect(tool.description.indexOf("source_alignment")).toBeLessThan(200);
  expect(tool.description).toContain("不会发现目标中完全遗漏的源行");
  expect(tool.description).toContain("源行×月份");
  expect(tool.description).toContain("排除依据");
  const binding = schema.properties.alignment.properties.bindings.items.oneOf[0].properties;
  expect(binding.source.description).toContain("sources[].name");
  for (const field of ["column", "referenceColumn", "rowColumn"])
    expect(binding[field].description).toContain("目标表头");
  expect(binding.rowColumn.description).toContain("1 基");
  expect(binding.mergeAnchor.description).toContain("真实合并");
  expect(binding.sameColumnAs.description).toContain("来源引用列");
  const example = JSON.parse(schema.properties.alignment.description.split("完整调用示例：")[1]);
  expect(tool.input.safeParse(example).success).toBe(true);
  expect(example.alignment.bindings[0]).toMatchObject({
    rowColumn: "源行",
    source: example.sources[0].name,
  });
  const check = JSON.parse(schema.properties.checks.description.split("完整调用示例：")[1]);
  expect(tool.input.safeParse(check).success).toBe(true);
  expect(check.checks[0].kind).toBe("row_expression");
});

test("paired wrong identity and reference require the declared physical source row", () => {
  const change = (d: any) => {
    for (const r of [7, 8]) d.target.sheets["明细"].cellData[r][1].v = "1";
  };
  const binding = cell("客户ID", "客户来源");
  const weak = run("merged", "明细!A8:N9", ["客户ID"], [binding], change);
  expect(weak.status).toBe("verified");
  expect(weak.scope).toBe("declared_fields_only");
  expect(weak.limitation).toContain("不代表整个工作簿正确");
  const bad = run("merged", "明细!A8:N9", ["客户ID"], [{ ...binding, rowColumn: "源行" }], change);
  expect(bad.failedCount).toBe(2);
  expect(bad.failures.every((f) => f.code === "SOURCE_ROW_MISMATCH")).toBe(true);
  const fixed = run(
    "merged",
    "明细!A8:N9",
    ["客户ID"],
    [{ ...binding, rowColumn: "源行" }],
    (d) => {
      for (const r of [7, 8]) d.target.sheets["明细"].cellData[r][9].v = "销售月报!B8";
    },
  );
  expect(fixed.status).toBe("verified");
  expect(fixed.scope).toBe("declared_fields_only");
});

test("nine surviving rows are only declared-field verification, not complete source coverage", () => {
  const result = run(
    "wide",
    "明细!A2:P10",
    ["部门ID"],
    [{ ...cell("部门ID", "部门来源"), rowColumn: "源行", mergeAnchor: true }],
    (d) => {
      const s = d.target.sheets["明细"];
      const kept = Object.entries(s.cellData).filter(
        ([r, cells]: any) => r === "0" || cells[8].v !== 7,
      );
      s.cellData = Object.fromEntries(kept.map(([, cells], i) => [i, cells]));
    },
  );
  expect(result.status).toBe("verified");
  expect(result.declaredCellCount).toBe(9);
  expect(result.scope).toBe("declared_fields_only");
  expect(result.uncoveredColumns).toContain("月份");
  expect(result.limitation).toContain("全部业务要求");
});
