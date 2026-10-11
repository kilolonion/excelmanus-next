// 无头 Univer 实例装配：Node preset（docs/sheets/formula/numfmt/sort/filter/DV/
// drawing/hyperlink/thread-comment/rpc-node）+ 手动注册 conditional-formatting。

import {
  CommandType,
  type ICommandInfo,
  ICommandService,
  IUndoRedoService,
  type IWorkbookData,
} from "@univerjs/core";
import { UniverSheetsNodeCorePreset } from "@univerjs/preset-sheets-node-core";
import sheetsNodeCoreEnUS from "@univerjs/preset-sheets-node-core/locales/en-US";
import { createUniver, type FUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsConditionalFormattingPlugin } from "@univerjs/sheets-conditional-formatting";

export interface Booted {
  univer: ReturnType<typeof createUniver>["univer"];
  univerAPI: FUniver;
  commandService: {
    executeCommand(id: string, params?: unknown, options?: unknown): Promise<boolean>;
    onCommandExecuted(cb: (info: ICommandInfo) => void): unknown;
    hasCommand(id: string): boolean;
  };
  undoRedo: IUndoRedoService;
  injector: unknown;
  dispose(): Promise<void>;
}

export function bootUniver(): Booted {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsNodeCoreEnUS) },
    presets: [UniverSheetsNodeCorePreset()],
    plugins: [UniverSheetsConditionalFormattingPlugin],
  });
  const injector = univer.__getInjector();
  const commandService = injector.get(ICommandService);
  const undoRedo = injector.get(IUndoRedoService);
  return {
    univer,
    univerAPI,
    commandService: {
      executeCommand: (id, params, options) =>
        commandService.executeCommand(
          id,
          params as object | undefined,
          options as never,
        ) as Promise<boolean>,
      onCommandExecuted: (cb) => commandService.onCommandExecuted(cb),
      hasCommand: (id) => commandService.hasCommand(id),
    },
    undoRedo,
    injector,
    dispose: async () => {
      try {
        await univer.dispose();
      } catch {
        // dispose 在无头下偶发空引用，spike 中忽略
      }
    },
  };
}

export interface CapturedMutation {
  id: string;
  params: unknown;
}

// 监听 onCommandExecuted，收集所有 MUTATION 类型事件
export function mutationRecorder(boot: Booted): { list: CapturedMutation[] } {
  const list: CapturedMutation[] = [];
  boot.commandService.onCommandExecuted((info) => {
    if (info.type === CommandType.MUTATION) {
      list.push({ id: info.id, params: info.params });
    }
  });
  return { list };
}

export function createBook(
  boot: Booted,
  snapshot: IWorkbookData,
): {
  unitId: string;
  save(): IWorkbookData;
} {
  const wb = boot.univerAPI.createWorkbook(snapshot);
  return { unitId: wb.getId(), save: () => wb.save() as IWorkbookData };
}

// 在 B 端复现：params 必须过 JSON 往返（证明可序列化传输）
export async function replayMutations(
  boot: Booted,
  mutations: CapturedMutation[],
): Promise<{ okCount: number; failures: Array<{ id: string }> }> {
  let okCount = 0;
  const failures: Array<{ id: string }> = [];
  for (const m of mutations) {
    const params = JSON.parse(JSON.stringify(m.params));
    const ok = await boot.commandService.executeCommand(m.id, params, { fromCollab: true });
    if (ok) okCount += 1;
    else failures.push({ id: m.id });
  }
  return { okCount, failures };
}
