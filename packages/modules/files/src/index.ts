import {
  type BackupService,
  type CapabilityModule,
  currentToolAccess,
  type DatabaseSync,
  FileOperationError,
  isInsidePath,
  PathSafetyError,
  resolveWorkspacePath,
  type ToolContext,
  TurnAccessError,
} from "@excelmanus/kernel";
import type { FilesInput, ToolResult } from "@excelmanus/protocol";
import type { z } from "zod";
import { assertFileMutationAccess, mutationTools } from "./mutations.ts";
import { FILES_TOOLS } from "./tools.ts";

export const filesModule: CapabilityModule = {
  id: "files",
  tools: FILES_TOOLS,
};

export { PathSafetyError, relOf, resolveWorkspacePath } from "@excelmanus/kernel";
export { FILES_TOOLS };

export type FileBatchCoordinator = (
  moves: Array<{ from: string; to: string }>,
  ctx: ToolContext,
  execute: (commit: () => void) => ToolResult | Promise<ToolResult>,
) => Promise<ToolResult>;

export function writableFilesModule(
  db: DatabaseSync,
  backups: BackupService,
  coordinate?: FileBatchCoordinator,
): CapabilityModule {
  const guard = (ctx: ToolContext, path: string) => {
    const requestedPath = resolveWorkspacePath(ctx.workspaceRoot, path);
    const requested = requestedPath.abs;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='documents'").get();
    if (!exists) return;
    const rows = db
      .prepare("SELECT path FROM documents WHERE workspace_id=?")
      .all(ctx.workspaceId) as { path: string }[];
    if (
      rows.some((r) => {
        try {
          if (currentToolAccess() && currentToolAccess()?.binding().decision.kind !== "unbounded") {
            const rel = requestedPath.rel;
            return r.path === rel || r.path.startsWith(`${rel}/`) || rel.startsWith(`${r.path}/`);
          }
          const registered = resolveWorkspacePath(ctx.workspaceRoot, r.path).abs;
          // 双向：动到工作簿本身/其下，或动到包含它的上级目录，都会让文档 actor 失去文件
          return isInsidePath(registered, requested) || isInsidePath(requested, registered);
        } catch {
          return false;
        }
      })
    )
      throw new FileOperationError(
        "UNSUPPORTED_FEATURE",
        "已注册工作簿必须通过文档 actor 修改或另存，不能直接移动或删除",
      );
  };
  const mutations = mutationTools(backups, guard);
  if (coordinate) {
    const files = mutations.find((tool) => tool.name === "files")!;
    files.execute = async (raw, ctx) => {
      const input = raw as z.infer<typeof FilesInput>;
      try {
        assertFileMutationAccess(input, ctx.workspaceRoot);
        const moves = input.ops.flatMap((op) =>
          op.op === "move"
            ? [
                {
                  from: resolveWorkspacePath(ctx.workspaceRoot, op.path).rel,
                  to: resolveWorkspacePath(ctx.workspaceRoot, op.to).rel,
                },
              ]
            : [],
        );
        const result = await coordinate(moves, ctx, (commit) => {
          const guarded = (c: ToolContext, path: string, operation?: string) => {
            if (operation === "move" && moves.some((move) => move.from === path)) return;
            guard(c, path);
          };
          return mutationTools(backups, guarded, commit)
            .find((tool) => tool.name === "files")!
            .execute(input, ctx);
        });
        if (result.status === "ok" && moves.length)
          return { ...result, changes: { ...(result.changes as object), moves } };
        return result;
      } catch (error) {
        return {
          status: "error",
          error: {
            code:
              error instanceof FileOperationError ||
              error instanceof PathSafetyError ||
              error instanceof TurnAccessError
                ? error.code
                : "INTERNAL",
            message: error instanceof Error ? error.message : "文件批次失败",
            retryable: false,
          },
        };
      }
    };
  }
  return { id: "files", tools: [...FILES_TOOLS, ...mutations] };
}
export { mutationTools } from "./mutations.ts";
