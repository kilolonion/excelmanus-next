import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  sha256,
  type ToolContext,
} from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { workbookEditTool } from "../src/edit.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "edit-target-"));
  const db = openDb(join(root, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const bytes = minimalXlsx(
    importCsv(new TextEncoder().encode("Value\n1\n"), "source.csv").snapshot,
  );
  for (const p of ["source.xlsx", "output.xlsx"]) writeFileSync(join(root, p), bytes);
  const svc = new DocumentService(db);
  const source = (await svc.open("w", root, "source.xlsx")).meta;
  const output = (await svc.open("w", root, "output.xlsx")).meta;
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: root,
    sessionId: "s",
    agentId: "main",
    toolCallId: "tc",
    role: "main",
    signal: AbortSignal.timeout(10000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: root,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const state = () => ({
    hashes: ["source.xlsx", "output.xlsx"].map((p) => sha256(readFileSync(join(root, p)))),
    rows: db.prepare("SELECT id,path,head_rev,checkpoint_rev FROM documents ORDER BY id").all(),
    ops: db.prepare("SELECT * FROM doc_ops").all(),
  });
  return {
    root,
    db,
    svc,
    source,
    output,
    ctx,
    state,
    async close() {
      await svc.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const ops = [{ op: "cells.set", range: "A2", values: [[9]] }];
test("contradictory docId/path rejects before either real actor or file changes", async () => {
  const x = await setup();
  try {
    const before = x.state(),
      tool = workbookEditTool(x.svc);
    const args = { docId: x.source.id, path: "output.xlsx", ops };
    expect(await tool.execute(args, x.ctx)).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT", retryable: false },
    });
    await x.svc.checkpoint(x.source.id, x.root);
    await x.svc.checkpoint(x.output.id, x.root);
    expect(x.state()).toEqual(before);
  } finally {
    await x.close();
  }
});
for (const mode of ["pair", "id", "path", "cold"] as const)
  test(`canonical lease and execution agree: ${mode}`, async () => {
    const x = await setup();
    let cold: DocumentService | undefined;
    try {
      if (mode === "cold") {
        await x.svc.close();
        cold = new DocumentService(x.db);
      }
      const svc = cold ?? x.svc,
        tool = workbookEditTool(svc);
      const args = {
        ...(mode !== "path" ? { docId: x.source.id } : {}),
        ...(mode !== "id" && mode !== "cold" ? { path: "./source.xlsx" } : {}),
        ops,
      };
      expect(tool.targets(args, x.ctx)).toEqual(["source.xlsx"]);
      expect(await tool.execute(args, x.ctx)).toMatchObject({
        status: "ok",
        data: { docId: x.source.id, path: "source.xlsx" },
      });
      expect(svc.headRev(x.source.id)).toBe(1);
      expect(svc.headRev(x.output.id)).toBe(0);
    } finally {
      await cold?.close();
      await x.close();
    }
  });
test("renamed document uses current path, rejects stale path and same basename in another directory", async () => {
  const x = await setup();
  try {
    await x.svc.withFileMoves(
      "w",
      x.root,
      [{ from: "source.xlsx", to: "renamed.xlsx" }],
      (commit) => {
        renameSync(join(x.root, "source.xlsx"), join(x.root, "renamed.xlsx"));
        commit();
        return { status: "ok" };
      },
    );
    const tool = workbookEditTool(x.svc);
    expect(tool.targets({ docId: x.source.id, ops }, x.ctx)).toEqual(["renamed.xlsx"]);
    const hash = sha256(readFileSync(join(x.root, "renamed.xlsx")));
    mkdirSync(join(x.root, "other"));
    writeFileSync(join(x.root, "other/renamed.xlsx"), readFileSync(join(x.root, "renamed.xlsx")));
    for (const path of ["source.xlsx", "other/renamed.xlsx"]) {
      expect(await tool.execute({ docId: x.source.id, path, ops }, x.ctx)).toMatchObject({
        status: "error",
        error: { code: "INVALID_ARGUMENT" },
      });
      expect(x.svc.headRev(x.source.id)).toBe(0);
      expect(sha256(readFileSync(join(x.root, "renamed.xlsx")))).toBe(hash);
    }
    expect(
      await tool.execute({ docId: x.source.id, path: "./renamed.xlsx", ops }, x.ctx),
    ).toMatchObject({ status: "ok" });
  } finally {
    await x.close();
  }
});

test("a rename after target selection is rejected, including resumed approval targets", async () => {
  const x = await setup();
  try {
    const tool = workbookEditTool(x.svc);
    const args = { docId: x.source.id, ops };
    const selected = tool.targets(args, x.ctx);
    await x.svc.withFileMoves(
      "w",
      x.root,
      [{ from: "source.xlsx", to: "renamed.xlsx" }],
      (commit) => {
        renameSync(join(x.root, "source.xlsx"), join(x.root, "renamed.xlsx"));
        commit();
        return { status: "ok" };
      },
    );
    const hash = sha256(readFileSync(join(x.root, "renamed.xlsx")));
    for (const call of [
      () => tool.execute(args, { ...x.ctx, toolTargets: selected }),
      () => workbookEditTool(x.svc).execute({ ...args }, { ...x.ctx, toolTargets: selected }),
    ])
      expect(await call()).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(x.svc.headRev(x.source.id)).toBe(0);
    expect(sha256(readFileSync(join(x.root, "renamed.xlsx")))).toBe(hash);
    expect(x.db.prepare("SELECT * FROM doc_ops").all()).toEqual([]);
  } finally {
    await x.close();
  }
});
test("actor checks pinned canonical path at the actual commit boundary", async () => {
  const x = await setup();
  try {
    const before = x.state();
    const result = await x.svc.submit(x.source.id, x.root, {
      baseRev: 0,
      expectedPath: "output.xlsx",
      ops: ops as never,
      source: { kind: "agent", id: "s/main" },
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(x.state()).toEqual(before);
  } finally {
    await x.close();
  }
});

for (const toolTargets of [[], ["source.xlsx", "output.xlsx"]])
  test("empty or ambiguous persisted lease target rejects", async () => {
    const x = await setup();
    try {
      const before = x.state();
      expect(
        await workbookEditTool(x.svc).execute(
          { docId: x.source.id, ops },
          { ...x.ctx, toolTargets },
        ),
      ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
      expect(x.state()).toEqual(before);
    } finally {
      await x.close();
    }
  });
