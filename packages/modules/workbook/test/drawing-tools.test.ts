import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { workbookEditTool } from "../src/edit.ts";
import { objectsOf } from "../src/objects.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx } from "../src/xlsx.ts";

test("public read/edit/checkpoint agree on original image offsets and flat shape lifecycle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drawing-tools-"));
  const db = openDb(join(dir, "test.sqlite"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const svc = new DocumentService(db);
  try {
    db.prepare(
      "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('w', 'w', ?, 1, 0, '2026-10-20T00:00:00.000Z')",
    ).run(dir);
    writeFileSync(
      join(dir, "draw.xlsx"),
      Buffer.from(
        readFileSync(new URL("./fixtures/drawing-objects.xlsx.base64", import.meta.url), "utf8"),
        "base64",
      ),
    );
    const ctx: ToolContext = {
      workspaceId: "w",
      workspaceRoot: dir,
      agentId: "main",
      sessionId: "s",
      toolCallId: "draw-test",
      role: "main",
      signal: AbortSignal.timeout(60000),
      reads: createReadTable(),
      backups: new BackupService(db).bind({
        workspaceId: "w",
        workspaceRoot: dir,
        sessionId: "s",
        agentId: "main",
      }),
    };
    const read = workbookTools(svc).find((tool) => tool.name === "workbook_read")!;
    const before = await read.execute({ path: "draw.xlsx", mode: "objects" }, ctx);
    expect(before.status, JSON.stringify(before.error)).toBe("ok");
    expect(before.data).toMatchObject({
      objects: [
        {
          images: [{ id: "keep_image", offsetX: 3, offsetY: 2 }, { id: "delete_image" }],
          shapes: [
            { id: "keep_shape", type: "rect" },
            { id: "delete_shape", type: "rect" },
          ],
        },
      ],
      preserved: { drawings: expect.any(Array) },
    });
    const result = await workbookEditTool(svc).execute(
      {
        path: "draw.xlsx",
        ops: [
          {
            op: "image.update",
            sheet: "对象",
            id: "keep_image",
            anchor: "J3",
            width: 144,
            height: 72,
          },
          {
            op: "shape.update",
            sheet: "对象",
            id: "keep_shape",
            anchor: "J9",
            width: 160,
            height: 80,
          },
          { op: "shape.delete", sheet: "对象", id: "delete_shape" },
          {
            op: "shape.add",
            sheet: "对象",
            id: "added_arrow",
            title: "added_arrow",
            type: "rightArrow",
            text: "新增箭头",
            anchor: "C18",
            width: 120,
            height: 40,
          },
        ],
      },
      ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const opened = await svc.open("w", dir, "draw.xlsx");
    await svc.checkpoint(opened.meta.id, dir);
    const disk = importXlsx(readFileSync(join(dir, "draw.xlsx")), "draw.xlsx");
    const objects = objectsOf(disk.snapshot.sheets[disk.snapshot.sheetOrder[0]!]!);
    expect(objects.images[0]).toMatchObject({
      id: "keep_image",
      anchor: "J3",
      width: 144,
      height: 72,
      offsetX: 0,
      offsetY: 0,
    });
    expect(objects.shapes).toHaveLength(2);
    expect(objects.shapes?.find((shape) => shape.id === "keep_shape")).toMatchObject({
      anchor: "J9",
      width: 160,
      height: 80,
      text: "保留矩形",
    });
    expect(objects.shapes?.find((shape) => shape.id === "added_arrow")).toMatchObject({
      type: "rightArrow",
      anchor: "C18",
      width: 120,
      height: 40,
      text: "新增箭头",
    });
  } finally {
    await svc.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
