// 只读活文档真实边界测试（07 §3、06 §4.1–4.2）：
// 真实 samples/sales.xlsx 与 GBK CSV 落盘工作区，经 DocumentService + 工具实参直跑。

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "@excelmanus/kernel";
import { BACKUPS_MIGRATION, BackupService, createReadTable, openDb } from "@excelmanus/kernel";
import { afterAll, describe, expect, test } from "vitest";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";

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

describe("workbook 工具", () => {
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
