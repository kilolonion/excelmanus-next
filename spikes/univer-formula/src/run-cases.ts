// A2-2a：150 个函数判据用例，P1（快照载入全量计算）与 P2（命令路径逐个写入）。
// 读取路径：workbook.save() 的 cellData —— 公式单元格 {f,v,t}，v=计算值。
// 等待计算结束：lib/calc.ts 的 notification stage8/0 + session resultApplied 双重确认。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IWorkbookData } from "@univerjs/core";
import { getSessionService, subscribeCalcDone } from "./lib/calc.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

interface Expect {
  t: "num" | "str" | "bool" | "err" | "numRange";
  v?: unknown;
  tol?: number;
  min?: number;
  max?: number;
  int?: boolean;
}
interface CaseDef {
  fn: string;
  formula: string;
  expect: Expect;
}

const casesJson = JSON.parse(readFileSync("cases.json", "utf8")) as {
  data: unknown[][];
  cases: CaseDef[];
  errorCases: Array<{ id: string; formula: string; expect: Expect }>;
};

const UNIT = "wb-cases";

function cellOf(v: unknown): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return { v };
  if (typeof v === "boolean") return { v, t: 3 };
  return { v: String(v) };
}

function buildSnapshot(withFormulas: boolean): IWorkbookData {
  const dataCell: Record<number, Record<number, Record<string, unknown>>> = {};
  casesJson.data.forEach((row, r) => {
    const rr: Record<number, Record<string, unknown>> = {};
    row.forEach((v, c) => {
      const cell = cellOf(v);
      if (cell) rr[c] = cell;
    });
    dataCell[r] = rr;
  });
  const casesCell: Record<number, Record<number, Record<string, unknown>>> = {};
  if (withFormulas) {
    casesJson.cases.forEach((c, i) => {
      casesCell[i] = { 0: { f: c.formula } };
    });
    casesJson.errorCases.forEach((c, i) => {
      casesCell[150 + i] = { 0: { f: c.formula } };
    });
  }
  return {
    id: UNIT,
    name: "cases",
    sheetOrder: ["data", "cases"],
    appVersion: "0.0.0",
    locale: "enUS" as never,
    styles: {},
    sheets: {
      data: {
        id: "data",
        name: "Data",
        rowCount: 20,
        columnCount: 15,
        cellData: dataCell,
      } as never,
      cases: {
        id: "cases",
        name: "Cases",
        rowCount: 200,
        columnCount: 5,
        cellData: casesCell,
      } as never,
    },
  } as unknown as IWorkbookData;
}

function readCell(save: () => IWorkbookData, row: number) {
  const snap = save();
  const cell = (
    snap.sheets?.cases as unknown as {
      cellData?: Record<number, Record<number, Record<string, unknown>>>;
    }
  )?.cellData?.[row]?.[0];
  return cell;
}

function classify(cell: Record<string, unknown> | undefined, expect: Expect) {
  if (!cell) return { pass: false, cls: "empty-cell", actual: null };
  const v = cell.v;
  const errText = typeof v === "string" && v.startsWith("#") ? v : null;
  if (expect.t === "err") {
    return errText === expect.v
      ? { pass: true, cls: "ok", actual: v }
      : { pass: false, cls: errText ? "错误文本不符" : "非错误值", actual: v };
  }
  if (errText) {
    return {
      pass: false,
      cls: errText === "#NAME?" ? "未实现" : "错误值",
      actual: v,
    };
  }
  switch (expect.t) {
    case "num": {
      const tol = expect.tol ?? 1e-9;
      const ok = typeof v === "number" && Math.abs(v - (expect.v as number)) <= tol;
      return { pass: ok, cls: ok ? "ok" : "值错误", actual: v };
    }
    case "numRange": {
      const ok =
        typeof v === "number" &&
        v >= (expect.min ?? Number.NEGATIVE_INFINITY) &&
        v < (expect.max ?? Number.POSITIVE_INFINITY) &&
        (!expect.int || Number.isInteger(v));
      return { pass: ok, cls: ok ? "ok" : "值错误", actual: v };
    }
    case "str":
      return { pass: v === expect.v, cls: v === expect.v ? "ok" : "值错误", actual: v };
    case "bool": {
      // Univer 布尔结果表示为 t=3（BOOLEAN）+ v∈{0,1}；也接受原生 boolean
      const b = cell.t === 3 && (v === 0 || v === 1) ? v === 1 : v;
      return { pass: b === expect.v, cls: b === expect.v ? "ok" : "值错误", actual: v, t: cell.t };
    }
  }
  return { pass: false, cls: "未知期望类型", actual: v };
}

async function runP1() {
  const boot = bootUniver();
  const waiter = subscribeCalcDone(boot, 60000);
  const book = createBook(boot, buildSnapshot(true));
  const w = await waiter.promise;
  // 再确认 session 终态（防止 notification 与写回之间的竞态）
  const session = getSessionService(boot);
  const res = casesJson.cases.map((c, i) => ({
    i,
    fn: c.fn,
    formula: c.formula,
    ...classify(
      readCell(() => book.save() as IWorkbookData, i),
      c.expect,
    ),
  }));
  const errs = casesJson.errorCases.map((c, i) => ({
    id: c.id,
    formula: c.formula,
    ...classify(
      readCell(() => book.save() as IWorkbookData, 150 + i),
      c.expect,
    ),
  }));
  const st = session.state;
  await boot.dispose();
  return { wait: w, sessionState: st, res, errs };
}

async function runP2() {
  const boot = bootUniver();
  const book = createBook(boot, buildSnapshot(false));
  // 载入后先等一轮初始计算 settle
  const w0 = subscribeCalcDone(boot, 60000);
  await w0.promise;
  const res = [];
  const waits: string[] = [];
  for (const [i, c] of casesJson.cases.entries()) {
    const w = subscribeCalcDone(boot, 30000);
    const ok = await boot.commandService.executeCommand("sheet.command.set-range-values", {
      unitId: UNIT,
      subUnitId: "cases",
      range: { startRow: i, startColumn: 0, endRow: i, endColumn: 0 },
      value: { f: c.formula },
    });
    const wr = await w.promise;
    if (wr.outcome === "timeout") waits.push(`case${i} ${c.fn} timeout`);
    const cell = readCell(() => book.save() as IWorkbookData, i);
    res.push({
      i,
      fn: c.fn,
      formula: c.formula,
      ok,
      wait: wr.outcome,
      ...classify(cell, c.expect),
    });
  }
  const errs = [];
  for (const [i, c] of casesJson.errorCases.entries()) {
    const w = subscribeCalcDone(boot, 30000);
    await boot.commandService.executeCommand("sheet.command.set-range-values", {
      unitId: UNIT,
      subUnitId: "cases",
      range: { startRow: 150 + i, startColumn: 0, endRow: 150 + i, endColumn: 0 },
      value: { f: c.formula },
    });
    await w.promise;
    const cell = readCell(() => book.save() as IWorkbookData, 150 + i);
    errs.push({ id: c.id, formula: c.formula, ...classify(cell, c.expect) });
  }
  await boot.dispose();
  return { waits, res, errs };
}

async function main() {
  console.log("P1: 快照载入全量计算");
  const p1 = await runP1();
  const p1Pass = p1.res.filter((r) => r.pass).length;
  console.log(
    `P1 ${p1Pass}/150 wait=${p1.wait.outcome}(${p1.wait.ms.toFixed(0)}ms) session=${JSON.stringify(p1.sessionState)}`,
  );
  console.log("P2: 命令路径逐个写入");
  const p2 = await runP2();
  const p2Pass = p2.res.filter((r) => r.pass).length;
  console.log(`P2 ${p2Pass}/150 waits=${p2.waits.length}`);
  const byType = (rs: Array<{ pass: boolean; fn: string }>, exps: Expect[]) => {
    const m: Record<string, { pass: number; total: number }> = {};
    rs.forEach((r, i) => {
      const t = exps[i]?.t ?? "?";
      let mm = m[t];
      if (!mm) {
        mm = { pass: 0, total: 0 };
        m[t] = mm;
      }
      mm.total += 1;
      if (r.pass) mm.pass += 1;
    });
    return m;
  };
  const result = {
    meta: { test: "A2-2a-cases", node: process.version, ts: new Date().toISOString() },
    p1: {
      pass: p1Pass,
      total: 150,
      wait: p1.wait,
      sessionState: p1.sessionState,
      byType: byType(
        p1.res,
        casesJson.cases.map((c) => c.expect),
      ),
      results: p1.res,
      errorCases: p1.errs,
    },
    p2: {
      pass: p2Pass,
      total: 150,
      waits: p2.waits,
      byType: byType(
        p2.res,
        casesJson.cases.map((c) => c.expect),
      ),
      results: p2.res,
      errorCases: p2.errs,
    },
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/cases.json", JSON.stringify(result, null, 2));
  const failP1 = p1.res.filter((r) => !r.pass);
  const failP2 = p2.res.filter((r) => !r.pass);
  console.log(
    "P1 fails:",
    failP1.map((r) => `${r.fn}(${r.cls}:${JSON.stringify(r.actual)})`).join(" | ") || "none",
  );
  console.log(
    "P2 fails:",
    failP2.map((r) => `${r.fn}(${r.cls}:${JSON.stringify(r.actual)})`).join(" | ") || "none",
  );
  console.log("P1 errCases:", JSON.stringify(p1.errs));
  console.log("P2 errCases:", JSON.stringify(p2.errs));
  process.exit(0);
}

await main();
