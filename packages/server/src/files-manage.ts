import { newId } from "@excelmanus/core";
import { writableFilesModule } from "@excelmanus/files";
import {
  type BackupService,
  createReadTable,
  runWithHostNativeAccess,
  type DatabaseSync,
  type SyncBus,
  type ToolContext,
} from "@excelmanus/kernel";
import { ManageFilesBody } from "@excelmanus/protocol";
import { Hono } from "hono";
import type { FailFn } from "./app.ts";
import { getWorkspace } from "./store.ts";

/** 与代理 files 工具共用文件事务、备份和已注册文档守卫。 */
export function fileManagementRoutes(
  db: DatabaseSync,
  backups: BackupService,
  bus: SyncBus,
  fail: FailFn,
  coordinateFiles?: Parameters<typeof writableFilesModule>[2],
): Hono {
  const app = new Hono();
  const tool = writableFilesModule(db, backups, coordinateFiles).tools!.find(
    (item) => item.name === "files",
  )!;
  app.post("/workspaces/:id/files/manage", async (c) => {
    const workspace = getWorkspace(db, c.req.param("id"));
    if (!workspace) return fail(c, 404, "not_found", "工作区不存在");
    const parsed = ManageFilesBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "文件操作参数无效");
    const { ops, confirmed } = parsed.data;
    if (ops.some((op) => op.op === "delete") && confirmed !== true)
      return fail(c, 403, "forbidden", "删除文件前需要确认移入回收站");
    const callId = newId("manual");
    const context: ToolContext = {
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      sessionId: callId,
      agentId: "user",
      toolCallId: callId,
      role: "main",
      signal: c.req.raw.signal,
      reads: createReadTable(),
      backups: backups.bind({
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        sessionId: callId,
        agentId: "user",
      }),
      destructiveApproved: confirmed === true,
    };
    // This route is behind the authenticated native HTTP boundary. It is not
    // callable as a task tool, and native identity cannot replace an active task.
    const result = await runWithHostNativeAccess({db,workspaceId:workspace.id,workspaceRoot:workspace.path,operationId:callId},
      () => tool.execute({ ops }, context));
    if (result.status !== "ok") {
      const code = result.error?.code;
      if (code === "OUT_OF_WORKSPACE" || code === "APPROVAL_DENIED")
        return fail(c, 403, "forbidden", result.error?.message ?? "文件操作被拒绝");
      if (code === "NOT_FOUND") return fail(c, 404, "not_found", result.error!.message);
      if (code === "VERSION_CONFLICT" || code === "FILE_LEASED" || code === "UNSUPPORTED_FEATURE")
        return fail(c, 409, "conflict", result.error!.message);
      if (code === "INVALID_ARGUMENT") return fail(c, 400, "bad_request", result.error!.message);
      return fail(
        c,
        500,
        "internal",
        result.status === "uncertain"
          ? "文件操作结果不确定，请检查文件和备份后再操作"
          : "文件操作失败，未自动重试",
      );
    }
    bus.publish({
      kind: "app",
      data: {
        type: "files.changed",
        workspaceId: workspace.id,
        moves: (result.changes as { moves?: unknown } | undefined)?.moves ?? [],
      },
    });
    return c.json({
      ok: true,
      paths: (result.changes as { paths?: string[] } | undefined)?.paths ?? [],
    });
  });
  return app;
}
