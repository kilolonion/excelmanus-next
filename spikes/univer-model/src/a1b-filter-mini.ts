// A1b-1b 最小对照：手工构造"表内有筛选区 + 隐藏行"的工作表，
// A 上执行结构命令，把发出的 mutation 以不同方式在 B 复现，比较 filter 资源。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IConfigService, IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { attachRecorder, mutationList } from "./lib/ops.ts";
import { type Booted, bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const KEY = "sheets-filter.config";

function disposeUnit(boot: Booted, unitId: string) {
  try {
    const svc = (boot.injector as { get(t: unknown): { disposeUnit(id: string): boolean } }).get(
      IUniverInstanceService,
    );
    svc.disposeUnit(unitId);
  } catch {
    /* tolerate */
  }
}

// 场景构造：s1 有 60 行数据；在 r10..r50 建筛选；隐藏 r55..r58（模拟前置状态）；
// 再写 r51..r60 数据在筛选区下方（触发 extend 逻辑的场景）。
async function buildScenario(boot: Booted, unitId: string) {
  const cellData: Record<string, Record<string, { v: number }>> = {};
  for (let r = 0; r < 60; r++) {
    const row: Record<string, { v: number }> = {};
    for (let c = 0; c < 12; c++) row[String(c)] = { v: r * 100 + c };
    cellData[String(r)] = row;
  }
  const snapshot = {
    id: unitId,
    name: "wb",
    appVersion: "0",
    locale: "zhCN",
    styles: {},
    sheetOrder: ["s1"],
    sheets: {
      s1: {
        id: "s1",
        name: "s1",
        rowCount: 100,
        columnCount: 12,
        cellData,
        rowData: {
          "55": { hd: 1, h: 21 },
          "56": { hd: 1, h: 21 },
          "57": { hd: 1, h: 21 },
          "58": { hd: 1, h: 21 },
        },
        columnData: {},
        defaultColumnWidth: 88,
        defaultRowHeight: 24,
        mergeData: [],
        tabColor: "",
        hidden: 0,
        freeze: { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 },
        showGridlines: 1,
        selections: [],
      },
    },
    resources: [],
  } as unknown as IWorkbookData;
  const book = createBook(boot, snapshot);
  // 设置筛选区 r10..r50,c2..c8
  await boot.commandService.executeCommand("sheet.command.set-filter-range", {
    unitId,
    subUnitId: "s1",
    range: { startRow: 10, startColumn: 2, endRow: 50, endColumn: 8 },
  });
  return book;
}

interface Step {
  name: string;
  commandId: string;
  params: (unitId: string) => Record<string, unknown>;
}

const STEPS: Step[] = [
  {
    name: "remove-rows-inside-filter",
    commandId: "sheet.command.remove-row-by-range",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 20, endRow: 23, startColumn: 0, endColumn: 11 },
    }),
  },
  {
    name: "remove-rows-after-filter",
    commandId: "sheet.command.remove-row-by-range",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 52, endRow: 55, startColumn: 0, endColumn: 11 },
    }),
  },
  {
    name: "insert-rows-inside-filter",
    commandId: "sheet.command.insert-row-by-range",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 30, endRow: 31, startColumn: 0, endColumn: 11 },
    }),
  },
  {
    name: "remove-cols-inside-filter",
    commandId: "sheet.command.remove-col-by-range",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 0, startColumn: 4, endRow: 99, endColumn: 5 },
    }),
  },
  {
    name: "insert-cols-inside-filter",
    commandId: "sheet.command.insert-col-by-range",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 0, startColumn: 4, endRow: 99, endColumn: 5 },
    }),
  },
  {
    name: "write-below-filter",
    commandId: "sheet.command.set-range-values",
    params: (u) => ({
      unitId: u,
      subUnitId: "s1",
      range: { startRow: 51, startColumn: 3, endRow: 52, endColumn: 5 },
      value: { v: 7 },
    }),
  },
];

type Mode = "collab" | "plain" | "syncoff";

async function runMode(mode: Mode, unitId: string) {
  const boot = bootUniver();
  if (mode === "syncoff") {
    const cfg = (
      boot.injector as { get(t: unknown): { setConfig(k: string, v: unknown): void } }
    ).get(IConfigService);
    cfg.setConfig(KEY, { enableSyncSwitch: { defaultValue: false } });
  }
  const book = await buildScenario(boot, unitId);
  return { boot, book };
}

async function main() {
  const unitId = "wb-a1b-mini";
  const results: Array<Record<string, unknown>> = [];

  for (const step of STEPS) {
    // A 端
    const bootA = bootUniver();
    attachRecorder(bootA);
    const bookA = await buildScenario(bootA, unitId);
    const before = JSON.stringify(mutationList.map((m) => m.id));
    mutationList.length = 0;
    const okA = await bootA.commandService.executeCommand(step.commandId, step.params(unitId));
    const emitted = JSON.parse(JSON.stringify(mutationList)) as CapturedMutation[];
    const aSnap = normalizeSnapshot(bookA.save());
    const aFilter = ((bookA.save().resources ?? []) as Array<{ name: string; data: string }>).find(
      (r) => r.name === "SHEET_FILTER_PLUGIN",
    )?.data;

    const perMode: Record<string, { diffs: number; filterB?: string; threw?: string }> = {};
    for (const mode of ["collab", "plain", "syncoff"] as Mode[]) {
      const { boot, book } = await runMode(mode, unitId);
      let threw: string | undefined;
      for (const m of emitted) {
        try {
          const opts = mode === "collab" || mode === "syncoff" ? { fromCollab: true } : undefined;
          await boot.commandService.executeCommand(
            m.id,
            JSON.parse(JSON.stringify(m.params)),
            opts,
          );
        } catch (e) {
          threw = (e as Error).message;
        }
      }
      const diffs = deepDiff(aSnap, normalizeSnapshot(book.save()), [], []);
      const fb = ((book.save().resources ?? []) as Array<{ name: string; data: string }>).find(
        (r) => r.name === "SHEET_FILTER_PLUGIN",
      )?.data;
      perMode[mode] = { diffs: diffs.length, filterB: fb, threw };
      disposeUnit(boot, unitId);
      await boot.dispose();
    }
    results.push({
      step: step.name,
      okA,
      emittedIds: emitted.map((m) => m.id),
      emittedParams: emitted.map((m) => ({ id: m.id, params: m.params })),
      filterA: aFilter,
      emittedBeforeCleared: before,
      perMode: Object.fromEntries(
        Object.entries(perMode).map(([k, v]) => [
          k,
          { diffs: v.diffs, filterB: v.filterB, threw: v.threw },
        ]),
      ),
    });
    console.log(
      `${step.name}: ok=${okA} emitted=[${emitted.map((m) => m.id).join(",")}] ` +
        Object.entries(perMode)
          .map(([k, v]) => `${k}=${v.diffs}${v.threw ? `(${v.threw.slice(0, 40)})` : ""}`)
          .join(" "),
    );
    disposeUnit(bootA, unitId);
    await bootA.dispose();
    mutationList.length = 0;
  }

  if (!existsSync("results")) mkdirSync("results");
  writeFileSync("results/a1b-filter-mini.json", JSON.stringify({ results }, null, 2));
  process.exit(0);
}

await main();
