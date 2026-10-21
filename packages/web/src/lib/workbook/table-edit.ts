import { ARRAY_STATE_MUTATION, arraysOf, TABLE_STATE_MUTATION } from "@excelmanus/protocol";
import { CommandType, ICommandService, type IMutationInfo, IUndoRedoService } from "@univerjs/core";
import {
  type ISetRangeValuesMutationParams,
  SetRangeValuesMutation,
  SetRangeValuesUndoMutationFactory,
} from "@univerjs/sheets";
import { TableManager } from "@univerjs/sheets-table";
import type { SheetApi } from "@/components/excel/FormatToolbar";

const ID = "excelmanus.command.edit-table";
const registered = new WeakSet<object>();
export function editTable(api: SheetApi, mutations: IMutationInfo[]): boolean {
  const injector = api.univer.__getInjector(),
    commands = injector.get(ICommandService);
  if (!registered.has(api.univer)) {
    commands.registerCommand({
      id: ID,
      type: CommandType.COMMAND,
      handler: (accessor, input: { mutations: IMutationInfo[]; unitId: string }) => {
        const undo: IMutationInfo[] = [];
        for (const m of input.mutations) {
          if (m.id === SetRangeValuesMutation.id)
            undo.unshift({
              id: m.id,
              params: SetRangeValuesUndoMutationFactory(
                accessor,
                m.params as ISetRangeValuesMutationParams,
              ),
            });
          else if (m.id === TABLE_STATE_MUTATION) {
            const p = m.params as { unitId: string; subUnitId: string };
            undo.unshift({
              id: m.id,
              params: {
                ...p,
                tables: accessor
                  .get(TableManager)
                  .getTablesBySubunitId(p.unitId, p.subUnitId)
                  .map((t) => t.toJSON()),
              },
            });
          } else if (m.id === ARRAY_STATE_MUTATION) {
            const p = m.params as { unitId: string; subUnitId: string };
            undo.unshift({
              id: m.id,
              params: {
                ...p,
                arrays: arraysOf(api.wb.getSheetBySheetId(p.subUnitId)?.getSheet().getSnapshot()),
              },
            });
          } else throw Error("不支持的工作表操作");
        }
        for (const m of input.mutations)
          if (!commands.syncExecuteCommand(m.id, m.params)) throw Error("表对象修改失败");
        accessor.get(IUndoRedoService).pushUndoRedo({
          unitID: input.unitId,
          undoMutations: undo,
          redoMutations: input.mutations,
        });
        return true;
      },
    });
    registered.add(api.univer);
  }
  return commands.syncExecuteCommand(ID, { mutations, unitId: api.wb.getId() });
}
