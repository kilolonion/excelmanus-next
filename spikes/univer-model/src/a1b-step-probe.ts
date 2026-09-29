// A1b-1b 精确定位：seq388 首个发散操作（op31 remove-rows）逐步对照。
// A、B 同步重放 op0..30（B 用 {fromCollab:true}），然后：
//   - 打印 A/B 的 filter 资源（op31 前后）
//   - 在 B 上逐条应用 op31 发出的 mutation，每条之后打印 B 的 filter 资源
//   - 另开一个 B2 用"原命令重放"再测一次
// 目的：判定分叉发生在哪一条 mutation / 或命令自身的控制器副作用。

import type { IWorkbookData } from "@univerjs/core";
import { normalizeSnapshot } from "./lib/compare.ts";
import { genSmallSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList, type OpCtx, pickOp } from "./lib/ops.ts";
import { createPrng } from "./lib/prng.ts";
import { parseFilterResource } from "./lib/transport.ts";
import { bootUniver, type CapturedMutation, createBook } from "./lib/univer-node.ts";

const SEQ = 388;
const TARGET_OP = 31;
const BASE_SEED = 20260929;

function filterOf(save: () => unknown): string {
  return JSON.stringify(parseFilterResource(save() as Parameters<typeof parseFilterResource>[0]));
}

async function main() {
  const seed = BASE_SEED + SEQ;
  const unitId = `wb-probe-${SEQ}`;
  const prng = createPrng(seed);
  const { snapshot, sheets } = genSmallSnapshot(unitId, createPrng(seed ^ 0x9e37));

  const bootA = bootUniver();
  attachRecorder(bootA);
  const bookA = createBook(bootA, snapshot);
  const bootB = bootUniver();
  const bookB = createBook(bootB, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);

  const ctx: OpCtx = {
    boot: bootA,
    unitId,
    prng,
    sheets: sheets.map((s) => ({ id: s.id, name: s.name, rowCount: s.rows, colCount: s.cols })),
    merges: new Map(),
    dvRules: [],
    cfRuleIds: [],
    hiddenRows: new Map(),
    hiddenCols: new Map(),
    frozenSheets: new Set(),
    filterSheets: new Map(),
    seqId: SEQ,
    opIndex: 0,
  };

  const opMutations: CapturedMutation[][] = [];
  const opMeta: Array<{ opType: string; commandId: string; params: unknown }> = [];
  for (let i = 0; i <= TARGET_OP; i++) {
    ctx.opIndex = i;
    const op = pickOp(prng);
    if (i === TARGET_OP)
      console.log(
        "A filter BEFORE op31:",
        filterOf(() => bookA.save()),
      );
    const start = mutationList.length;
    const res = await op.run(ctx);
    const emitted = mutationList.slice(start).map((m) => ({
      id: m.id,
      params: JSON.parse(JSON.stringify(m.params)),
    }));
    opMutations.push(emitted);
    opMeta.push({
      opType: res.opType,
      commandId: res.commandId,
      params: JSON.parse(JSON.stringify(res.params)),
    });
    if (i === TARGET_OP) break; // 目标 op 的 mutation 先不放到 B
    for (const m of emitted) {
      await bootB.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
      });
    }
  }

  console.log(`target op: ${opMeta[TARGET_OP]?.opType} ${opMeta[TARGET_OP]?.commandId}`);
  console.log(
    "B filter BEFORE op31:",
    filterOf(() => bookB.save()),
  );

  // A 端 op31 之后的资源
  console.log(
    "A filter AFTER op31 :",
    filterOf(() => bookA.save()),
  );
  console.log("emitted mutations:");
  const emitted = opMutations[TARGET_OP] ?? [];
  for (const [i, m] of emitted.entries()) {
    console.log(`  [${i}] ${m.id} ${JSON.stringify(m.params).slice(0, 220)}`);
  }

  // B 逐条放，每条后看资源
  for (const [i, m] of emitted.entries()) {
    const ok = await bootB.commandService.executeCommand(
      m.id,
      JSON.parse(JSON.stringify(m.params)),
      { fromCollab: true },
    );
    console.log(
      `B after [${i}] ${m.id} ok=${ok} ->`,
      filterOf(() => bookB.save()),
    );
  }
  console.log(
    "B final (collab):",
    filterOf(() => bookB.save()),
  );

  // B2：从同一快照重放 op0..30，op31 用原命令重放
  const bootB2 = bootUniver();
  const bookB2 = createBook(bootB2, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);
  for (let i = 0; i < TARGET_OP; i++) {
    for (const m of opMutations[i] ?? []) {
      await bootB2.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
      });
    }
  }
  const meta = opMeta[TARGET_OP];
  if (meta) {
    const ok = await bootB2.commandService.executeCommand(
      meta.commandId,
      JSON.parse(JSON.stringify(meta.params)),
    );
    console.log(
      `B2 command-replay ${meta.commandId} ok=${ok} ->`,
      filterOf(() => bookB2.save()),
    );
  }

  // B3：同样 mutation 流，但选项 {fromCollab:true, onlyLocal:true}
  const bootB3 = bootUniver();
  const bookB3 = createBook(bootB3, JSON.parse(JSON.stringify(snapshot)) as IWorkbookData);
  for (let i = 0; i < TARGET_OP; i++) {
    for (const m of opMutations[i] ?? []) {
      await bootB3.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
        fromCollab: true,
        onlyLocal: true,
      });
    }
  }
  for (const m of emitted) {
    await bootB3.commandService.executeCommand(m.id, JSON.parse(JSON.stringify(m.params)), {
      fromCollab: true,
      onlyLocal: true,
    });
  }
  console.log(
    "B3 (collab+onlyLocal):",
    filterOf(() => bookB3.save()),
  );

  // 全量快照 diff 摘要
  const { deepDiff } = await import("./lib/compare.ts");
  const d1 = deepDiff(normalizeSnapshot(bookA.save()), normalizeSnapshot(bookB.save()), [], []);
  const d2 = deepDiff(normalizeSnapshot(bookA.save()), normalizeSnapshot(bookB2.save()), [], []);
  const d3 = deepDiff(normalizeSnapshot(bookA.save()), normalizeSnapshot(bookB3.save()), [], []);
  console.log(
    "diffs A vs B(collab):",
    d1.length,
    d1.slice(0, 5).map((d) => d.path),
  );
  console.log(
    "diffs A vs B2(command):",
    d2.length,
    d2.slice(0, 5).map((d) => d.path),
  );
  console.log(
    "diffs A vs B3(collab+onlyLocal):",
    d3.length,
    d3.slice(0, 5).map((d) => d.path),
  );

  process.exit(0);
}

await main();
