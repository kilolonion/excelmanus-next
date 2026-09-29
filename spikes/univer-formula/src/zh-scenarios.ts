// A2-2a 中文场景：
//  (i) 工作表名 销售数据：=销售数据!A1*2 → 10；='销售数据'!A1+1 → 6
//  (ii) 定义名 税率=0.13（formula.mutation.set-defined-name）：=销售数据!A1*税率 → 0.65
//  (iii) zh-CN locale 下中文函数名 =求和(Data!A1:A10) → 期望 55（测引擎是否接受本地化函数名）
//  (iv) 全角标点/中文字符串：=LEN("你好，世界") → 5

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IWorkbookData } from "@univerjs/core";
import { UniverSheetsNodeCorePreset } from "@univerjs/preset-sheets-node-core";
import sheetsNodeCoreEnUS from "@univerjs/preset-sheets-node-core/locales/en-US";
import sheetsNodeCoreZhCN from "@univerjs/preset-sheets-node-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { subscribeCalcDone } from "./lib/calc.ts";
import type { Booted } from "./lib/univer-node.ts";
import { bootUniver } from "./lib/univer-node.ts";

const UNIT = "wb-zh";

function snap(): IWorkbookData {
  return {
    id: UNIT,
    name: "zh",
    sheetOrder: ["sales", "data", "out"],
    appVersion: "0.0.0",
    styles: {},
    sheets: {
      sales: {
        id: "sales",
        name: "销售数据",
        rowCount: 20,
        columnCount: 10,
        cellData: { 0: { 0: { v: 5 } } },
      },
      data: {
        id: "data",
        name: "Data",
        rowCount: 20,
        columnCount: 10,
        cellData: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [i, { 0: { v: i + 1 } }]),
        ),
      },
      out: {
        id: "out",
        name: "Out",
        rowCount: 20,
        columnCount: 5,
        cellData: {},
      },
    },
  } as unknown as IWorkbookData;
}

async function writeAndRead(
  boot: Booted,
  book: { save(): IWorkbookData },
  row: number,
  formula: string,
) {
  const w = subscribeCalcDone(boot, 15000);
  const ok = await boot.commandService.executeCommand("sheet.command.set-range-values", {
    unitId: UNIT,
    subUnitId: "out",
    range: { startRow: row, startColumn: 0, endRow: row, endColumn: 0 },
    value: { f: formula },
  });
  const wr = await w.promise;
  const cell = (
    (book.save() as IWorkbookData).sheets?.out as unknown as {
      cellData?: Record<number, Record<number, Record<string, unknown>>>;
    }
  )?.cellData?.[row]?.[0];
  // ok = 命令成功；值判定在调用方按 expect 做（数值 tol 1e-9，其余全等）
  return { ok, wait: wr.outcome, v: cell?.v, f: cell?.f };
}

async function main() {
  // en-US 实例：i/ii/iv；zh-CN 实例：iii（locale 变更仅影响显示层行为，亦验证）
  const boot = bootUniver();
  const book = boot.univerAPI.createWorkbook(snap());
  const save = () => book.save() as IWorkbookData;
  const results: Record<string, unknown> = {};

  const w0 = subscribeCalcDone(boot, 15000);
  await w0.promise;

  results.s1a = {
    formula: "=销售数据!A1*2",
    expect: 10,
    ...(await writeAndRead(boot, { save }, 0, "=销售数据!A1*2")),
  };
  results.s1b = {
    formula: "='销售数据'!A1+1",
    expect: 6,
    ...(await writeAndRead(boot, { save }, 1, "='销售数据'!A1+1")),
  };

  // (ii) 定义名 税率=0.13
  const okDn = await boot.commandService.executeCommand("formula.mutation.set-defined-name", {
    id: "dn-tax",
    unitId: UNIT,
    name: "税率",
    formulaOrRefString: "0.13",
  });
  const r2 = await writeAndRead(boot, { save }, 2, "=销售数据!A1*税率");
  results.s2 = { formula: "=销售数据!A1*税率", expect: 0.65, definedNameCmdOk: okDn, ...r2 };

  // (iv) 中文字符串/全角标点
  results.s4 = {
    formula: '=LEN("你好，世界")',
    expect: 5,
    ...(await writeAndRead(boot, { save }, 3, '=LEN("你好，世界")')),
  };

  await boot.dispose();

  // (iii) zh-CN locale + 中文函数名
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(sheetsNodeCoreZhCN),
      [LocaleType.EN_US]: mergeLocales(sheetsNodeCoreEnUS),
    },
    presets: [UniverSheetsNodeCorePreset()],
  });
  const injector = univer.__getInjector();
  const { ICommandService } = await import("@univerjs/core");
  const cs = injector.get(ICommandService);
  const boot2: Booted = {
    univer,
    univerAPI,
    injector,
    commandService: {
      executeCommand: (id, params, options) =>
        cs.executeCommand(id as string, params as object, options as never) as Promise<boolean>,
      onCommandExecuted: (cb) => cs.onCommandExecuted(cb),
      hasCommand: (id) => cs.hasCommand(id),
    },
    undoRedo: null as never,
    dispose: async () => {
      try {
        await univer.dispose();
      } catch {
        /* ignore */
      }
    },
  };
  const book2 = boot2.univerAPI.createWorkbook(snap());
  const save2 = () => book2.save() as IWorkbookData;
  const wz = subscribeCalcDone(boot2, 15000);
  await wz.promise;
  results.s3_zhFn = {
    formula: "=求和(Data!A1:A10)",
    expect: 55,
    ...(await writeAndRead(boot2, { save: save2 }, 0, "=求和(Data!A1:A10)")),
  };
  // 对照：同实例下英文函数名
  results.s3_enFnInZh = {
    formula: "=SUM(Data!A1:A10)",
    expect: 55,
    ...(await writeAndRead(boot2, { save: save2 }, 1, "=SUM(Data!A1:A10)")),
  };
  await boot2.dispose();

  for (const [k, v] of Object.entries(results)) {
    const r = v as {
      expect: unknown;
      v: unknown;
      ok?: boolean;
      wait?: string;
      definedNameCmdOk?: boolean;
      valueOk?: boolean;
    };
    r.valueOk =
      typeof r.expect === "number"
        ? typeof r.v === "number" && Math.abs(r.v - r.expect) < 1e-9
        : r.v === r.expect;
    console.log(`${r.valueOk ? "PASS" : "FAIL"} ${k}: ${JSON.stringify(v)}`);
  }
  const out = { meta: { test: "A2-zh", ts: new Date().toISOString() }, results };
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/zh.json", JSON.stringify(out, null, 2));
  process.exit(0);
}

await main();
