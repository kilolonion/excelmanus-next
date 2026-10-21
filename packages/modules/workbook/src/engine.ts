import {
  formulaAwareReorderMutation,
  normalizeTableCells,
  safeSortRangeCommand,
} from "@excelmanus/core";
import { ARRAY_CACHE_RESOURCE } from "@excelmanus/protocol";
import { IResourceManagerService, UniverInstanceType } from "@univerjs/core";
import { FormulaDataModel } from "@univerjs/preset-sheets-node-core";
import { TableManager, UniverSheetsTablePlugin } from "@univerjs/sheets-table";
// 无头 Univer 实例装配（07 §2.1、ADR 0003）：node 侧 UniverSheetsNodeCorePreset +
// 条件格式插件；运行在主线程（M2a，07 §3.1 允许后续迁 worker）。

import {
  arrayStateMutation,
  axisGroupMutation,
  sheetObjectsMutation,
  sheetPrintMutation,
  sheetTablesMutation,
} from "@excelmanus/protocol";
import {
  CommandType,
  type ICommandInfo,
  ICommandService,
  IUniverInstanceService,
  type IWorkbookData,
  type Workbook,
} from "@univerjs/core";
import {
  SheetsFilterService,
  SortRangeCommand,
  UniverSheetsNodeCorePreset,
} from "@univerjs/preset-sheets-node-core";
import sheetsNodeCoreEnUS from "@univerjs/preset-sheets-node-core/locales/en-US";
import { createUniver, type FUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";
import { findReplaceCommand } from "./find-replace.ts";
import { shiftFormula } from "./formula-shift.ts";
import { layoutCommands } from "./layout-commands.ts";
import { tablesOf } from "./tables.ts";
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
    options?: { fromCollab?: boolean; excelmanusReplay?: boolean },
  ): Promise<boolean>;
  onCommandExecuted(
    cb: (
      info: ICommandInfo,
      options?: {
        fromCollab?: boolean;
        applyFormulaCalculationResult?: boolean;
        excelmanusSortRejected?: boolean;
      },
    ) => void,
  ): unknown;
  /** 等公式计算结果应用完；force 请求新一轮计算，超时返回 false。 */
  waitCalc(timeoutMs: number, force?: boolean): Promise<boolean>;
  dispose(): Promise<void>;
}

const CALC_START = "formula.mutation.set-formula-calculation-start";
const CALC_NOTIFY = "formula.mutation.set-formula-calculation-notification";

export function bootUniver(): Booted {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsNodeCoreEnUS) },
    presets: [UniverSheetsNodeCorePreset()],
    plugins: [UniverSheetsConditionalFormattingPlugin, UniverSheetsTablePlugin],
  });
  const commandService = univer.__getInjector().get(ICommandService);
  const sortSheetOf = (unitId: string, sheetId: string) =>
    univer
      .__getInjector()
      .get(IUniverInstanceService)
      .getUnit<Workbook>(unitId)
      ?.getSheetBySheetId(sheetId);
  let sortInstalled = false;
  univer
    .__getInjector()
    .get(IResourceManagerService)
    .registerPluginResource({
      pluginName: ARRAY_CACHE_RESOURCE,
      businesses: [UniverInstanceType.UNIVER_SHEET],
      onLoad: (unitId, resource) => {
        const model = univer.__getInjector().get(FormulaDataModel);
        model.setArrayFormulaRange({
          ...model.getArrayFormulaRange(),
          [unitId]: resource.ranges ?? {},
        });
        model.setArrayFormulaCellData({
          ...model.getArrayFormulaCellData(),
          [unitId]: resource.cells ?? {},
        });
      },
      onUnLoad: () => {},
      parseJson: JSON.parse,
      toJson: (unitId) => {
        const model = univer.__getInjector().get(FormulaDataModel);
        return JSON.stringify({
          ranges: model.getArrayFormulaRange()[unitId] ?? {},
          cells: model.getArrayFormulaCellData()[unitId] ?? {},
        });
      },
    });

  commandService.registerCommand(
    sheetPrintMutation(CommandType.MUTATION, (unitId, sheetId) =>
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getUnit<Workbook>(unitId)
        ?.getSheetBySheetId(sheetId),
    ),
  );
  commandService.registerCommand(
    sheetObjectsMutation(CommandType.MUTATION, (unitId, sheetId) =>
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getUnit<Workbook>(unitId)
        ?.getSheetBySheetId(sheetId),
    ),
  );
  univer
    .__getInjector()
    .get(ICommandService)
    .registerCommand(
      axisGroupMutation(CommandType.MUTATION, (unitId, sheetId) =>
        univer
          .__getInjector()
          .get(IUniverInstanceService)
          .getUnit<Workbook>(unitId)
          ?.getSheetBySheetId(sheetId),
      ),
    );
  commandService.registerCommand(
    findReplaceCommand(commandService, (unitId, sid) =>
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getUnit<Workbook>(unitId)
        ?.getSheetBySheetId(sid),
    ),
  );
  for (const command of layoutCommands(
    commandService,
    (id) => univer.__getInjector().get(IUniverInstanceService).getUnit<Workbook>(id),
    (unitId, sheetId) =>
      !!univer.__getInjector().get(SheetsFilterService).getFilterModel(unitId, sheetId),
  ))
    commandService.registerCommand(command);
  commandService.registerCommand(
    arrayStateMutation(CommandType.MUTATION, (unitId, sheetId) =>
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getUnit<Workbook>(unitId)
        ?.getSheetBySheetId(sheetId),
    ),
  );
  const getTableManager = () => univer.__getInjector().get(TableManager);
  commandService.beforeCommandExecuted((command) => {
    if (command.id === "sheet.mutation.set-range-values") {
      const p = command.params as {
        unitId: string;
        subUnitId: string;
        cellValue?: Record<string, Record<string, unknown>>;
      };
      if (p.cellValue) {
        const sheet = univer
          .__getInjector()
          .get(IUniverInstanceService)
          .getUnit<Workbook>(p.unitId)
          ?.getSheetBySheetId(p.subUnitId);
        for (const [r, row] of Object.entries(p.cellValue)) {
          for (const [c, value] of Object.entries(row ?? {})) {
            if (!value || typeof value !== "object") continue;
            const keys = Object.keys(value);
            if (keys.length !== 1 || keys[0] !== "s") continue;
            const type = sheet?.getCellRaw(Number(r), Number(c))?.t;
            // Univer otherwise re-infers numeric-looking text when merging a style-only update.
            // Clone each patch: set-style can share one style object across differently typed cells.
            if (type != null) row[c] = { ...value, t: type };
          }
        }
        const tm = getTableManager();
        const tables = tm.getTableList(p.unitId).flatMap((info) => {
          const t = tm.getTableById(p.unitId, info.id)?.toJSON();
          return t
            ? [
                {
                  name: t.name,
                  sheet: "",
                  sheetId: info.subUnitId,
                  range: t.range,
                  columns: t.columns.map((c) => c.displayName),
                  showHeader: t.options.showHeader !== false,
                  showFooter: !!t.options.showFooter,
                },
              ]
            : [];
        });
        normalizeTableCells(p.cellValue, p.subUnitId, tables);
      }
    }

    if (command.id !== "formula.mutation.set-super-table") return;
    const p = command.params as {
      unitId: string;
      tableName: string;
      reference: Record<string, unknown>;
    };
    const tableManager = getTableManager();
    const table = tableManager.getTableList(p.unitId).find((t) => t.name === p.tableName);
    const actual = table && tableManager.getTableById(p.unitId, table.id);
    if (actual)
      Object.assign(p.reference, {
        showHeader: actual.isShowHeader(),
        showFooter: actual.isShowFooter(),
      });
  });
  commandService.registerCommand(
    sheetTablesMutation(CommandType.MUTATION, (unitId, sheetId, tables) => {
      if (
        !univer
          .__getInjector()
          .get(IUniverInstanceService)
          .getUnit<Workbook>(unitId)
          ?.getSheetBySheetId(sheetId)
      )
        return false;
      const tableManager = getTableManager();
      for (const t of tableManager.getTablesBySubunitId(unitId, sheetId))
        tableManager.deleteTable(unitId, t.getId());
      tableManager.fromJSON(unitId, {
        [sheetId]: { tables: tables as never[], tableFilteredOutRows: [] },
      });
      return true;
    }),
  );
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
      getFormula(): {
        executeCalculation(): void;
        onCalculationResultApplied(timeout?: number): Promise<void>;
      };
    }
  ).getFormula();
  return {
    univerAPI,
    executeCommand: (id, params, options) => {
      // Sheet commands are registered lazily when the first workbook is created.
      if (!sortInstalled) {
        commandService.unregisterCommand(SortRangeCommand.id);
        commandService.registerCommand(safeSortRangeCommand(SortRangeCommand, sortSheetOf));
        commandService.unregisterCommand("sheet.mutation.reorder-range");
        commandService.registerCommand(
          formulaAwareReorderMutation(CommandType.MUTATION, sortSheetOf, shiftFormula),
        );
        sortInstalled = true;
      }
      return commandService.executeCommand(id, params as object | undefined, options as never);
    },
    onCommandExecuted: (cb) => commandService.onCommandExecuted(cb as never),
    waitCalc: async (timeoutMs, force = false) => {
      // 普通写入短窗口未启动可视为无需计算；显式重算必须等到新一轮启动。
      const startedBefore = starts;
      const t0 = Date.now();
      if (force) formula.executeCalculation();
      while (
        (force || running === 0) &&
        starts === startedBefore &&
        Date.now() - t0 < (force ? timeoutMs : 80)
      )
        await new Promise((r) => setTimeout(r, 5));
      if (starts === startedBefore && (force || running === 0)) return !force;
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
      if (info.id === "sheet.mutation.reorder-range" && options?.excelmanusSortRejected) return;
      if (
        ["formula.mutation.set-super-table", "formula.mutation.remove-super-table"].includes(
          info.id,
        )
      )
        return;
      const params = info.params as { trigger?: unknown; functionsExecutedState?: unknown };
      if (
        info.id === "sheet.mutation.set-range-values" &&
        (!params?.trigger || options?.applyFormulaCalculationResult === true) &&
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
  const tables = Object.entries(tablesOf(snapshot)).flatMap(([sheetId, entry]) =>
    entry.tables.map((t) => ({
      name: t.name,
      sheet: snapshot.sheets[sheetId]?.name ?? sheetId,
      sheetId,
      range: t.range,
      columns: t.columns.map((c) => c.displayName),
      showHeader: t.options.showHeader !== false,
      showFooter: !!t.options.showFooter,
    })),
  );
  if (tables.length)
    for (const [sheetId, sheet] of Object.entries(snapshot.sheets))
      if (sheet.cellData) normalizeTableCells(sheet.cellData, sheetId, tables);
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
    const ok = await boot.executeCommand(m.id, params, {
      fromCollab: true,
      excelmanusReplay: true,
    });
    if (!ok) failures.push({ id: m.id });
  }
  return failures;
}
