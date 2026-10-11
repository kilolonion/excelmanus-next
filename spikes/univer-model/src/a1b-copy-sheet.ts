// A1b-1a：copy-sheet 缺 styles 的两种修补方案对照。
// 场景：s1 单元格带 3 种样式 → copy-sheet → 取 insert-sheet mutation：
//   raw           —— 原样复现（基线，预期悬空）
//   styles-subset —— params.styles 补子集
//   inline        —— sheet 内 .s 展开成对象
// 量化：payload 增量、B 端 diff 数、悬空引用数、以及"后续引用 A 样式表的
// mutation（在拷贝表上写 s=某 A 样式 id）在两种策略下是否仍悬空"。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { IUniverInstanceService, type IWorkbookData } from "@univerjs/core";
import { deepDiff, normalizeSnapshot } from "./lib/compare.ts";
import { attachRecorder, mutationList } from "./lib/ops.ts";
import { findDanglingStyleRefs, fixupMutationForTransport } from "./lib/transport.ts";
import { type Booted, bootUniver, createBook } from "./lib/univer-node.ts";

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

async function buildStyledBook(boot: Booted, unitId: string) {
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
        rowCount: 50,
        columnCount: 10,
        cellData: {},
        rowData: {},
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
  // 3 种不同样式写到不同行
  const stylesToApply = [
    { range: { startRow: 0, startColumn: 0, endRow: 5, endColumn: 4 }, style: { bl: 1, fs: 14 } },
    {
      range: { startRow: 6, startColumn: 0, endRow: 11, endColumn: 4 },
      style: { bg: { rgb: "#e8e8e8" } },
    },
    {
      range: { startRow: 12, startColumn: 0, endRow: 17, endColumn: 4 },
      style: { n: { pattern: "0.00" }, it: 1 },
    },
  ];
  for (const { range, style } of stylesToApply) {
    await boot.commandService.executeCommand("sheet.command.set-style", {
      unitId,
      subUnitId: "s1",
      range,
      style: { type: Object.keys(style)[0], value: Object.values(style)[0] },
    });
  }
  return book;
}

async function main() {
  const unitId = "wb-a1b-copy";
  const results: Record<string, unknown> = {};

  // A：建带样式的表 → copy-sheet → 捕获 insert-sheet mutation
  const bootA = bootUniver();
  attachRecorder(bootA);
  const bookA = await buildStyledBook(bootA, unitId);
  mutationList.length = 0;
  const okCopy = await bootA.commandService.executeCommand("sheet.command.copy-sheet", {
    unitId,
    subUnitId: "s1",
  });
  const copyMutations = JSON.parse(JSON.stringify(mutationList));
  mutationList.length = 0;
  const insertSheet = copyMutations.find(
    (m: { id: string }) => m.id === "sheet.mutation.insert-sheet",
  );
  const newSheetId = (insertSheet?.params as { sheet?: { id?: string } })?.sheet?.id;
  const senderSnap = bookA.save() as { styles?: Record<string, unknown> };
  const aSnap = normalizeSnapshot(bookA.save());
  const rawBytes = JSON.stringify(insertSheet?.params ?? {}).length;
  console.log(
    `copy ok=${okCopy} mutations=[${copyMutations.map((m: { id: string }) => m.id).join(",")}] newSheet=${newSheetId} rawBytes=${rawBytes}`,
  );

  const strategies = ["raw", "styles-subset", "inline"] as const;
  for (const st of strategies) {
    const bootB = bootUniver();
    createBook(
      bootB,
      JSON.parse(JSON.stringify(bookA.save().sheets ? bookA.save() : {})) as IWorkbookData,
    );
    // B 从 A 复制前快照启动（重建：直接再 buildStyledBook）
    disposeUnit(bootB, unitId);
    const bootB2 = bootUniver();
    const bookB2 = await buildStyledBook(bootB2, unitId);
    // 重放 copy 段 mutation
    let addedBytes = 0;
    for (const m of copyMutations) {
      const fixed =
        st === "raw"
          ? { mutation: m, fixups: [], addedBytes: 0 }
          : fixupMutationForTransport(m, senderSnap, st);
      addedBytes += fixed.addedBytes;
      await bootB2.commandService.executeCommand(
        fixed.mutation.id,
        JSON.parse(JSON.stringify(fixed.mutation.params)),
        { fromCollab: true },
      );
    }
    const bSnap = bookB2.save() as Parameters<typeof findDanglingStyleRefs>[0];
    const diffs = deepDiff(aSnap, normalizeSnapshot(bookB2.save()), [], []);
    const dangling = findDanglingStyleRefs(bSnap);
    // 后续 mutation 兼容性测试：在拷贝表上写 s=<A 样式表中某 id>
    const someStyleId = Object.keys(senderSnap.styles ?? {})[0];
    let postDangle = -1;
    if (someStyleId && newSheetId) {
      await bootB2.commandService.executeCommand(
        "sheet.mutation.set-range-values",
        {
          unitId,
          subUnitId: newSheetId,
          cellValue: { "0": { "0": { s: someStyleId, v: 1 } } },
        },
        { fromCollab: true },
      );
      postDangle = findDanglingStyleRefs(
        bookB2.save() as { styles?: Record<string, unknown> },
      ).length;
    }
    results[st] = {
      addedBytes,
      diffs: diffs.length,
      diffSample: diffs.slice(0, 5).map((d) => d.path),
      danglingAfterReplay: dangling.length,
      danglingAfterPostMutation: postDangle,
      stylesCountB: Object.keys(bSnap.styles ?? {}).length,
    };
    console.log(
      `${st}: diffs=${diffs.length} dangling=${dangling.length} postMutationDangle=${postDangle} stylesB=${results[st] && (results[st] as { stylesCountB: number }).stylesCountB}`,
    );
    disposeUnit(bootB2, unitId);
    await bootB2.dispose();
    await bootB.dispose();
  }

  disposeUnit(bootA, unitId);
  await bootA.dispose();
  if (!existsSync("results")) mkdirSync("results");
  writeFileSync(
    "results/a1b-copy-sheet.json",
    JSON.stringify({ okCopy, rawBytes, newSheetId, results }, null, 2),
  );
  process.exit(0);
}

await main();
