// 只读活文档真实边界测试（07 §3、06 §4.1–4.2）：
// 真实 samples/sales.xlsx 与 GBK CSV 落盘工作区，经 DocumentService + 工具实参直跑。

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "@excelmanus/kernel";
import { BACKUPS_MIGRATION, BackupService, createReadTable, openDb } from "@excelmanus/kernel";
import { afterAll, describe, expect, test } from "vitest";
import { capToolOutput } from "../../../kernel/src/projections.ts";
import { workbookEditTool } from "../src/edit.ts";
import { WorkbookEditInput } from "../src/edit-input.ts";
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

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "workbook-test-"));
  dirs.push(dir);
  const workspaceRoot = join(dir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const samples = join(dirname(fileURLToPath(import.meta.url)), "../../../../samples");
  cpSync(join(samples, "sales.xlsx"), join(workspaceRoot, "sales.xlsx"));
  cpSync(join(samples, "catalog-gbk.csv"), join(workspaceRoot, "catalog-gbk.csv"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const tools = workbookTools(service);
  const read = tools.find((t) => t.name === "workbook_read");
  const analyze = tools.find((t) => t.name === "workbook_analyze");
  if (!read || !analyze) throw new Error("工具未注册");
  const ctx: ToolContext = {
    workspaceId: "ws1",
    workspaceRoot,
    signal: AbortSignal.timeout(10_000),
    sessionId: "ses1",
    agentId: "main",
    toolCallId: "tc1",
    role: "main",
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "ws1",
      workspaceRoot,
      sessionId: "ses1",
      agentId: "main",
    }),
  };
  return { read, analyze, service, ctx };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Ok = { status: "ok"; data: Record<string, unknown> };

test("range reads distinguish absent values from empty strings for lossless copying", async () => {
  const { service, ctx, read } = setup();
  try {
    expect((await workbookEditTool(service).execute({ path: "blank-qa.xlsx", create: true, sheetNames: ["数据"], ops: [
      { op: "cells.set", range: "数据!A1:C3", values: [["ID", "地区", "金额"], ["001", null, 0], ["002", "", 2]] },
    ] }, ctx)).status).toBe("ok");
    const result = await read.execute({ path: "blank-qa.xlsx", mode: "range", range: "A1:C3", facets: ["values"] }, ctx);
    expect((result.data as any).blankCells).toEqual(["B2"]);
    expect((result.data as any).values).toEqual([["ID", "地区", "金额"], ["001", "", 0], ["002", "", 2]]);
  } finally { await service.close(); }
});

test("split export ignores trailing formatting-only rows", async () => {
  const { service, ctx } = setup();
  try {
    expect((await workbookEditTool(service).execute({ path: "split-qa.xlsx", create: true, sheetNames: ["数据"], ops: [
      { op: "cells.set", range: "数据!A1:B3", values: [["ID", "金额"], ["001", 0], ["002", 2]] },
      { op: "style.set", range: "数据!A20", bold: true },
    ] }, ctx)).status).toBe("ok");
    const tool = workbookTools(service).find((t) => t.name === "workbook_export")!;
    const result = await tool.execute({ path: "split-qa.xlsx", to: "split-qa-out", mode: "split", rowsPerFile: 2, format: "csv", sheet: "数据" }, ctx);
    expect(result.status).toBe("ok");
    expect((result.data as any).files).toEqual(["split-qa-out/part-001.csv"]);
  } finally { await service.close(); }
});

test("sheet rename follows internal hyperlinks created earlier in the same batch", async () => {
  const { service, ctx, read } = setup();
  try {
    const result = await workbookEditTool(service).execute({ path: "sales.xlsx", ops: [
      { op: "sheet.add", name: "导航" },
      { op: "hyperlink.set", range: "导航!A1", url: "#销售!B2", label: "导航入口" },
      { op: "hyperlink.set", range: "销售!A2", url: "#销售!$B$2", label: "查看金额" },
      { op: "hyperlink.set", range: "销售!A3", url: "#'销售'!B3", label: "第二条" },
      { op: "hyperlink.set", range: "销售!A4", url: "https://example.com/#销售!B2", label: "外部" },
      { op: "sheet.rename", sheet: "销售", name: "历史 O'Brien" },
    ] }, ctx);
    expect(result.status).toBe("ok");
    const range = await read.execute({ path: "sales.xlsx", mode: "range", sheet: "历史 O'Brien", range: "A2:A4", facets: ["values", "layout"] }, ctx);
    expect((range.data as any).hyperlinks.map((x: any) => x.link.url)).toEqual([
      "#'历史 O''Brien'!$B$2", "#'历史 O''Brien'!B3", "https://example.com/#销售!B2",
    ]);
    expect((range.data as any).values).toEqual([["查看金额"], ["第二条"], ["外部"]]);
    await service.flushAll();
    const saved = importXlsx(readFileSync(join(ctx.workspaceRoot, "sales.xlsx")), "sales.xlsx").snapshot;
    const navigation = Object.values(saved.sheets).find((s) => s.name === "导航");
    expect(navigation?.cellData?.[0]?.[0]?.custom?.excelmanusHyperlink).toEqual({ url: "#'历史 O''Brien'!B2" });
    expect(navigation?.cellData?.[0]?.[0]?.v).toBe("导航入口");
  } finally { await service.close(); }
});

test("objects expose current notes before checkpoint without losing hyperlinks", async () => {
  const { service, ctx, read } = setup();
  try {
    const edited = await workbookEditTool(service).execute({ path: "sales.xlsx", ops: [
      { op: "note.set", sheet: "销售", ref: "B2", author: "QA", text: "金额待复核\n保留原始凭据" },
      { op: "hyperlink.set", range: "销售!A2", url: "#销售!B2", label: "查看金额" },
    ] }, ctx);
    expect(edited.status).toBe("ok");
    const result = await read.execute({ path: "sales.xlsx", mode: "objects" }, ctx);
    expect((result.data as any).objects.find((s: any) => s.sheet === "销售").notes).toEqual([
      { ref: "B2", author: "QA", text: "金额待复核\n保留原始凭据" },
    ]);
    const range = await read.execute({ path: "sales.xlsx", mode: "range", sheet: "销售", range: "A2:B2", facets: ["values", "layout"] }, ctx);
    expect((range.data as any).hyperlinks).toEqual([{ cell: "A2", link: { url: "#销售!B2" } }]);
  } finally { await service.close(); }
});

test.each(["utf-8", "utf-8-bom"] as const)(
  "CSV export reports byte-level %s encoding evidence",
  async (encoding) => {
    const { service, ctx } = setup();
    try {
      const tool = workbookTools(service).find((t) => t.name === "workbook_export")!;
      const result = await tool.execute(
        { path: "sales.xlsx", to: "encoding.csv", format: "csv", encoding, sheet: "销售" },
        ctx,
      );
      expect(result.status).toBe("ok");
      const bytes = readFileSync(join(ctx.workspaceRoot, "encoding.csv"));
      expect(result.data).toMatchObject({
        exports: [
          {
            path: "encoding.csv",
            format: "csv",
            encoding,
            bom: encoding === "utf-8-bom",
            sizeBytes: bytes.length,
          },
        ],
      });
      expect(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))).toBe(
        encoding === "utf-8-bom",
      );
    } finally {
      await service.close();
    }
  },
);

test("chart cache reads identify their saved revision before and after checkpoint", async () => {
  const { read, service, ctx } = setup();
  try {
    const made = await workbookEditTool(service).execute(
      {
        path: "cache-qa.xlsx",
        create: true,
        ops: [
          {
            op: "cells.set",
            range: "A1:B3",
            values: [
              ["项目", "金额"],
              ["甲", 10],
              ["乙", 20],
            ],
          },
          { op: "chart.add", sheet: "Sheet1", type: "column", title: "金额", range: "A1:B3" },
        ],
      },
      ctx,
    );
    expect(made.status).toBe("ok");
    const docId = (made.data as { docId: string }).docId;
    const initial = await read.execute({ docId, mode: "objects" }, ctx);
    expect(initial.data).toMatchObject({
      checkpointCharts: { source: "last_checkpoint", rev: 1, currentRev: 1, isCurrent: true },
    });
    const entry = await service.entry(docId, ctx.workspaceRoot);
    expect(
      await service.submit(docId, ctx.workspaceRoot, {
        baseRev: 1,
        source: { kind: "agent", id: "main" },
        sessionId: ctx.sessionId,
        ops: [{ op: "cells.set", range: "B2", values: [[30]] }],
      }),
    ).toMatchObject({ ok: true });
    clearTimeout(entry.timer);
    const pending = await read.execute({ docId, mode: "objects" }, ctx);
    expect(pending.data).toMatchObject({
      checkpointCharts: { rev: 1, currentRev: 2, isCurrent: false },
    });
    await service.checkpoint(docId, ctx.workspaceRoot);
    const saved = await read.execute({ docId, mode: "objects" }, ctx);
    expect(saved.data).toMatchObject({
      checkpointCharts: {
        rev: 2,
        currentRev: 2,
        isCurrent: true,
        charts: [
          {
            series: [
              {
                values: {
                  points: [
                    { index: 0, value: "30" },
                    { index: 1, value: "20" },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
  } finally {
    await service.close();
  }
});

describe("workbook 工具", () => {
  test("unknown sheet returns NOT_FOUND with actual names instead of an internal error", async () => {
    const {read, ctx}=setup();
    const result=await read.execute({path:"sales.xlsx",mode:"range",sheet:"Sheet1",range:"A1:B2"},ctx);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.error?.message).toContain("销售");
    expect(result.error?.message).toContain("参数");
    expect(result.error?.message).toContain("Sheet1");
  });
  test("overview：表名/行列数/隐藏表/公式计数", async () => {
    const { read, ctx } = setup();
    const r = (await read.execute({ path: "sales.xlsx", mode: "overview" }, ctx)) as Ok;
    expect(r.status).toBe("ok");
    const d = r.data;
    const sheets = d.sheets as { name: string; rows: number; cols: number; hidden: boolean }[];
    expect(sheets[0]?.name).toBe("销售");
    expect(sheets[0]?.rows).toBe(52);
    expect(sheets[0]?.cols).toBe(6);
    expect(sheets[0]?.hidden).toBe(false);
    expect(sheets[1]?.name).toBe("参数");
    expect(sheets[1]?.hidden).toBe(true);
    expect(d.docRevs).toEqual({ [d.docId as string]: 0 });
    expect((sheets[0] as unknown as { formulas: number }).formulas).toBe(50);
  });

  test("range：values/formulas/layout facet", async () => {
    const { read, ctx } = setup();
    const r = (await read.execute(
      {
        path: "sales.xlsx",
        mode: "range",
        range: "销售!A2:F4",
        facets: ["values", "formulas", "layout"],
      },
      ctx,
    )) as Ok;
    expect(r.status).toBe("ok");
    const d = r.data;
    const values = d.values as unknown[][];
    expect(values[0]).toEqual(["地区", "产品", "日期", "数量", "单价", "金额"]);
    const firstData = values[1] as unknown[];
    expect(typeof firstData[0]).toBe("string");
    expect(typeof firstData[3]).toBe("number");
    const formulas = d.formulas as (string | null)[][];
    // 数据第一行 F 列是 D*E 公式
    expect(formulas[1]?.[5]).toBe("=D3*E3");
    const layout = d.layout as {
      merges: { startRow: number; endRow: number }[];
      freeze: { ySplit: number };
    };
    expect(layout.freeze.ySplit).toBe(2);
    expect(d.truncated).toBe(false);
  });

  test("sql：按地区分组求和与 JS 计算一致", async () => {
    const { read, analyze, ctx } = setup();
    const opened = (await read.execute({ path: "sales.xlsx", mode: "overview" }, ctx)) as Ok;
    const docId = opened.data.docId as string;
    // 首行为表头 → 用区域 A2:F52
    const all = (await read.execute(
      { docId, mode: "range", range: "销售!A3:F52", facets: ["values"] },
      ctx,
    )) as Ok;
    const rows = all.data.values as unknown[][];
    const expectByRegion = new Map<string, number>();
    for (const row of rows) {
      const region = String(row[0]);
      const amount = Number(row[5]);
      expectByRegion.set(region, (expectByRegion.get(region) ?? 0) + amount);
    }
    const sql = (await analyze.execute(
      {
        docId,
        mode: "sql",
        range: "销售!A2:F52",
        sql: "SELECT 地区, SUM(金额) AS total, COUNT(*) AS n FROM data GROUP BY 地区 ORDER BY 地区",
      },
      ctx,
    )) as Ok;
    expect(sql.status).toBe("ok");
    const outRows = sql.data.rows as unknown[][];
    expect(outRows.length).toBe(expectByRegion.size);
    for (const row of outRows) {
      const region = String(row[0]);
      expect(Number(row[1])).toBeCloseTo(expectByRegion.get(region) ?? -1, 6);
      expect(Number(row[2])).toBeGreaterThan(0);
    }
    expect(sql.data.rowCount).toBe(expectByRegion.size);
  });

  test("sql：兼容 {{sheet}} 占位符", async () => {
    const { read, analyze, ctx } = setup();
    const opened = (await read.execute({ path: "sales.xlsx", mode: "overview" }, ctx)) as Ok;
    const r = (await analyze.execute(
      {
        docId: opened.data.docId,
        mode: "sql",
        sheet: "销售",
        range: "A2:F52",
        sql: "SELECT 地区, COUNT(*) AS 订单数, SUM(金额) AS 总金额 FROM {{sheet}} GROUP BY 地区 ORDER BY 总金额 DESC",
      },
      ctx,
    )) as Ok;
    expect(r.status).toBe("ok");
    expect(r.data.columns).toEqual(["地区", "订单数", "总金额"]);
    expect((r.data.rows as unknown[][])[0]).toEqual(["华北", 12, 761009]);
  });

  test("sql：允许 REPLACE 字符串清洗函数，仍拒绝替换写入语句", async () => {
    const { analyze, ctx } = setup();
    const r = (await analyze.execute(
      {
        path: "sales.xlsx",
        mode: "sql",
        range: "销售!A2:F52",
        sql: "WITH t AS (SELECT CAST(REPLACE ('12月','月','') AS INTEGER) AS month FROM data LIMIT 1) SELECT month FROM t",
      },
      ctx,
    )) as Ok;
    expect(r.status).toBe("ok");
    expect(r.data.rows).toEqual([[12]]);
    const write = await analyze.execute(
      {
        path: "sales.xlsx",
        mode: "sql",
        sql: "REPLACE INTO data VALUES (1)",
      },
      ctx,
    );
    expect(write.status).toBe("error");
  });

  test("sql：拒绝写操作", async () => {
    const { analyze, ctx } = setup();
    const r = await analyze.execute(
      { path: "sales.xlsx", mode: "sql", sql: "DROP TABLE data" },
      ctx,
    );
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error?.code).toBe("INVALID_ARGUMENT");
  });

  test("profile：列画像", async () => {
    const { analyze, ctx } = setup();
    const r = (await analyze.execute(
      { path: "sales.xlsx", mode: "profile", range: "销售!A2:F52" },
      ctx,
    )) as Ok;
    expect(r.status).toBe("ok");
    const cols = r.data.columns as { name: string; type: string; nonNull: number }[];
    expect(cols.map((c) => c.name)).toEqual(["地区", "产品", "日期", "数量", "单价", "金额"]);
    expect(cols[0]?.type).toBe("string");
    expect(cols[0]?.nonNull).toBe(50);
    expect(cols[3]?.type).toBe("number");
  });

  test("GBK CSV：中文解析正确", async () => {
    const { read, ctx } = setup();
    const r = (await read.execute({ path: "catalog-gbk.csv", mode: "overview" }, ctx)) as Ok;
    expect(r.status).toBe("ok");
    const range = (await read.execute(
      { docId: r.data.docId as string, mode: "range", range: "A1:C3", facets: ["values"] },
      ctx,
    )) as Ok;
    const values = range.data.values as unknown[][];
    expect(values[0]).toEqual(["名称", "类别", "单价"]);
    expect(values[1]?.[1]).toBe("硬件");
  });

  test("路径安全：越界路径被拒绝", async () => {
    const { read, ctx } = setup();
    const r = await read.execute({ path: "../escape.xlsx", mode: "overview" }, ctx);
    expect(r.status).toBe("error");
  });
});

test("SQL 跨文件 JOIN 记录全部读集，样式与规则可观察", async () => {
  const { read, analyze, ctx, service } = setup();
  try {
    cpSync(join(ctx.workspaceRoot, "sales.xlsx"), join(ctx.workspaceRoot, "other.xlsx"));
    const result = await analyze.execute(
      {
        path: "sales.xlsx",
        sheet: "销售",
        range: "A2:F52",
        mode: "sql",
        sources: [{ name: "other", path: "other.xlsx", sheet: "销售", range: "A2:F52" }],
        sql: "SELECT SUM(a.金额) AS total FROM data a JOIN other b ON a.地区=b.地区 WHERE a.产品=b.产品",
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data.docRevs as object)).toHaveLength(2);
    const styles = await read.execute(
      {
        path: "sales.xlsx",
        mode: "range",
        range: "销售!A2:F4",
        facets: ["styles", "rules", "layout"],
      },
      ctx,
    );
    expect(styles.status).toBe("ok");
    expect((styles.data as { styles: unknown[][] }).styles).toHaveLength(3);
    expect((styles.data as { coverage: Record<string, string> }).coverage.values).toBe(
      "not_requested",
    );
  } finally {
    await service.close();
  }
});

test("真实工作簿工具：结构化行、公式依赖、跨文件差异和九类校验", async () => {
  const { read, analyze, ctx, service } = setup();
  try {
    writeFileSync(
      join(ctx.workspaceRoot, "left.csv"),
      "id,label,amount,error\n1,A,10,\n2,A,20,\n3,,-1,#REF!\n",
    );
    writeFileSync(
      join(ctx.workspaceRoot, "right.csv"),
      "id,label,amount,error\n1,A,11,\n2,A,20,\n4,C,30,\n",
    );
    writeFileSync(join(ctx.workspaceRoot, "keys.csv"), "id\n1\n2\n");
    const table = await read.execute({ path: "left.csv", mode: "table", range: "A1:D4" }, ctx);
    expect(table.status).toBe("ok");
    expect((table.data as { rows: unknown[] }).rows).toHaveLength(3);
    const graph = await read.execute(
      { path: "sales.xlsx", mode: "formula_graph", range: "销售!F3", depth: 2 },
      ctx,
    );
    expect(graph.status, JSON.stringify(graph)).toBe("ok");
    expect(graph.data).toMatchObject({
      valueCoverage: { source: "current_snapshot", truncated: false },
      precedents: {
        items: [
          expect.objectContaining({
            cell: "'销售'!F3",
            formula: "=D3*E3",
            value: 2739,
            valueAvailable: true,
            references: [
              expect.objectContaining({
                text: "D3",
                cells: [expect.objectContaining({ cell: "'销售'!D3", value: 11 })],
              }),
              expect.objectContaining({
                text: "E3",
                cells: [expect.objectContaining({ cell: "'销售'!E3", value: 249 })],
              }),
            ],
          }),
        ],
      },
    });
    expect(
      (graph.data as { precedents: { items: { references: unknown[] }[] } }).precedents.items[0]
        ?.references,
    ).toHaveLength(2);
    const diff = await analyze.execute(
      { path: "left.csv", mode: "diff", keys: ["id"], right: { path: "right.csv" } },
      ctx,
    );
    expect(diff.status, JSON.stringify(diff)).toBe("ok");
    expect(diff.data).toMatchObject({ added: 1, deleted: 1, modified: 1 });
    const checks = await analyze.execute(
      {
        path: "left.csv",
        mode: "check",
        sources: [{ name: "keys", path: "keys.csv" }],
        checks: [
          { kind: "required", column: "label" },
          { kind: "unique", column: "label" },
          { kind: "range", column: "amount", min: 0, max: 30 },
          { kind: "pattern", column: "label", pattern: "^B$" },
          { kind: "foreign_key", column: "id", source: "keys", referenceColumn: "id" },
          { kind: "row_expression", expression: "amount>=0" },
          { kind: "cell", column: "amount", row: 1, expected: 10 },
          { kind: "total", column: "amount", expected: 29 },
          { kind: "formula_errors" },
        ],
      },
      ctx,
    );
    expect(checks.status, JSON.stringify(checks)).toBe("ok");
    const rules = (checks.data as { rules: { passed: boolean; failedCount: number }[] }).rules;
    expect(rules.map((r) => r.failedCount)).toEqual([1, 2, 1, 2, 1, 1, 0, 0, 1]);
  } finally {
    await service.close();
  }
});

test("图片对象通过实际工具新增、查询和视觉提取", async () => {
  const { read, ctx, service } = setup();
  try {
    const bytes = readFileSync(
      new URL("../../../../fixtures/skill-evals/image-source.png", import.meta.url),
    );
    writeFileSync(join(ctx.workspaceRoot, "source.png"), bytes);
    const edit = workbookTools(service).find((t) => t.name === "workbook_edit")!;
    const result = await edit.execute(
      {
        path: "sales.xlsx",
        ops: [{ op: "image.add", sheet: "销售", path: "source.png", anchor: "H2" }],
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    const listed = await read.execute({ path: "sales.xlsx", mode: "objects" }, ctx);
    const objects = (listed.data as { objects: { images: { id: string; data?: string }[] }[] })
      .objects;
    const image = objects.flatMap((o) => o.images)[0]!;
    expect(image.data).toBeUndefined();
    const extracted = await read.execute(
      { path: "sales.xlsx", mode: "objects", imageId: image.id },
      ctx,
    );
    expect(Buffer.from(extracted.images![0]!.data, "base64")).toEqual(bytes);
  } finally {
    await service.close();
  }
});

test("named creation and same-batch formula fill preserve relative and absolute references", async () => {
  const { service, ctx } = setup();
  const edit = workbookEditTool(service);
  const result = await edit.execute(
    {
      create: true,
      path: "named.xlsx",
      sheetNames: ["订单", "产品目录"],
      ops: [
        {
          op: "cells.set",
          range: "产品目录!A1:C3",
          values: [
            ["编码", "名称", "单价"],
            ["P1", "耳机", 299],
            ["P2", "台灯", 158],
          ],
        },
        {
          op: "cells.set",
          range: "订单!A1:D4",
          values: [
            ["编码", "数量", "单价", "金额"],
            ["P1", 5],
            ["P2", 8],
            ["P1", 2],
          ],
        },
        {
          op: "cells.set",
          range: "订单!C2:D2",
          values: [["=VLOOKUP(A2,产品目录!$A$2:$C$3,3,0)", "=B2*C2"]],
        },
        { op: "cells.fill", source: "订单!C2:D2", range: "订单!C3:D4", mode: "copy" },
      ],
    },
    ctx,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
  const opened = await service.open(ctx.workspaceId, ctx.workspaceRoot, "named.xlsx");
  const { snapshot } = await service.snapshot(opened.meta.id, ctx.workspaceRoot);
  expect(snapshot.sheetOrder.map((id) => snapshot.sheets[id]?.name)).toEqual(["订单", "产品目录"]);
  const cells = snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData!;
  expect(cells[3]?.[2]?.f).toBe("=VLOOKUP(A4,产品目录!$A$2:$C$3,3,0)");
  expect(cells[3]?.[3]?.f).toBe("=B4*C4");
  expect(cells[1]?.[3]?.v).toBe(1495);
  expect(cells[2]?.[3]?.v).toBe(1264);
  expect(cells[3]?.[3]?.v).toBe(598);
});

test("initial sheet names cannot silently rename an existing workbook", () => {
  expect(
    WorkbookEditInput.safeParse({
      path: "existing.xlsx",
      sheetNames: ["新表"],
      ops: [{ op: "recalculate" }],
    }).success,
  ).toBe(false);
});

test("named creation preview stays read-only and invalid names roll back", async () => {
  const { service, ctx } = setup();
  const edit = workbookEditTool(service);
  const preview = await edit.execute(
    { create: true, path: "preview.xlsx", sheetNames: ["收据", "核对"], ops: [], dryRun: true },
    ctx,
  );
  expect(preview).toMatchObject({ status: "ok" });
  expect(JSON.stringify(preview)).toContain("收据");
  expect(existsSync(join(ctx.workspaceRoot, "preview.xlsx"))).toBe(false);
  const rejected = await edit.execute(
    { create: true, path: "duplicate.xlsx", sheetNames: ["同名", "同名"], ops: [] },
    ctx,
  );
  expect(rejected.status).toBe("error");
  expect(existsSync(join(ctx.workspaceRoot, "duplicate.xlsx"))).toBe(false);
  const created = await edit.execute(
    { create: true, path: "duplicate.xlsx", sheetNames: ["收据"], ops: [] },
    ctx,
  );
  expect(created).toMatchObject({ status: "ok" });
  expect(
    (
      await edit.execute(
        { create: true, path: "duplicate.xlsx", sheetNames: ["替换"], ops: [] },
        ctx,
      )
    ).status,
  ).toBe("error");
});

test("range pagination coverage remains visible before verbose styles", async () => {
  const { read, ctx, service } = setup();
  try {
    const edited = await workbookEditTool(service).execute(
      {
        path: "sales.xlsx",
        ops: [
          {
            op: "style.set",
            range: "销售!A2:F52",
            bold: true,
            fontSize: 14,
            fontColor: "#123456",
            fill: "#abcdef",
            borders: {
              top: { style: "thin", color: "#123456" },
              bottom: { style: "thin", color: "#123456" },
              left: { style: "thin", color: "#123456" },
              right: { style: "thin", color: "#123456" },
            },
          },
        ],
      },
      ctx,
    );
    expect(edited.status, JSON.stringify(edited)).toBe("ok");
    const args = { path: "sales.xlsx", mode: "range", range: "销售!A2:F52" };
    const first = await read.execute({ ...args, facets: ["values", "styles"] }, ctx);
    expect(first.status).toBe("ok");
    const data = first.data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    const rows = data.values as unknown[][];
    expect(data.readWindow).toEqual({
      requestedRange: "'销售'!A2:F52",
      effectiveRange: "'销售'!A2:F52",
      clipped: false,
      offset: 0,
      returnedRows: rows.length,
      totalRows: 51,
      complete: false,
      returnedRange: `'销售'!A2:F${rows.length + 1}`,
      remainingRange: `'销售'!A${rows.length + 2}:F52`,
    });
    expect(data.nextOffset).toBe(rows.length);
    const capped = capToolOutput(first, 1);
    const preview = (capped.data as { preview: string }).preview;
    expect(preview).toContain('"readWindow":');
    expect(preview).toContain('"remainingRange":');
    expect(preview).toContain('"nextOffset":');
    const rest = await read.execute({ ...args, facets: ["values"], offset: data.nextOffset }, ctx);
    expect(rest.status).toBe("ok");
    const tail = rest.data as Record<string, unknown>;
    expect(tail.readWindow).toMatchObject({ complete: true, remainingRange: null });
    const full = await read.execute({ ...args, facets: ["values"] }, ctx);
    expect([...rows, ...(tail.values as unknown[][])]).toEqual(
      (full.data as Record<string, unknown>).values,
    );
  } finally {
    await service.close();
  }
});

test("advertised row-expression check rejects a wrong payment component despite equal reported nets", async () => {
  const { service, ctx, analyze } = setup();
  try {
    const schema = analyze.inputJsonSchema as any;
    const args = JSON.parse(schema.properties.checks.description.split("完整调用示例：")[1]);
    const edit = workbookEditTool(service);
    const made = await edit.execute(
      {
        path: args.path,
        create: true,
        sheetNames: ["月表"],
        ops: [
          {
            op: "cells.set",
            range: "月表!A1:E3",
            values: [
              ["月份", "订单分", "退款分", "回款分", "净变动分"],
              ["2026-07", 10000, 1000, 2000, 7000],
              ["2026-08", 20000, 1200, 5000, 13600],
            ],
          },
        ],
      },
      ctx,
    );
    expect(made.status).toBe("ok");
    const bad = await analyze.execute(args, ctx);
    expect(bad.status).toBe("ok");
    expect(bad.data).toMatchObject({
      passed: false,
      rules: [{ kind: "row_expression", passed: false, failedCount: 1, failures: [{ row: 2 }] }],
    });
    expect(
      (
        await edit.execute(
          {
            path: args.path,
            ops: [{ op: "cells.set", range: "月表!D3", values: [[5200]] }],
          },
          ctx,
        )
      ).status,
    ).toBe("ok");
    const good = await analyze.execute(args, ctx);
    expect(good.data).toMatchObject({ passed: true, rules: [{ failedCount: 0 }] });
    expect(good.data).not.toHaveProperty("wholeTaskVerified");
  } finally {
    await service.close();
  }
});

test("advertised source-alignment example executes unchanged on saved source and target files", async () => {
  const { service, ctx, analyze } = setup();
  try {
    const args = JSON.parse(
      (analyze.inputJsonSchema as any).properties.alignment.description.split("完整调用示例：")[1],
    );
    const edit = workbookEditTool(service);
    for (const [path, sheet, range, values] of [
      [
        args.sources[0].path,
        "原表",
        "原表!A1:B8",
        [
          ["地区", "客户ID"],
          [null, null],
          [null, null],
          [null, null],
          ["东区", "001"],
          [null, "001"],
          ["西区", "1"],
          [null, "002"],
        ],
      ],
      [
        args.path,
        "明细",
        "明细!A1:C3",
        [
          ["客户ID", "客户来源", "源行"],
          ["1", "原表!B7", 7],
          ["002", "原表!B8", 8],
        ],
      ],
    ] as const) {
      expect(
        (
          await edit.execute(
            {
              path,
              create: true,
              sheetNames: [sheet],
              ops: [{ op: "cells.set", range, values }],
            },
            ctx,
          )
        ).status,
      ).toBe("ok");
    }
    const before = readFileSync(join(ctx.workspaceRoot, args.sources[0].path));
    const result = await analyze.execute(args, ctx);
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({
      verification: { status: "verified", scope: "declared_fields_only", checkedCellCount: 2 },
    });
    expect(readFileSync(join(ctx.workspaceRoot, args.sources[0].path))).toEqual(before);
  } finally {
    await service.close();
  }
});
