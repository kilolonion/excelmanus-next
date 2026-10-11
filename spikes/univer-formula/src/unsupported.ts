// A2-2a 不支持函数可检测性：
//  - IFunctionService.hasExecutor(token) / getExecutors() 查函数是否已注册执行器
//  - 函数名抽取用引擎自带 LexerTreeBuilder.sequenceNodesBuilder（nodeType===3 FUNCTION），
//    并与一个朴素正则基线对比一致性。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IWorkbookData } from "@univerjs/core";
import {
  FUNCTION_NAMES_ARRAY,
  IFunctionService,
  LexerTreeBuilder,
  sequenceNodeType,
} from "@univerjs/engine-formula";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const TEST_FUNCS = [
  "LAMBDA",
  "LET",
  "MAP",
  "REDUCE",
  "SCAN",
  "BYROW",
  "BYCOL",
  "MAKEARRAY",
  "TEXTSPLIT",
  "TEXTBEFORE",
  "TEXTAFTER",
  "VSTACK",
  "HSTACK",
  "TAKE",
  "DROP",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "TOCOL",
  "TOROW",
  "WRAPROWS",
  "GROUPBY",
  "PIVOTBY",
  "XIRR",
  "XNPV",
  "CELL",
  "INFO",
  "FORMULATEXT",
  "GETPIVOTDATA",
  "WEBSERVICE",
  "STOCKHISTORY",
  "CUBEVALUE",
  "ISFORMULA",
  "SHEET",
  "SHEETS",
  "REGEXTEST",
  "REGEXEXTRACT",
  "REGEXREPLACE",
  "IMAGE",
  "STDEV.P",
  "VAR.P",
  "PERCENTILE.INC",
  "RANK.EQ",
  "MODE.SNGL",
  "COUNTIFS",
  "DSUM",
  "DGET",
  "FORECAST.LINEAR",
  "TREND",
  "LINEST",
  "SUMSQ",
  "SUMX2MY2",
  "CONVERT",
  "BASE",
  "DECIMAL",
  "ROMAN",
  "ARABIC",
];

interface FnSvc {
  hasExecutor(t: string): boolean;
  getExecutors(): Map<string, unknown>;
}

function lexerFns(tree: LexerTreeBuilder, formula: string): string[] {
  const nodes = tree.sequenceNodesBuilder(formula) as Array<{
    token?: string;
    nodeType?: number;
    endIndex?: number;
  }> | null;
  const out: string[] = [];
  if (!nodes) return out;
  for (const n of nodes) {
    if (n.nodeType === sequenceNodeType.FUNCTION && n.token) {
      out.push(n.token.trim().toUpperCase());
    }
  }
  return out;
}

function regexFns(formula: string): string[] {
  // 朴素基线：标识符(可含. )紧跟 "("，排除单元格引用形态（字母+数字）
  const out = new Set<string>();
  const re = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;
  let m = re.exec(formula);
  while (m !== null) {
    const name = m[1] ?? "";
    if (!/\d$/.test(name)) out.add(name.toUpperCase());
    m = re.exec(formula);
  }
  return [...out];
}

async function main() {
  const boot = bootUniver();
  // 函数执行器在单元（workbook）创建时由 FormulaController 注册——先建册再查
  createBook(boot, {
    id: "wb-uns",
    name: "x",
    sheetOrder: ["s1"],
    appVersion: "0",
    styles: {},
    sheets: { s1: { id: "s1", name: "S", rowCount: 10, columnCount: 10, cellData: {} } },
  } as unknown as IWorkbookData);
  const fn = (boot.injector as { get(t: unknown): unknown }).get(IFunctionService) as FnSvc;
  const tree = (boot.injector as { get(t: unknown): unknown }).get(
    LexerTreeBuilder,
  ) as LexerTreeBuilder;
  const executors = fn.getExecutors();
  const registered: string[] = [];
  const unregistered: string[] = [];
  for (const f of TEST_FUNCS) (fn.hasExecutor(f) ? registered : unregistered).push(f);

  // findUnsupportedFunctions 验证：lexer 抽取 vs 正则基线
  const probeFormulas = [
    '=SUM(Data!A1:A10)+NOSUCH(1)+IF(A1>0,TEXTJOIN(",",1,"a"),XLOOKUP(1,B:B,C:C))',
    "=STDEV.P(Data!A1:A10)/POWER(2,3)",
    '="no func" & CONCAT("x")',
    "=SUMSQ(A1:B2)*MAP",
  ];
  const probes = probeFormulas.map((f) => {
    const lex = lexerFns(tree, f);
    const rx = regexFns(f);
    return {
      formula: f,
      lexerFns: lex,
      regexFns: rx,
      unsupportedViaLexer: lex.filter((x) => !fn.hasExecutor(x)),
      unsupportedViaRegex: rx.filter((x) => !fn.hasExecutor(x)),
      equal: JSON.stringify([...lex].sort()) === JSON.stringify([...rx].sort()),
    };
  });

  const out = {
    meta: { test: "A2-unsupported", node: process.version },
    registeredOfList: `${registered.length}/${TEST_FUNCS.length}`,
    registered,
    unregistered,
    totalRegisteredNames: executors.size,
    functionNamesArrayLen: Object.keys(FUNCTION_NAMES_ARRAY).length,
    probes,
  };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/unsupported.json", JSON.stringify(out, null, 2));
  console.log(
    `注册 ${out.registeredOfList}；引擎总注册名=${executors.size}（FUNCTION_NAMES_ARRAY=${Object.keys(FUNCTION_NAMES_ARRAY).length}）`,
  );
  console.log(`未注册: ${unregistered.join(", ")}`);
  for (const p of probes)
    console.log(
      `probe equal=${p.equal} lexer=[${p.lexerFns.join(",")}] unsupported=[${p.unsupportedViaLexer.join(",")}]`,
    );
  await boot.dispose();
  process.exit(0);
}

await main();
