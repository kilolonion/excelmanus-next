// worker_threads harness：T1 载入 / T2 延迟测量。
// 快照在 worker 内生成（避免超大对象跨线程拷贝），计时只算 createBook/executeCommand。

import { parentPort, workerData } from "node:worker_threads";
import { genLargeSnapshot } from "./lib/gen.ts";
import { attachRecorder, mutationList } from "./lib/ops.ts";
import { bootUniver, createBook } from "./lib/univer-node.ts";

const gc = (globalThis as { gc?: () => void }).gc;
const mem = () => {
  gc?.();
  const m = process.memoryUsage();
  return { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576) };
};

interface Msg {
  kind: "t1" | "t2";
  rows: number;
  cols: number;
  seed: number;
  writeN?: number;
  rowOpN?: number;
}

function lat() {
  return { t: performance.now() };
}

async function run(msg: Msg) {
  const boot = bootUniver();
  attachRecorder(boot);
  const genT0 = performance.now();
  const { snapshot } = genLargeSnapshot(`wb-${msg.rows}x${msg.cols}`, msg.rows, msg.cols, msg.seed);
  const genMs = performance.now() - genT0;
  const memBefore = mem();

  const t0 = performance.now();
  const book = createBook(boot, snapshot);
  const createMs = performance.now() - t0;
  // 强制物化：save() 会遍历整个 cellMatrix，反映"真正可用"成本
  const t1 = performance.now();
  const saved = book.save();
  const saveMs = performance.now() - t1;
  const loadMs = createMs + saveMs;
  const memAfter = mem();
  const sheetId = "s1";

  if (msg.kind === "t1") {
    return {
      genMs: Math.round(genMs),
      createMs: Math.round(createMs),
      saveMs: Math.round(saveMs),
      loadMs: Math.round(loadMs),
      memBefore,
      memAfter,
      sheetCount: Object.keys((saved as { sheets?: object }).sheets ?? {}).length,
    };
  }

  // T2
  const writeN = msg.writeN ?? 10_000;
  const rowOpN = msg.rowOpN ?? 100;
  const results: Record<string, unknown> = {
    loadMs: Math.round(loadMs),
    createMs: Math.round(createMs),
    saveMs: Math.round(saveMs),
    memAfter,
  };

  // 单元格写值：命令路径
  const cmdLat: number[] = [];
  for (let i = 0; i < writeN; i++) {
    const r = (i * 7919) % msg.rows;
    const c = (i * 31) % msg.cols;
    const l = lat();
    await boot.commandService.executeCommand("sheet.command.set-range-values", {
      unitId: book.unitId,
      subUnitId: sheetId,
      range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
      value: { v: i },
    });
    cmdLat.push(performance.now() - l.t);
  }
  results.writeCmd = cmdLat;

  // 单元格写值：直跑 mutation 路径（跳过命令层/拦截器/undo 工厂）
  const mutLat: number[] = [];
  for (let i = 0; i < writeN; i++) {
    const r = (i * 7919 + 1) % msg.rows;
    const c = (i * 31 + 1) % msg.cols;
    const l = lat();
    await boot.commandService.executeCommand("sheet.mutation.set-range-values", {
      unitId: book.unitId,
      subUnitId: sheetId,
      cellValue: { [r]: { [c]: { v: i } } },
    });
    mutLat.push(performance.now() - l.t);
  }
  results.writeMut = mutLat;
  results.mutationsEmitted = mutationList.length;

  // 插行 / 删行：位置上中下各三分之一
  const third = Math.floor(msg.rows / 3);
  const positions = {
    top: Math.floor(third / 2),
    mid: Math.floor(msg.rows / 2),
    bot: Math.floor(third * 2.4),
  };
  const insertLat: Record<string, number[]> = { top: [], mid: [], bot: [] };
  const removeLat: Record<string, number[]> = { top: [], mid: [], bot: [] };
  const per = Math.floor(rowOpN / 3);
  let liveRows = msg.rows;
  for (const [name, at0] of Object.entries(positions)) {
    for (let i = 0; i < per; i++) {
      const at = Math.min(at0, liveRows - 1);
      const l = lat();
      const ok = await boot.commandService.executeCommand("sheet.command.insert-row-by-range", {
        unitId: book.unitId,
        subUnitId: sheetId,
        range: { startRow: at, endRow: at, startColumn: 0, endColumn: msg.cols - 1 },
      });
      insertLat[name]?.push(performance.now() - l.t);
      if (ok) liveRows += 1;
    }
  }
  for (const [name, at0] of Object.entries(positions)) {
    for (let i = 0; i < per; i++) {
      const at = Math.min(at0, liveRows - 2);
      const l = lat();
      const ok = await boot.commandService.executeCommand("sheet.command.remove-row-by-range", {
        unitId: book.unitId,
        subUnitId: sheetId,
        range: { startRow: at, endRow: at, startColumn: 0, endColumn: msg.cols - 1 },
      });
      removeLat[name]?.push(performance.now() - l.t);
      if (ok) liveRows -= 1;
    }
  }
  results.insertRow = insertLat;
  results.removeRow = removeLat;
  results.memEnd = mem();
  return results;
}

// 双入口：worker_threads（workerData）或子进程 CLI（node worker-harness.ts <kind> <rows> <cols> <seed>）
const cli = process.argv[2]
  ? (JSON.parse(process.argv[2]) as Msg)
  : (workerData as Msg | undefined);
const msg = cli as Msg;
try {
  const out = await run(msg);
  if (parentPort) parentPort.postMessage({ ok: true, ...out });
  else console.log(JSON.stringify({ ok: true, ...out }));
} catch (e) {
  const payload = { ok: false, error: String((e as Error).stack ?? e).slice(0, 500) };
  if (parentPort) parentPort.postMessage(payload);
  else console.log(JSON.stringify(payload));
}
process.exit(0);
