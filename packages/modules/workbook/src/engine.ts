// 无头 Univer 实例装配（07 §2.1、ADR 0003）：node 侧 UniverSheetsNodeCorePreset +
// 条件格式插件；运行在主线程（M2a，07 §3.1 允许后续迁 worker）。

import {
  CommandType,
  type ICommandInfo,
  ICommandService,
  type IWorkbookData,
} from "@univerjs/core";
import { UniverSheetsNodeCorePreset } from "@univerjs/preset-sheets-node-core";
import sheetsNodeCoreEnUS from "@univerjs/preset-sheets-node-core/locales/en-US";
import { createUniver, type FUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";

/** 引擎版本，写入 documents.engine_version（ADR 0003：升级时回放旧日志）。 */
export const ENGINE_VERSION = "1.0.2";

/** 可序列化传输的一条 Univer mutation。 */
export interface DocMutation {
  id: string;
  params: unknown;
}

export interface Booted {
  univerAPI: FUniver;
  executeCommand(
    id: string,
    params?: unknown,
    options?: { fromCollab?: boolean },
  ): Promise<boolean>;
  onCommandExecuted(cb: (info: ICommandInfo, options?: { fromCollab?: boolean }) => void): unknown;
  /** 等最近一轮公式计算结果应用完（ADR 0002）；超时返回 false。 */
  waitCalc(timeoutMs: number): Promise<boolean>;
  dispose(): Promise<void>;
}

const CALC_START = "formula.mutation.set-formula-calculation-start";
const CALC_NOTIFY = "formula.mutation.set-formula-calculation-notification";

export function bootUniver(): Booted {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsNodeCoreEnUS) },
    presets: [UniverSheetsNodeCorePreset()],
    plugins: [UniverSheetsConditionalFormattingPlugin],
  });
  const commandService = univer.__getInjector().get(ICommandService);
  // 进行中的计算轮数：dispose 前等它归零，避免引擎定时器在实例销毁后触发
  let running = 0;
  let starts = 0;
  commandService.onCommandExecuted((info) => {
    if (info.id === CALC_START) {
      running++;
      starts++;
    } else if (
      info.id === CALC_NOTIFY &&
      (info.params as { functionsExecutedState?: unknown } | undefined)?.functionsExecutedState !==
        undefined
    )
      running = Math.max(0, running - 1);
  });
  const formula = (
    univerAPI as unknown as {
      getFormula(): { onCalculationResultApplied(timeout?: number): Promise<void> };
    }
  ).getFormula();
  return {
    univerAPI,
    executeCommand: (id, params, options) =>
      commandService.executeCommand(id, params as object | undefined, options as never),
    onCommandExecuted: (cb) => commandService.onCommandExecuted(cb as never),
    waitCalc: async (timeoutMs) => {
      // 引擎在命令后约十几毫秒内开始一轮计算；短窗口内未开始 = 本次写入不触发重算
      const startedBefore = starts;
      const t0 = Date.now();
      while (running === 0 && starts === startedBefore && Date.now() - t0 < 80)
        await new Promise((r) => setTimeout(r, 5));
      if (running === 0 && starts === startedBefore) return true;
      return formula.onCalculationResultApplied(Math.max(1, timeoutMs - (Date.now() - t0))).then(
        () => true,
        () => false,
      );
    },
    dispose: async () => {
      for (let i = 0; running > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      try {
        await univer.dispose();
      } catch {
        // dispose 在无头下偶发空引用（spike 实测），忽略
      }
    },
  };
}

/**
 * 在「同步命令窗口」内捕获 MUTATION：执行每条命令时收集其同步产生的 mutation。
 * 公式引擎异步写回的计算结果（无 trigger、非协同复现的 set-range-values）单独收集，
 * 由文档 actor 并入本次修订（同步等待）或作为 engine 来源修订提交（ADR 0002）。
 */
export class MutationCapture {
  private readonly all: DocMutation[] = [];
  private cursor = 0;
  private recording = false;
  private engine: DocMutation[] = [];
  /** 一轮计算结束且有待提交的引擎结果时回调。 */
  onEngineResults: (() => void) | undefined;

  constructor(boot: Booted) {
    boot.onCommandExecuted((info, options) => {
      if (info.type !== CommandType.MUTATION) return;
      const params = info.params as { trigger?: unknown; functionsExecutedState?: unknown };
      if (
        info.id === "sheet.mutation.set-range-values" &&
        !params?.trigger &&
        !options?.fromCollab
      ) {
        this.engine.push({ id: info.id, params: JSON.parse(JSON.stringify(info.params)) });
        return;
      }
      if (
        info.id === CALC_NOTIFY &&
        params?.functionsExecutedState !== undefined &&
        this.engine.length > 0
      )
        this.onEngineResults?.();
      if (this.recording) {
        this.all.push({ id: info.id, params: info.params });
      }
    });
  }

  /** 取走窗口外到达的引擎计算结果。 */
  takeEngineResults(): DocMutation[] {
    const out = this.engine;
    this.engine = [];
    return out;
  }

  begin(): void {
    this.cursor = this.all.length;
    this.recording = true;
  }

  /** 结束窗口并取走本段捕获（参数一律 JSON 往返，保证可序列化）。 */
  end(): DocMutation[] {
    this.recording = false;
    const out = this.all.splice(this.cursor).map((m) => ({
      id: m.id,
      params: m.params === undefined ? {} : (JSON.parse(JSON.stringify(m.params)) as unknown),
    }));
    return out;
  }
}

/** 用快照创建活工作簿（调用方负责快照定影：传入前深拷贝）。 */
export function createBook(
  boot: Booted,
  snapshot: IWorkbookData,
): {
  unitId: string;
  workbook: { save(): IWorkbookData };
} {
  const wb = boot.univerAPI.createWorkbook(snapshot);
  return {
    unitId: wb.getId(),
    workbook: { save: () => wb.save() as IWorkbookData },
  };
}

/** 重放持久化 mutation（来自 doc_ops），fromCollab 复现。返回失败条目。 */
export async function replayMutations(
  boot: Booted,
  mutations: DocMutation[],
): Promise<Array<{ id: string }>> {
  const failures: Array<{ id: string }> = [];
  for (const m of mutations) {
    const params = JSON.parse(JSON.stringify(m.params ?? {})) as object;
    const ok = await boot.executeCommand(m.id, params, { fromCollab: true });
    if (!ok) failures.push({ id: m.id });
  }
  return failures;
}
