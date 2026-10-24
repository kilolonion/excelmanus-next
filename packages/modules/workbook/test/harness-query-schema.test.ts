import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { expect, test } from "vitest";
import { z } from "zod";
import { WorkbookEditInput, WorkbookEditJsonSchema } from "../src/edit-input.ts";
import { workbookEditTool } from "../src/edit.ts";
import { ChangeOp } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import * as workbook from "../src/tools.ts";
import { HARNESS_CHANGE_OP_INPUTS } from "./fixtures/harness-change-ops.ts";

test("model edit schema keeps all 47 operation branches and each branch's required fields", () => {
  const ops = WorkbookEditJsonSchema.properties?.ops;
  if (typeof ops !== "object") throw new Error("Expected an object schema for ops");
  const schema = ops.items;
  expect(schema).toHaveProperty("oneOf");
  const branches = (
    schema as { oneOf: { properties: Record<string, unknown>; required: string[] }[] }
  ).oneOf;
  expect(branches).toHaveLength(47);
  expect(ChangeOp.options).toHaveLength(47);
  for (const [i, option] of ChangeOp.options.entries()) {
    const canonical = z.toJSONSchema(option, { io: "input" });
    expect(branches[i]?.properties).toEqual(canonical.properties);
    expect(branches[i]?.required).toEqual(canonical.required);
  }
});

test("every native operation remains reachable through exact branch and workbook tool input", () => {
  expect(HARNESS_CHANGE_OP_INPUTS).toHaveLength(47);
  expect(new Set(HARNESS_CHANGE_OP_INPUTS.map((input) => input.op))).toEqual(
    new Set(ChangeOp.options.map((option) => option.shape.op.value)),
  );
  const edit = workbookEditTool({} as DocumentService);
  for (const input of HARNESS_CHANGE_OP_INPUTS) {
    const branch = ChangeOp.options.find((option) => option.shape.op.value === input.op)!;
    const expected = branch.parse(input);
    expect(ChangeOp.parse(input)).toEqual(expected);
    const envelope = { path: "target.xlsx", ops: [input] };
    expect(WorkbookEditInput.parse(envelope).ops).toEqual([expected]);
    expect(edit.input.parse(envelope)).toEqual(WorkbookEditInput.parse(envelope));
  }
});

test("query schema has disjoint mode requirements and rejects hidden write/check fields", () => {
  expect(workbook).toHaveProperty("WorkbookQueryInput");
  const input = workbook.WorkbookQueryInput;
  const sql = {
    mode: "sql",
    sql: "SELECT SUM(amount) AS amount FROM data",
    sources: [{ name: "data", path: "source.xlsx", range: "Data!A1:B4" }],
  };
  const profile = { mode: "profile", path: "source.xlsx", range: "Data!A1:B4" };
  expect(input.safeParse(sql).success).toBe(true);
  expect(input.safeParse(profile).success).toBe(true);
  expect(
    input.safeParse({ mode: "diff", path: "left.xlsx", right: { path: "right.xlsx" } }).success,
  ).toBe(true);
  expect(
    input.safeParse({ mode: "sort_preflight", path: "source.xlsx", range: "Data!A1:B4" }).success,
  ).toBe(true);
  for (const invalid of [
    { ...sql, sources: [] },
    { ...sql, sql: undefined },
    { ...sql, sources: [{ name: "other", path: "source.xlsx", range: "Data!A1:B4" }] },
    { ...sql, sources: [{ name: "data", range: "Data!A1:B4" }] },
    { ...sql, sources: [{ name: "data", path: "source.xlsx" }] },
    { ...sql, saveTo: { path: "escape.xlsx", sheet: "Result" } },
    { ...sql, checks: [] },
    { ...profile, sql: "SELECT 1" },
    { ...profile, saveTo: { path: "escape.xlsx", sheet: "Result" } },
    {
      mode: "diff",
      path: "left.xlsx",
      right: { path: "right.xlsx", saveTo: { path: "escape.xlsx", sheet: "Result" } },
    },
    {
      mode: "sort_preflight",
      path: "source.xlsx",
      range: "Data!A1:B4",
      saveTo: { path: "escape.xlsx", sheet: "Result" },
    },
    { ...profile, mode: "check", checks: [{ kind: "required", column: "id" }] },
    { ...profile, mode: "source_alignment" },
    { mode: "sort_preflight", path: "source.xlsx" },
    { mode: "diff", path: "left.xlsx" },
    { mode: "profile" },
  ])
    expect(input.safeParse(invalid).success).toBe(false);
  const schema = workbook.WorkbookQueryJsonSchema;
  expect(schema.oneOf).toHaveLength(4);
  const branches = schema.oneOf as { properties: Record<string, unknown>; required: string[] }[];
  const sqlSchema = branches.find((branch) =>
    JSON.stringify(branch.properties.mode).includes('"sql"'),
  )!;
  expect(sqlSchema.required).toEqual(expect.arrayContaining(["mode", "sql", "sources"]));
  const sortSchema = branches.find((branch) =>
    JSON.stringify(branch.properties.mode).includes('"sort_preflight"'),
  )!;
  expect(sortSchema.required).toContain("range");
  expect(sortSchema.required).not.toContain("hasHeader");
  expect(JSON.stringify(schema)).not.toMatch(/saveTo|source_alignment/);
});

test("query delegates the real read implementation with identical values, provenance and source bytes", async () => {
  expect(workbook).toHaveProperty("workbookQueryTool");
  const dir = mkdtempSync(join(tmpdir(), "harness-query-"));
  const db = openDb(join(dir, "db.sqlite"), [
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    BACKUPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const ctx: ToolContext = {
    workspaceId: "ws",
    workspaceRoot: dir,
    sessionId: "ses",
    agentId: "main",
    toolCallId: "tc",
    role: "main",
    signal: AbortSignal.timeout(20_000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "ws",
      workspaceRoot: dir,
      sessionId: "ses",
      agentId: "main",
    }),
  };
  try {
    expect(
      (
        await workbookEditTool(service).execute(
          {
            path: "source.xlsx",
            create: true,
            sheetNames: ["Data"],
            ops: [
              {
                op: "cells.set",
                range: "Data!A1:B4",
                values: [
                  ["id", "amount"],
                  ["001", 2],
                  ["1", 3],
                  [1, 4],
                ],
              },
            ],
          },
          ctx,
        )
      ).status,
    ).toBe("ok");
    const analyze = workbook
      .workbookTools(service)
      .find((tool) => tool.name === "workbook_analyze")!;
    const query = workbook.workbookQueryTool(analyze);
    expect(query.effect).toBe("read");
    expect(query.replay).toBe("safe");
    const hash = () =>
      createHash("sha256")
        .update(readFileSync(join(dir, "source.xlsx")))
        .digest("hex");
    const before = hash();
    const sql = "SELECT SUM(amount) AS amount FROM data";
    const old = await analyze.execute(
      { mode: "sql", path: "source.xlsx", range: "Data!A1:B4", sql },
      ctx,
    );
    const actual = await query.execute(
      { mode: "sql", sources: [{ name: "data", path: "source.xlsx", range: "Data!A1:B4" }], sql },
      ctx,
    );
    expect(actual).toEqual(old);
    expect(actual).toMatchObject({
      status: "ok",
      data: { rows: [[9]], sources: [{ name: "data", path: "source.xlsx" }] },
    });
    const rejected = await query.execute(
      {
        mode: "sql",
        sources: [{ name: "data", path: "source.xlsx", range: "Data!A1:B4" }],
        sql,
        saveTo: { path: "escape.xlsx", sheet: "Result" },
      },
      ctx,
    );
    expect(rejected.status).toBe("error");
    expect(hash()).toBe(before);
    const legacyArgs = {
      mode: "sql",
      path: "source.xlsx",
      range: "Data!A1:B4",
      sql,
      saveTo: { path: "legacy-output.xlsx", sheet: "Result" },
    };
    expect(analyze.input.safeParse(legacyArgs).success).toBe(true);
    const legacySaved = await analyze.execute(legacyArgs, ctx);
    expect(legacySaved).toMatchObject({
      status: "ok",
      data: { rows: [[9]], saved: { path: "legacy-output.xlsx" } },
    });
    expect(existsSync(join(dir, "legacy-output.xlsx"))).toBe(true);
    const readerRejected = await analyze.execute(
      { ...legacyArgs, saveTo: { path: "reader-output.xlsx", sheet: "Result" } },
      { ...ctx, role: "reader" },
    );
    expect(readerRejected.status).toBe("error");
    expect(existsSync(join(dir, "reader-output.xlsx"))).toBe(false);
    expect(hash()).toBe(before);
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
