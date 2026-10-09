// 只读活文档真实边界测试（07 §3、06 §4.1–4.2）：
// 真实 samples/sales.xlsx 与 GBK CSV 落盘工作区，经 DocumentService + 工具实参直跑。

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "@excelmanus/kernel";
import { BACKUPS_MIGRATION, BackupService, createReadTable, openDb } from "@excelmanus/kernel";
import { afterAll, describe, expect, test } from "vitest";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
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
