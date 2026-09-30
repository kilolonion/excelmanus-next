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
  onCommandExecuted(cb: (info: ICommandInfo) => void): unknown;
  dispose(): Promise<void>;
}

export function bootUniver(): Booted {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsNodeCoreEnUS) },
    presets: [UniverSheetsNodeCorePreset()],
    plugins: [UniverSheetsConditionalFormattingPlugin],
  });
  const commandService = univer.__getInjector().get(ICommandService);
  return {
    univerAPI,
    executeCommand: (id, params, options) =>
      commandService.executeCommand(id, params as object | undefined, options as never),
    onCommandExecuted: (cb) => commandService.onCommandExecuted(cb),
    dispose: async () => {
      try {
        await univer.dispose();
      } catch {
        // dispose 在无头下偶发空引用（spike 实测），忽略
      }
    },
  };
}

/**
 * 在「同步命令窗口」内捕获 MUTATION：执行每条命令时收集其同步产生的 mutation；
 * 公式引擎异步产生的 mutation 在窗口外发生，不记入本修订（07 §3.3、ADR 0002）。
 */
export class MutationCapture {
  private readonly all: DocMutation[] = [];
  private cursor = 0;
  private recording = false;

  constructor(boot: Booted) {
    boot.onCommandExecuted((info) => {
      if (info.type === CommandType.MUTATION && this.recording) {
        this.all.push({ id: info.id, params: info.params });
      }
    });
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
