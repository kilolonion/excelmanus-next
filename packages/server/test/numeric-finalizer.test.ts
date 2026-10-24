import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writableFilesModule } from "@excelmanus/files";
import {
  AgentRuntime,
  BACKUPS_MIGRATION,
  BackupService,
  bindToolAccess,
  createReadTable,
  createTurnAccessBinding,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  QuestionCoordinator,
  runWithToolAccess,
  SessionLog,
  SyncBus,
  TeamCoordinator,
  type ToolContext,
  turnAccessFacts,
} from "@excelmanus/kernel";
import { createGateway } from "@excelmanus/models";
import type { ContextItem, ResolvedModel } from "@excelmanus/protocol";
import {
  numericBindingId,
  numericEvidence,
  numericLabelUnit,
  numericRefId,
  type ToolResult,
} from "@excelmanus/protocol";
import { SandboxPool } from "@excelmanus/sandbox";
import { workbookModule } from "@excelmanus/workbook";
import { unzipSync, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { interactionTools } from "../src/interactions.ts";
import { finalizeNumeric, finalizeNumericPointers } from "../src/numeric-finalizer.ts";
import { runScriptTool } from "../src/script.ts";

const realMacroSha = "f76c986f4ebc25c2cc57c088b2511a1269f4bd61d6223a2ab58db351da348ba6";
const realVbaSha = "f9becb822f01de291b0ec95ea4061235e1f98ea31f80d840009a6caab829ce90";
function realMacroBytes() {
  return Buffer.from(
    readFileSync(
      new URL("../../modules/workbook/test/fixtures/real-macro.xlsm.base64", import.meta.url),
      "utf8",
    ),
    "base64",
  );
}

test("macro delivery survives the real runtime withheld-to-host model.output boundary", async () => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  try {
    writeFileSync(join(f.dir, "source.xlsm"), realMacroBytes());
    f.log.append("s", null, [
      { type: "session.created", data: { workspaceId: "w", permissionMode: "auto" } },
    ]);
    f.log.append("s", "main", [
      { type: "agent.spawned", data: { role: "main", name: "main", modelProfileId: null } },
      {
        type: "user.message",
        data: {
          dispatchId: "macro-dispatch",
          clientMessageId: "macro-user",
          text: "复制 source.xlsm 到 edited.xlsm，只改 A1 并静态核验宏保留，不运行宏。",
          mode: "steer",
          accessInputOrigin: "user",
        },
      },
    ]);
    const calls: [string, string, unknown][] = [
      ["runtime-source", "workbook_read", { path: "source.xlsm", mode: "objects" }],
      ["runtime-copy", "files", { ops: [{ op: "copy", path: "source.xlsm", to: "edited.xlsm" }] }],
      [
        "runtime-edit",
        "workbook_edit",
        {
          path: "edited.xlsm",
          ops: [{ op: "cells.set", range: "Sheet1!A1", values: [["runtime macro preserved"]] }],
        },
      ],
      ["runtime-after", "workbook_read", { path: "edited.xlsm", mode: "objects" }],
      [
        "runtime-numeric",
        "run_script",
        {
          code: "const r = await wb.read({path:'edited.xlsm',mode:'range',range:'Sheet1!A1'}); return {readCount: r.status === 'ok' ? 1 : 0};",
        },
      ],
    ];
    let step = 0;
    const withheld = "这句来自模型：没有执行宏，也没有验证宏运行结果。自由文本哨兵 987654。";
    runtime = new AgentRuntime({
      db: f.db,
      log: f.log,
      bus: new SyncBus(),
      backups: new BackupService(f.db),
      tools: new Map([...f.tools, ["present", f.present]]),
      toolSpecsFor: () => [],
      workspaceRoot: () => f.dir,
      workspaceId: () => "w",
      resolveModel: () => ({ provider: "mock", model: "mock", profileId: "mock" }) as never,
      gateway: {
        async *step() {
          const index = step++;
          if (index === 3)
            await vi.waitFor(
              () => {
                const row = f.db
                  .prepare("SELECT id FROM documents WHERE path='edited.xlsm'")
                  .get() as { id: string };
                const meta = f.documents.meta(row.id)!;
                expect(meta.checkpointRev).toBe(meta.rev);
              },
              { timeout: 5000 },
            );
          if (index === calls.length) {
            yield { kind: "text.delta" as const, text: withheld };
            yield { kind: "finish" as const, reason: "stop" as const };
            return;
          }
          const [id, name, args] = calls[index] ?? [
            "runtime-finish",
            "present",
            {
              finalize: {
                status: "complete",
                sources: [
                  {
                    refId: numericRefId({ toolCallId: "runtime-numeric", pointer: "/data/value" }),
                  },
                ],
              },
            },
          ];
          yield {
            kind: "tool.call" as const,
            toolCallId: id,
            toolName: name,
            args,
            rawArgs: JSON.stringify(args),
          };
          yield { kind: "finish" as const, reason: "tool-calls" as const };
        },
      },
    });
    runtime.enqueue("s", "main", "macro-dispatch", "steer");
    await vi.waitFor(() => expect(runtime!.isRunning("s", "main")).toBe(false), { timeout: 15000 });
    const rows = f.log.readAfter("s", 0, 1000);
    expect(
      rows.some((row) => row.type === "model.output" && row.data.withheldText === withheld),
    ).toBe(true);
    const final = rows.findLast(
      (row) => row.type === "model.output" && row.data.sourceToolCallId === "runtime-finish",
    );
    expect(final?.data.deliveryStatus).toBe("complete");
    for (const fragment of [
      "本次宏核验仅静态读取或比较",
      "没有执行宏",
      "没有验证宏运行结果",
      "静态保留核验一致",
    ])
      expect(final?.data.text).toContain(fragment);
    expect(final?.data.text).not.toContain("987654");
  } finally {
    await runtime?.shutdown();
    await f.close();
  }
});

test("macro delivery exposes only the real 16KB VBA root and preserves sheets, A1 and the original card", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "macro"));
    f.ctx.turnId = "macro-read-only";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const bytes = realMacroBytes();
    writeFileSync(join(f.dir, "macro/original.xlsm"), bytes);
    const objects = await f.execute(
      "workbook_read",
      { path: "macro/original.xlsm", mode: "objects" },
      "macro-objects",
    );
    expect(objects).toMatchObject({
      status: "ok",
      data: {
        macroEvidence: {
          package: { sha256: realMacroSha },
          project: { status: "present", byteLength: 16384, sha256: realVbaSha },
        },
      },
    });
    const receipt = await visibleProviderReceipt(f, "macro-objects");
    expect(
      receipt?.candidates.items
        .map((item) => item.pointer)
        .filter((pointer) => pointer.startsWith("/data/macroEvidence")),
    ).toEqual(["/data/macroEvidence"]);
    expect(receipt?.candidates.items.some((item) => item.pointer === "/data/reportFacts")).toBe(
      true,
    );
    expect(receipt?.sources).toEqual([
      { refId: numericRefId({ toolCallId: "macro-objects", pointer: "/data/macroEvidence" }) },
    ]);
    await f.execute(
      "workbook_read",
      {
        path: "macro/original.xlsm",
        mode: "range",
        range: "Sheet1!A1",
        facets: ["values"],
      },
      "macro-a1",
    );
    const range = (await visibleProviderReceipt(f, "macro-a1"))!;
    const a1 = range.candidates.items.find((item) => item.pointer === "/data/values/0/0")!;
    // A string-cell selection must not lose an already-observed macro host family.
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: a1.refId }],
      },
      f.ctx,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "ok",
      data: {
        deliveredFiles: [
          expect.objectContaining({ path: "macro/original.xlsm", rev: 0, sha256: realMacroSha }),
        ],
      },
    });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "Sheet1",
      "Sheet2",
      "Sheet3",
      "ThisWorkbook",
      "This is a macro workbook",
      "16384",
      realVbaSha,
      "没有执行宏",
      "没有验证宏运行结果",
    ])
      expect(text).toContain(fragment);
    expect(text).not.toContain("静态保留核验一致");
    expect(readFileSync(join(f.dir, "macro/original.xlsm"))).toEqual(bytes);
    expect(
      f.log
        .readAfter("s", 0, 100)
        .filter((row) => row.type === "ui.present")
        .map((row) => (row.data as { path: string }).path),
    ).toEqual(["macro/original.xlsm"]);
  } finally {
    await f.close();
  }
});

test("macro delivery fixes the withheld boundary in host finalReply after a real copy and literal edit", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "macro"));
    f.ctx.turnId = "macro-copy-edit";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    writeFileSync(join(f.dir, "macro/source.xlsm"), realMacroBytes());
    await f.execute(
      "workbook_read",
      { path: "macro/source.xlsm", mode: "overview" },
      "macro-source",
    );
    const copied = await f.execute(
      "files",
      {
        ops: [{ op: "copy", path: "macro/source.xlsm", to: "macro/edited.xlsm" }],
      },
      "macro-copy",
    );
    expect(copied).toMatchObject({
      status: "ok",
      data: {
        results: [
          expect.objectContaining({
            copyBaseline: expect.objectContaining({ sourceSha256: realMacroSha }),
          }),
        ],
      },
    });
    const edit = await f.execute(
      "workbook_edit",
      {
        path: "macro/edited.xlsm",
        ops: [{ op: "cells.set", range: "Sheet1!A1", values: [["macro preserved"]] }],
      },
      "macro-edit",
    );
    expect(edit, JSON.stringify(edit)).toMatchObject({ status: "ok" });
    const docId = (edit.data as { docId: string }).docId;
    await vi.waitFor(
      () => {
        const meta = f.documents.meta(docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    await f.execute("workbook_read", { path: "macro/edited.xlsm", mode: "objects" }, "macro-after");
    await f.execute(
      "workbook_read",
      { path: "macro/edited.xlsm", mode: "range", range: "Sheet1!A1" },
      "macro-result",
    );
    const receipt = (await visibleProviderReceipt(f, "macro-result"))!;
    const a1 = receipt.candidates.items.find((item) => item.pointer === "/data/values/0/0")!;
    const withheld = "模型自由声明：未执行宏、未验证宏运行。不能透传的额外承诺 987654。";
    f.log.append("s", "main", [
      {
        type: "model.output",
        data: {
          stepId: "withheld-step",
          withheldText: withheld,
          deliveryStatus: "rejected",
        },
      },
    ]);
    const args = { finalize: { status: "complete" as const, sources: [{ refId: a1.refId }] } };
    const result = await f.present.execute(args, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = f.present.finalReply!(args, result)!;
    expect(text).toBe((result.data as { finalText: string }).finalText);
    for (const fragment of [
      "没有执行宏",
      "没有验证宏运行结果",
      "静态保留核验一致",
      "macro/source.xlsm",
      "macro/edited.xlsm",
      realMacroSha,
      realVbaSha,
      "macro preserved",
    ])
      expect(text).toContain(fragment);
    expect(text).not.toContain("987654");
    expect(result).toMatchObject({
      data: {
        deliveredFiles: expect.arrayContaining([
          expect.objectContaining({ path: "macro/edited.xlsm", rev: 1 }),
        ]),
      },
    });
    expect(readFileSync(join(f.dir, "macro/source.xlsm"))).toEqual(realMacroBytes());
  } finally {
    await f.close();
  }
});

test("macro delivery rejects hidden roots, fabricated refs, child pointers and script self-reports", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "macro"));
    writeFileSync(join(f.dir, "macro/original.xlsm"), realMacroBytes());
    f.ctx.turnId = "macro-ref-boundary";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const result = await f.execute(
      "workbook_read",
      { path: "macro/original.xlsm", mode: "objects" },
      "macro-visible",
    );
    for (const source of [
      { toolCallId: "macro-visible", pointer: "/data/macroEvidence/project/byteLength" },
      { toolCallId: "invented-read", pointer: "/data/macroEvidence" },
    ]) {
      expect(
        await finalizeNumeric(
          f.log,
          f.documents,
          {
            status: "complete",
            sources: [{ refId: numericRefId(source) }],
          },
          f.ctx,
        ),
      ).toMatchObject({ status: "error" });
    }
    f.log.append("s", "main", [
      {
        type: "tool.result",
        data: {
          toolCallId: "script-macro",
          toolName: "run_script",
          status: "ok",
          result,
        },
      },
    ]);
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "script-macro", pointer: "/data/macroEvidence" }) },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
    f.db
      .prepare(
        "UPDATE agent_context SET superseded=1 WHERE json_extract(item,'$.toolCallId')='macro-visible'",
      )
      .run();
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            {
              refId: numericRefId({ toolCallId: "macro-visible", pointer: "/data/macroEvidence" }),
            },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
  } finally {
    await f.close();
  }
});

test("macro metadata numbers cannot discharge a real numeric delivery obligation", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "macro-numeric-required";
    f.log.append("s", "main", [
      { type: "turn.started", data: { turnId: f.ctx.turnId, numericDeliveryRequired: true } },
    ]);
    writeFileSync(join(f.dir, "original.xlsm"), realMacroBytes());
    await f.execute("workbook_read", { path: "original.xlsm", mode: "overview" }, "macro-only");
    await f.execute(
      "workbook_read",
      { path: "original.xlsm", mode: "range", range: "Sheet1!A1" },
      "macro-required-a1",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [
          { refId: numericRefId({ toolCallId: "macro-only", pointer: "/data/macroEvidence" }) },
          { refId: numericRefId({ toolCallId: "macro-required-a1", pointer: "/data/values/0/0" }) },
        ],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("没有实际数值") },
    });
  } finally {
    await f.close();
  }
});

for (const extra of ["script", "sql", "other_document"] as const)
  test(`macro nonnumeric delivery cannot carry ${extra} text through its closed exception`, async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.dir, "original.xlsm"), realMacroBytes());
      f.ctx.turnId = `macro-text-${extra}`;
      f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
      await f.execute(
        "workbook_read",
        { path: "original.xlsm", mode: "overview" },
        "macro-text-root",
      );
      const pointer =
        extra === "script"
          ? "/data/value"
          : extra === "sql"
            ? "/data/rows/0/0"
            : "/data/values/0/0";
      if (extra === "script")
        await f.execute(
          "run_script",
          {
            code: "await wb.read({path:'original.xlsm',mode:'range',range:'Sheet1!A1'}); return 'unverified prose';",
          },
          "macro-extra-text",
        );
      else if (extra === "sql")
        await f.execute(
          "workbook_analyze",
          {
            path: "original.xlsm",
            mode: "sql",
            range: "Sheet1!A1",
            sql: "SELECT 'unverified prose' AS explanation",
          },
          "macro-extra-text",
        );
      else
        await f.execute(
          "workbook_read",
          { path: "book.xlsx", mode: "range", range: "Data!A1" },
          "macro-extra-text",
        );
      const result = await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            {
              refId: numericRefId({
                toolCallId: "macro-text-root",
                pointer: "/data/macroEvidence",
              }),
            },
            { refId: numericRefId({ toolCallId: "macro-extra-text", pointer }) },
          ],
        },
        f.ctx,
      );
      expect(result).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("没有实际数值") },
      });
    } finally {
      await f.close();
    }
  });

test("macro delivery rejects an externally changed current package even when the VBA bytes are unchanged", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "macro"));
    const run = scoped(f, { kind: "restricted", root: "macro" }, "macro-external-change");
    await run(async () => {
      writeFileSync(join(f.dir, "macro/original.xlsm"), realMacroBytes());
      await f.execute(
        "workbook_read",
        { path: "macro/original.xlsm", mode: "objects" },
        "macro-before-external",
      );
      const parts = unzipSync(realMacroBytes());
      parts["xl/worksheets/sheet1.xml"] = Buffer.from(
        Buffer.from(parts["xl/worksheets/sheet1.xml"]!).toString().replace('r="A1"', 'r="B1"'),
      );
      writeFileSync(join(f.dir, "macro/original.xlsm"), zipSync(parts));
      const result = await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            {
              refId: numericRefId({
                toolCallId: "macro-before-external",
                pointer: "/data/macroEvidence",
              }),
            },
          ],
        },
        f.ctx,
      );
      expect(result).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
      expect(f.log.readAfter("s", 0, 1000).filter((row) => row.type === "ui.present")).toEqual([]);
    });
  } finally {
    await f.close();
  }
});

test("unknown external target linkage stays unknown with codec reasons instead of inventing an empty cache", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    const parts = unzipSync(
      Buffer.from(
        readFileSync(
          new URL(
            "../../modules/workbook/test/fixtures/external-links.xlsx.base64",
            import.meta.url,
          ),
          "utf8",
        ),
        "base64",
      ),
    );
    const rel = Object.keys(parts).find(
      (path) => path.startsWith("xl/externalLinks/_rels/") && path.endsWith(".rels"),
    )!;
    parts[rel] = Buffer.from(
      Buffer.from(parts[rel]!).toString("utf8").replaceAll("/externalLinkPath", "/unknownLinkPath"),
    );
    writeFileSync(join(f.dir, "allowed", "unknown.xlsx"), zipSync(parts));
    const run = scoped(f, { kind: "restricted", root: "allowed" });
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/unknown.xlsx", mode: "objects" },
        "unknown-objects",
      ),
    );
    const receipt = (await visibleProviderReceipt(f, "unknown-objects"))!;
    const ref = receipt.candidates.items.find(
      (item) => item.pointer === "/data/preserved/externalLinkDetails",
    )!;
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        { status: "complete", sources: [{ refId: ref.refId }] },
        f.ctx,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("目标原文=未提供");
    expect(text).toContain("外部目标关系缺失、重复或类型不符");
    expect(text).toContain("未提供可确认的缓存");
    expect(text).toContain("不代表目标已读取或缓存为空");
  } finally {
    await f.close();
  }
});

test("truncated binding catalogs cannot turn two real unit relationships into an automatic unique choice", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!A1:B9",
            values: [
              ["label", "金额（元）"],
              ...Array.from({ length: 8 }, (_, i) => ["金额（万元）", i + 1]),
            ],
          },
        ],
      },
      "unit-grid",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!A1:B9" },
      "uuuuuuuu",
    );
    const receipt = (await visibleProviderReceipt(f, "uuuuuuuu"))!;
    expect(receipt.bindingCoverage.truncated).toBe(true);
    const singleton = receipt.bindingCandidates.items.find(
      (candidate) =>
        receipt.bindingCandidates.items.filter((item) => item.valueRefId === candidate.valueRefId)
          .length === 1,
    )!;
    expect(singleton).toBeDefined();
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      { status: "complete", sources: [{ refId: singleton.valueRefId }] },
      f.ctx,
    );
    expect(result).toMatchObject({ status: "error" });
    expect(result.error?.message).toContain("多个标签单位关系");
  } finally {
    await f.close();
  }
});

test("large current sort readback proves coverage without forcing every record into final text", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!A1:C100",
            values: Array.from({ length: 100 }, (_, r) => [r + 1, `row${r + 1}`, r * 2]),
          },
        ],
      },
      "large-grid",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    f.ctx.turnId = "large-sort-check";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    await f.execute(
      "workbook_analyze",
      { path: "book.xlsx", mode: "sort_preflight", range: "Data!A1:C100" },
      "large-preflight",
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!A1:C100", facets: ["values", "formulas"] },
      "large-current",
    );
    const receipt = (await visibleProviderReceipt(f, "large-current"))!;
    const value = receipt.candidates.items.find((item) => item.pointer === "/data/values/0/0")!;
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      { status: "complete", sources: [{ refId: value.refId }] },
      f.ctx,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("当前完整窗口已读取 values/formulas");
    expect(text).toContain("终稿只展示选定细项，不是全部记录");
    expect(text).not.toContain("row100");
    expect(text.length).toBeLessThan(24000);
  } finally {
    await f.close();
  }
});

test("binding choices reject invented or repeated relationships and never auto-pick conflicting unit labels", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!D1:E2",
            values: [
              ["项目", "金额（元）"],
              ["合计（万元）", 2.34567],
            ],
          },
        ],
      },
      "conflicting-units",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!D1:E2" },
      "choice-read",
    );
    const receipt = (await visibleProviderReceipt(f, "choice-read"))!;
    const source = receipt.candidates.items.find((item) => item.pointer === "/data/values/1/1")!;
    const options = receipt.bindingCandidates.items.filter(
      (item) => item.valueRefId === source.refId,
    );
    expect(options).toHaveLength(2);
    const args = { status: "complete" as const, sources: [{ refId: source.refId }] };
    const ambiguous = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(ambiguous).toMatchObject({ status: "error" });
    expect(ambiguous.error?.message).toContain("多个标签单位关系");
    const selected = options.find((item) => item.relation === "same_row")!;
    const valid = await finalizeNumeric(
      f.log,
      f.documents,
      { ...args, bindings: [{ bindingId: selected.bindingId }] },
      f.ctx,
    );
    expect(valid).toMatchObject({ status: "ok" });
    expect((valid.data as { finalText: string }).finalText).toContain("单位：万元");
    const repeated = await finalizeNumeric(
      f.log,
      f.documents,
      { ...args, bindings: options.map(({ bindingId }) => ({ bindingId })) },
      f.ctx,
    );
    expect(repeated).toMatchObject({ status: "error" });
    const invented = numericBindingId({
      toolCallId: "choice-read",
      valuePointer: "/data/values/1/1",
      labelPointer: "/data/values/0/0",
      relation: "same_row",
    });
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        { ...args, bindings: [{ bindingId: invented }] },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
    const foreign = numericBindingId({
      toolCallId: "other-call",
      valuePointer: "/data/values/1/1",
      labelPointer: "/data/values/1/0",
      relation: "same_row",
    });
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        { ...args, bindings: [{ bindingId: foreign }] },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
  } finally {
    await f.close();
  }
});

test("selected visible values cannot borrow hidden display metadata from the full log", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!C2", facets: ["values", "styles"] },
      "display-hidden",
    );
    const row = f.db
      .prepare(
        "SELECT idx,item FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')=?",
      )
      .get("display-hidden") as { idx: number; item: string };
    const item = JSON.parse(row.item);
    delete item.output.data.displayValues;
    delete item.output.data.displayBasis;
    delete item.output.data.styles;
    f.db
      .prepare("UPDATE agent_context SET item=? WHERE session_id='s' AND agent_id='main' AND idx=?")
      .run(JSON.stringify(item), row.idx);
    const receipt = (await visibleProviderReceipt(f, "display-hidden"))!;
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      { status: "complete", sources: receipt.sources },
      f.ctx,
    );
    expect(result).toMatchObject({ status: "ok" });
    expect((result.data as { finalText: string }).finalText).toContain("未提供格式信息");
    expect((result.data as { finalText: string }).finalText).not.toContain("37.50");
  } finally {
    await f.close();
  }
});

test("real copy then edit proves blocked sheets at saved endpoints without requiring a lost rev0 read", async () => {
  const f = await fixture(["Data", "Blocked", "Inside"]);
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Blocked!A2:C4",
            values: [
              [3, "R3", 6],
              [1, "R1", 2],
              [2, "R2", 4],
            ],
          },
          {
            op: "cells.set",
            range: "Inside!A2:C4",
            values: [
              [3, "I3", 6],
              [1, "I1", 2],
              [2, "I2", 4],
            ],
          },
          { op: "merge", range: "Blocked!B4:B5" },
          { op: "merge", range: "Inside!B2:B3" },
        ],
      },
      "setup-copy-targets",
    );
    const sourceId = (f.edit.data as { docId: string }).docId;
    await f.documents.checkpoint(sourceId, f.dir);
    f.ctx.turnId = "copy-preservation";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const ranges = ["Data!A2:C3", "Blocked!A2:C4", "Inside!A2:C4"];
    for (const [i, range] of ranges.entries())
      expect(
        await f.execute(
          "workbook_analyze",
          { path: "book.xlsx", mode: "sort_preflight", range },
          `original-preflight-${i}`,
        ),
      ).toMatchObject({ status: "ok" });
    const copied = await f.execute(
      "files",
      { ops: [{ op: "copy", path: "book.xlsx", to: "output.xlsx" }] },
      "real-copy",
    );
    expect(copied, JSON.stringify(copied)).toMatchObject({ status: "ok" });
    const edited = await f.execute(
      "workbook_edit",
      {
        path: "output.xlsx",
        ops: [
          { op: "sort", range: ranges[0], header: false, keys: [{ column: 1, order: "desc" }] },
        ],
      },
      "output-sort",
    );
    expect(edited, JSON.stringify(edited)).toMatchObject({ status: "ok" });
    const outputId = (edited.data as { docId: string }).docId;
    await f.documents.checkpoint(outputId, f.dir);
    for (const [i, range] of ranges.entries()) {
      expect(
        await f.execute(
          "workbook_read",
          { path: "output.xlsx", mode: "range", range, facets: ["values", "formulas"] },
          `output-read-${i}`,
        ),
      ).toMatchObject({ status: "ok" });
      expect(
        await f.execute(
          "workbook_analyze",
          { path: "output.xlsx", mode: "sort_preflight", range },
          `output-preflight-${i}`,
        ),
      ).toMatchObject({ status: "ok" });
    }
    const receipt = (await visibleProviderReceipt(f, "output-read-0"))!;
    const chosen = receipt.candidates.items.find((item) => item.pointer === "/data/values/0/0")!;
    const args = { status: "complete" as const, sources: [{ refId: chosen.refId }] };
    const result = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect.soft(text).toContain("跨多条待独立重排的数据行");
    expect.soft(text).toContain("保存后整表及所核共享支持部件与复制源保持原样");
    expect.soft(text).toContain("real-copy");
    expect.soft(text).toContain("output-sort");
    expect.soft(text).not.toContain("整个过程从未修改");
    // The copy proof is not permission to use stale current endpoints.
    await f.execute(
      "workbook_edit",
      { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[99]] }] },
      "source-later-change",
    );
    expect(await finalizeNumeric(f.log, f.documents, args, f.ctx)).toMatchObject({
      status: "error",
    });
  } finally {
    await f.close();
  }
});

test("delivery completeness bridges every checked target to fresh post-write preflight, records and separate execution facts", async () => {
  const f = await fixture(["Data", "Blocked", "Inside"]);
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Blocked!A2:C4",
            values: [
              [3, "R3", 6],
              [1, "R1", 2],
              [2, "R2", 4],
            ],
          },
          {
            op: "cells.set",
            range: "Inside!A2:C4",
            values: [
              [3, "I3", 6],
              [1, "I1", 2],
              [2, "I2", 4],
            ],
          },
          { op: "merge", range: "Blocked!B4:B5" },
          { op: "merge", range: "Inside!B2:B3" },
        ],
      },
      "setup-targets",
    );
    f.ctx.turnId = "three-targets";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const ranges = ["Data!A2:C3", "Blocked!A2:C4", "Inside!A2:C4"];
    for (const [i, range] of ranges.entries())
      expect(
        await f.execute(
          "workbook_analyze",
          { path: "book.xlsx", mode: "sort_preflight", range },
          `before-${i}`,
        ),
      ).toMatchObject({ status: "ok" });
    expect(
      await f.execute(
        "workbook_edit",
        {
          path: "book.xlsx",
          ops: [
            { op: "sort", range: ranges[0], header: false, keys: [{ column: 1, order: "desc" }] },
          ],
        },
        "actual-sort",
      ),
    ).toMatchObject({ status: "ok" });
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    for (const [i, range] of ranges.entries())
      await f.execute(
        "workbook_read",
        { path: "book.xlsx", mode: "range", range, facets: ["values", "formulas"] },
        `after-read-${i}`,
      );
    const receipt = await visibleProviderReceipt(f, "after-read-0");
    const selected = receipt!.candidates.items.find((item) => item.pointer === "/data/values/0/0")!;
    const args = { status: "complete" as const, sources: [{ refId: selected.refId }] };
    const stale = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(stale).toMatchObject({ status: "error" });
    expect(stale.error?.message).toContain("Blocked!A2:C4");
    expect(stale.error?.message).toContain("Inside!A2:C4");
    for (const [i, range] of ranges.entries())
      await f.execute(
        "workbook_analyze",
        { path: "book.xlsx", mode: "sort_preflight", range },
        `after-preflight-${i}`,
      );
    const result = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "Blocked",
      "Inside",
      "跨越排序数据边界",
      "位于排序数据区域内",
      "R3",
      "I3",
      "actual-sort",
      "本轮实际排序执行",
      "当前完整窗口已读取 values/formulas",
    ])
      expect(text).toContain(fragment);
    expect(text).not.toContain("但尚未执行排序");
  } finally {
    await f.close();
  }
});

test("delivery completeness keeps display and the unique explicit unit on the selected cell", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          { op: "cells.set", range: "Data!D4:E4", values: [["保存金额（万元）", 2.34567]] },
          { op: "style.set", range: "Data!E4", numFmt: "0.00" },
        ],
      },
      "display-edit",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000 },
    );
    await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!D4:E4",
        facets: ["values"],
      },
      "display-read",
    );
    const receipt = await visibleProviderReceipt(f, "display-read");
    const source = receipt!.candidates.items.find((item) => item.pointer === "/data/values/0/1")!;
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: source.refId }],
      },
      f.ctx,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("| Data!E4 | 2.34567 | 无／未提供 | 2.35 |");
    expect(text).toContain("Data!E4 ← Data!D4");
    expect(text).toContain("单位：万元");
  } finally {
    await f.close();
  }
});

test("delivery completeness keeps the original request distinct from the clipped companion range", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(
      join(f.dir, "allowed", "book1.xlsx"),
      Buffer.from(
        readFileSync(
          new URL("../../modules/workbook/test/fixtures/book1.xlsx.base64", import.meta.url),
          "utf8",
        ),
        "base64",
      ),
    );
    const run = scoped(f, { kind: "restricted", root: "allowed" });
    await run(() =>
      f.execute(
        "workbook_read",
        {
          path: "allowed/book1.xlsx",
          mode: "range",
          range: "Sheet1!A1:B2",
        },
        "clipped-companion",
      ),
    );
    const receipt = await visibleProviderReceipt(f, "clipped-companion");
    const source = receipt!.candidates.items.find((item) => item.pointer === "/data/values")!;
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [{ refId: source.refId }],
        },
        f.ctx,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("requestedRange=Sheet1!A1:B2");
    expect(text).toContain("returnedRange=Sheet1!A1");
    expect(text).toContain("clipped=true");
    expect(text).not.toContain("requestedRange=Sheet1!A1 ·");
  } finally {
    await f.close();
  }
});

test("delivery completeness includes current external target, both saved caches and codec limits even when only the formula is selected", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(
      join(f.dir, "allowed", "external-links.xlsx"),
      Buffer.from(
        readFileSync(
          new URL(
            "../../modules/workbook/test/fixtures/external-links.xlsx.base64",
            import.meta.url,
          ),
          "utf8",
        ),
        "base64",
      ),
    );
    const run = scoped(f, { kind: "restricted", root: "allowed" });
    await run(() =>
      f.execute(
        "workbook_read",
        {
          path: "allowed/external-links.xlsx",
          mode: "overview",
        },
        "external-overview",
      ),
    );
    await run(() =>
      f.execute(
        "workbook_read",
        {
          path: "allowed/external-links.xlsx",
          mode: "range",
          range: "Sheet1!B2",
          facets: ["formulas"],
        },
        "external-formula-only",
      ),
    );
    const receipt = await visibleProviderReceipt(f, "external-formula-only");
    const source = receipt!.candidates.items.find((item) => item.pointer === "/data/formulas")!;
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [{ refId: source.refId }],
        },
        f.ctx,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "book1.xlsx",
      "saved_worksheet",
      "saved_external_link",
      "formulaCoverage=explicit_formula_text_only",
      "totalFormulaCells=",
      "returnedFormulaCells=",
      "unresolvedSharedFormulaCells=",
      "不展开共享/数组跟随格",
      "实际访问路径另见本轮宿主记录",
    ])
      expect(text).toContain(fragment);
    // An overview's name is the workbook name, not a SQL table alias.
    expect.soft(text).not.toMatch(/SQL 表 [^\n]*external-links\.xlsx/);
    expect.soft(text).toContain("来源名称");
    // Formula and external-link caches have independent coverage flags.
    expect.soft(text).toMatch(/保存公式缓存覆盖：[^\n]*truncated=false/);
    expect.soft(text).toMatch(/保存外链缓存覆盖：[^\n]*truncated=false/);
  } finally {
    await f.close();
  }
});

async function fixture(sheetNames = ["Data"]) {
  const dir = mkdtempSync(join(tmpdir(), "numeric-finalizer-"));
  const db = openDb(join(dir, "db.sqlite"), [...KERNEL_MIGRATIONS, BACKUPS_MIGRATION]);
  db.prepare("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,'test',?,?)").run(
    "w",
    dir,
    new Date().toISOString(),
  );
  const module = workbookModule(db);
  for (const migration of module.migrations ?? []) db.exec(migration.sql);
  const documents = module.service;
  const log = new SessionLog(db, { projections: kernelProjections() });
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    sessionId: "s",
    agentId: "main",
    toolCallId: "setup",
    role: "main",
    signal: AbortSignal.timeout(60_000),
    reads: createReadTable(),
    backups: new BackupService(db).bind({
      workspaceId: "w",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
    }),
  };
  const tools = new Map(
    [...module.tools!, ...writableFilesModule(db, new BackupService(db)).tools!].map((tool) => [
      tool.name,
      tool,
    ]),
  );
  const sandbox = new SandboxPool({ size: 1 });
  tools.set("run_script", runScriptTool({ sandbox, documents, tools, db }));
  const present = interactionTools(log, new QuestionCoordinator(db, log), documents).find(
    (tool) => tool.name === "present",
  )!;
  async function execute(
    name: string,
    args: unknown,
    id: string,
    agentId = "main",
    sessionId = "s",
  ) {
    const tool = tools.get(name)!;
    const callContext = { ...ctx, toolCallId: id, agentId, sessionId };
    const fileMeta = name === "files" ? tool.intentMeta?.(args, callContext) : undefined;
    log.append(sessionId, agentId, [
      {
        type: "tool.intent",
        data: {
          stepId: "step",
          toolCallId: id,
          toolName: name,
          args,
          targets: [],
          replay: "safe",
          ...(fileMeta ? { intentMeta: fileMeta } : {}),
        },
      },
    ]);
    const result = await tool.execute(args, callContext);
    log.append(sessionId, agentId, [
      {
        type: "tool.result",
        data: { toolCallId: id, toolName: name, status: result.status, result },
      },
    ]);
    return result;
  }
  const edit = await execute(
    "workbook_edit",
    {
      path: "book.xlsx",
      create: true,
      sheetNames,
      ops: [
        {
          op: "cells.set",
          range: "Data!A1:B3",
          values: [
            ["Qty", "Amount"],
            [2, 12.5],
            [3, 25],
          ],
        },
        { op: "cells.set", range: "Data!C2", values: [["=SUM(B2:B3)"]] },
        { op: "style.set", range: "Data!C2", numFmt: "0.00" },
      ],
    },
    "create",
  );
  expect(edit, JSON.stringify(edit)).toMatchObject({ status: "ok" });
  const finalize = (sources: { toolCallId: string; pointer: string }[], status = "complete") =>
    finalizeNumericPointers(
      log,
      documents,
      { status, sources } as Parameters<typeof finalizeNumericPointers>[2],
      {
        ...ctx,
        toolCallId: "final",
      },
    );
  return {
    ctx,
    dir,
    db,
    documents,
    log,
    present,
    tools,
    execute,
    finalize,
    edit,
    async close() {
      await sandbox.close();
      await documents.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("present finalizes actual read-window cells with raw values, formulas and available display", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!B1:C3",
        offset: 1,
        facets: ["values", "formulas", "styles"],
      },
      "read",
    );
    expect(
      f.present.input.safeParse({
        finalize: {
          status: "complete",
          sources: [{ toolCallId: "read", pointer: "/data/values", value: 999 }],
        },
      }).success,
    ).toBe(false);
    expect(
      f.present.input.safeParse({ finalize: { status: "complete", sources: [] } }).success,
    ).toBe(false);
    const result = await f.finalize([{ toolCallId: "read", pointer: "/data/values" }]);
    expect(result.status).toBe("ok");
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("Data!B2");
    expect(text).toContain("12.5");
    expect(text).toContain("37.5");
    expect(text).toContain("=SUM(B2:B3)");
    expect(text).toContain("| Data!C2 | 37.5 | =SUM(B2:B3) | 37.50 |");
    expect(text).not.toContain("| Data!B1 |");
    expect(f.log.readAfter("s", 0, 100).some((record) => record.type === "ui.present")).toBe(false);
    expect(f.present.finalReply?.({ finalize: { status: "complete", sources: [] } }, result)).toBe(
      text,
    );
    const incomplete = await f.finalize([], "incomplete");
    expect(incomplete).toMatchObject({
      status: "ok",
      data: {
        finalizationStatus: "incomplete",
        finalText: expect.stringContaining("数值交付未完成"),
      },
    });
  } finally {
    await f.close();
  }
});

function scoped(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: { kind: "restricted"; root: string } | { kind: "unresolved"; reason: string },
  id = "scoped",
) {
  f.ctx.turnId = id;
  f.log.append("s", "main", [
    {
      type: "turn.started",
      data: {
        turnId: id,
        accessBinding: {
          originAgentId: "main",
          originTurnId: id,
          sourceDispatchIds: [],
          ruleVersion: 1,
          decision,
          accessDeliveryRequired: true,
        },
      },
    },
  ]);
  return <T>(action: () => T) =>
    runWithToolAccess(
      bindToolAccess({
        db: f.db,
        log: f.log,
        workspaceRoot: f.dir,
        sessionId: "s",
        agentId: "main",
        turnId: id,
        toolCallId: "scope-final",
      }),
      action,
    );
}

test("restricted string external-link evidence finishes with both real files and recorded final hash reads", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    for (const name of ["external-links.xlsx", "book1.xlsx"])
      writeFileSync(
        join(f.dir, "allowed", name),
        Buffer.from(
          readFileSync(
            new URL(`../../modules/workbook/test/fixtures/${name}.base64`, import.meta.url),
            "utf8",
          ),
          "base64",
        ),
      );
    const run = scoped(f, { kind: "restricted", root: "allowed" });
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/external-links.xlsx", mode: "objects" },
        "external-objects",
      ),
    );
    await run(() =>
      f.execute(
        "workbook_read",
        {
          path: "allowed/external-links.xlsx",
          mode: "range",
          range: "Sheet1!B2",
          facets: ["formulas"],
        },
        "external-formula",
      ),
    );
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/book1.xlsx", mode: "range", range: "Sheet1!A1" },
        "companion",
      ),
    );
    const receipt = await visibleProviderReceipt(f, "external-objects");
    const ref = numericRefId({
      toolCallId: "external-objects",
      pointer: "/data/preserved/externalLinkDetails",
    });
    expect(receipt?.candidates.items.some((item) => item.refId === ref)).toBe(true);
    expect(
      receipt?.candidates.items
        .filter((item) => item.pointer.startsWith("/data/preserved"))
        .map((item) => item.pointer),
    ).toEqual(["/data/preserved/externalLinkDetails"]);
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: ref },
            { refId: numericRefId({ toolCallId: "external-formula", pointer: "/data/formulas" }) },
            { refId: numericRefId({ toolCallId: "companion", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "ok",
      data: {
        finalizationStatus: "complete",
        deliveredFiles: [
          expect.objectContaining({ path: "allowed/external-links.xlsx" }),
          expect.objectContaining({ path: "allowed/book1.xlsx" }),
        ],
      },
    });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "=[1]Sheet1!$A$1",
      "hello world",
      "book1.xlsx",
      "saved_worksheet",
      "saved_external_link",
      "本轮实际访问",
      "allowed/external-links.xlsx",
      "allowed/book1.xlsx",
    ])
      expect(text).toContain(fragment);
    const facts = turnAccessFacts(f.db, { sessionId: "s", agentId: "main", turnId: f.ctx.turnId! });
    expect(
      facts.facts.some(
        (fact) => fact.purpose === "final-delivery-sha" && fact.outcome === "succeeded",
      ),
    ).toBe(true);
    const numericRun = scoped(f, { kind: "restricted", root: "allowed" }, "scoped-numeric");
    expect(
      await numericRun(() =>
        f.execute(
          "workbook_analyze",
          {
            path: "allowed/book1.xlsx",
            mode: "sql",
            range: "Sheet1!A1:A2",
            sql: "SELECT 1 AS amount",
          },
          "numeric-obligation",
        ),
      ),
    ).toMatchObject({ status: "ok" });
    await numericRun(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/book1.xlsx", mode: "range", range: "Sheet1!A1" },
        "numeric-string",
      ),
    );
    const numericResult = await numericRun(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "numeric-string", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(numericResult).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("没有实际数值") },
    });
  } finally {
    await f.close();
  }
});

test("unresolved scope cannot become complete or emit a file, and open access batches cannot complete", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2" },
      "before-scope",
    );
    const run = scoped(f, { kind: "unresolved", reason: "缺少明确目录" }, "unresolved");
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "before-scope", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { finalizationStatus: "incomplete", finalText: expect.stringContaining("请明确") },
    });
    expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(0);
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(join(f.dir, "allowed", "book.xlsx"), readFileSync(join(f.dir, "book.xlsx")));
    const restricted = scoped(f, { kind: "restricted", root: "allowed" }, "pending-audit");
    await restricted(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/book.xlsx", mode: "range", range: "Data!B2" },
        "scope-read",
      ),
    );
    f.log.append("s", "main", [
      {
        type: "access.batch",
        data: {
          batchId: "unfinished",
          turnId: f.ctx.turnId,
          originAgentId: "main",
          originTurnId: f.ctx.turnId,
          toolCallId: "audit",
          status: "started",
        },
      },
    ]);
    const incomplete = await restricted(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [{ refId: numericRefId({ toolCallId: "scope-read", pointer: "/data/values" }) }],
        },
        f.ctx,
      ),
    );
    expect(incomplete).toMatchObject({ status: "error" });
  } finally {
    await f.close();
  }
});

test("scoped real edit waits for its existing save and reports changed positions without refreshing external caches", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(
      join(f.dir, "allowed", "external-links.xlsx"),
      Buffer.from(
        readFileSync(
          new URL(
            "../../modules/workbook/test/fixtures/external-links.xlsx.base64",
            import.meta.url,
          ),
          "utf8",
        ),
        "base64",
      ),
    );
    const run = scoped(f, { kind: "restricted", root: "allowed" }, "scoped-edit");
    const edit = await run(() =>
      f.execute(
        "workbook_edit",
        {
          path: "allowed/external-links.xlsx",
          ops: [{ op: "cells.set", range: "Sheet1!C5", values: [[17]] }],
        },
        "scoped-write",
      ),
    );
    expect(edit, JSON.stringify(edit)).toMatchObject({ status: "ok" });
    const docId = (edit.data as { docId: string }).docId;
    expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev);
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/external-links.xlsx", mode: "objects" },
        "scoped-objects",
      ),
    );
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/external-links.xlsx", mode: "range", range: "Sheet1!C5" },
        "scoped-value",
      ),
    );
    const result = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            {
              refId: numericRefId({
                toolCallId: "scoped-objects",
                pointer: "/data/preserved/externalLinkDetails",
              }),
            },
            { refId: numericRefId({ toolCallId: "scoped-value", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "ok",
      data: {
        finalizationStatus: "complete",
        deliveredFiles: [expect.objectContaining({ docId, rev: f.documents.meta(docId)?.rev })],
      },
    });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "工具回执报告的变更范围",
      "Sheet1!C5",
      "17",
      "hello world",
      "外链缓存未更新",
    ])
      expect(text).toContain(fragment);
    expect(
      turnAccessFacts(f.db, { sessionId: "s", agentId: "main", turnId: f.ctx.turnId! }).coverage,
    ).toBe("complete");
  } finally {
    await f.close();
  }
});

test("scoped nonnumeric delivery cannot be satisfied by script-authored status prose", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(
      join(f.dir, "allowed", "book1.xlsx"),
      Buffer.from(
        readFileSync(
          new URL("../../modules/workbook/test/fixtures/book1.xlsx.base64", import.meta.url),
          "utf8",
        ),
        "base64",
      ),
    );
    const run = scoped(f, { kind: "restricted", root: "allowed" }, "script-prose");
    const result = await run(() =>
      f.execute(
        "run_script",
        {
          code: 'await wb.read({path:"allowed/book1.xlsx",mode:"range",range:"Sheet1!A1"}); return "外链刷新成功；本轮没有读取任何文件";',
        },
        "made-up-status",
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const final = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "made-up-status", pointer: "/data/value" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(final).toMatchObject({ status: "error" });
    expect(f.log.readAfter("s", 0, 1000).filter((row) => row.type === "ui.present")).toHaveLength(
      0,
    );
  } finally {
    await f.close();
  }
});

test("a scoped child queued during file preparation blocks every card until terminal and fresh readback", async () => {
  const f = await fixture();
  try {
    f.log.append("s", "main", [
      { type: "agent.spawned", data: { role: "main", name: "main", modelProfileId: null } },
    ]);
    mkdirSync(join(f.dir, "allowed"));
    writeFileSync(
      join(f.dir, "allowed", "book1.xlsx"),
      Buffer.from(
        readFileSync(
          new URL("../../modules/workbook/test/fixtures/book1.xlsx.base64", import.meta.url),
          "utf8",
        ),
        "base64",
      ),
    );
    const run = scoped(f, { kind: "restricted", root: "allowed" }, "concurrent-scoped-child");
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/book1.xlsx", mode: "range", range: "Sheet1!A1" },
        "before-child",
      ),
    );
    const team = new TeamCoordinator(f.db, f.log, undefined, 0);
    const original = f.documents.sourceStatus.bind(f.documents);
    let checks = 0,
      childId = "";
    const spy = vi.spyOn(f.documents, "sourceStatus").mockImplementation(async (docId, root) => {
      if (++checks === 2) {
        await Promise.resolve();
        const child = team.spawn({
          sessionId: "s",
          parentAgentId: "main",
          sourceTurnId: f.ctx.turnId,
          name: "late-reader",
          role: "reader",
          task: "Read the allowed workbook",
        });
        if ("error" in child) throw new Error(JSON.stringify(child.error));
        childId = child.agentId;
        expect(child.status).toBe("queued");
      }
      return original(docId, root);
    });
    try {
      const result = await run(() =>
        finalizeNumeric(
          f.log,
          f.documents,
          {
            status: "complete",
            sources: [
              { refId: numericRefId({ toolCallId: "before-child", pointer: "/data/values" }) },
            ],
          },
          f.ctx,
        ),
      );
      expect(checks).toBe(2);
      expect(result).toMatchObject({ status: "error" });
      expect(f.log.readAfter("s", 0, 1000).filter((row) => row.type === "ui.present")).toHaveLength(
        0,
      );
    } finally {
      spy.mockRestore();
    }
    const dispatched = f.db
      .prepare("SELECT id FROM dispatches WHERE session_id=? AND agent_id=?")
      .get("s", childId) as { id: string };
    const childBinding = createTurnAccessBinding(f.db, {
      sessionId: "s",
      agentId: childId,
      turnId: "late-turn",
      dispatchIds: [dispatched.id],
    });
    f.log.append("s", childId, [
      { type: "turn.started", data: { turnId: "late-turn", accessBinding: childBinding } },
      { type: "turn.completed", data: { turnId: "late-turn", reason: "stop" } },
      { type: "dispatch.updated", data: { dispatchId: dispatched.id, status: "applied" } },
    ]);
    await run(() =>
      f.execute(
        "workbook_read",
        { path: "allowed/book1.xlsx", mode: "range", range: "Sheet1!A1" },
        "after-child",
      ),
    );
    const done = await run(() =>
      finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "after-child", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      ),
    );
    expect(done, JSON.stringify(done)).toMatchObject({
      status: "ok",
      data: {
        finalizationStatus: "complete",
        deliveredFiles: [expect.objectContaining({ path: "allowed/book1.xlsx" })],
      },
    });
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "scoped finalization cannot omit a pending workbook from its own origin, other origin=%s",
  async (otherOrigin) => {
    const f = await fixture();
    let restore: (() => void) | undefined;
    try {
      mkdirSync(join(f.dir, "allowed"));
      for (const name of ["A", "B"])
        writeFileSync(
          join(f.dir, "allowed", `${name}.xlsx`),
          readFileSync(join(f.dir, "book.xlsx")),
        );
      const opened = await f.documents.open("w", f.dir, "allowed/A.xlsx");
      const entry = await f.documents.entry(opened.meta.id, f.dir);
      const waitCalc = entry.live.boot.waitCalc,
        callback = entry.live.capture.onEngineResults;
      restore = () => {
        entry.live.boot.waitCalc = waitCalc;
        entry.live.capture.onEngineResults = callback;
      };
      // Hold the real calculation boundary, not the returned receipt or finalizer state.
      entry.live.boot.waitCalc = async () => false;
      entry.live.capture.onEngineResults = undefined;
      const writeRun = scoped(
        f,
        { kind: "restricted", root: "allowed" },
        "pending-workbook-origin",
      );
      expect(
        await writeRun(() =>
          f.execute(
            "workbook_edit",
            { path: "allowed/A.xlsx", ops: [{ op: "recalculate" }] },
            "pending-A",
          ),
        ),
      ).toMatchObject({ status: "ok" });
      expect(entry.meta.calcPending).toBe(true);
      const run = otherOrigin
        ? scoped(f, { kind: "restricted", root: "allowed" }, "other-workbook-origin")
        : writeRun;
      await run(() =>
        f.execute(
          "workbook_read",
          { path: "allowed/B.xlsx", mode: "range", range: "Data!B2" },
          "only-B",
        ),
      );
      const final = await run(() =>
        finalizeNumeric(
          f.log,
          f.documents,
          {
            status: "complete",
            sources: [{ refId: numericRefId({ toolCallId: "only-B", pointer: "/data/values" }) }],
          },
          f.ctx,
        ),
      );
      expect(final, JSON.stringify(final)).toMatchObject({ status: otherOrigin ? "ok" : "error" });
      expect(entry.meta.calcPending).toBe(true);
      if (!otherOrigin) {
        expect(
          f.log.readAfter("s", 0, 1000).filter((row) => row.type === "ui.present"),
        ).toHaveLength(0);
        restore();
        expect(
          await run(() =>
            f.execute(
              "workbook_edit",
              { path: "allowed/A.xlsx", ops: [{ op: "recalculate" }] },
              "settle-A",
            ),
          ),
        ).toMatchObject({ status: "ok" });
        await vi.waitFor(
          () => {
            expect(entry.meta.calcPending).not.toBe(true);
            expect(entry.meta.checkpointRev).toBe(entry.meta.rev);
          },
          { timeout: 5000, interval: 50 },
        );
        await run(() =>
          f.execute(
            "workbook_read",
            { path: "allowed/B.xlsx", mode: "range", range: "Data!B2" },
            "saved-B",
          ),
        );
        expect(
          await run(() =>
            finalizeNumeric(
              f.log,
              f.documents,
              {
                status: "complete",
                sources: [
                  { refId: numericRefId({ toolCallId: "saved-B", pointer: "/data/values" }) },
                ],
              },
              f.ctx,
            ),
          ),
        ).toMatchObject({ status: "ok", data: { finalizationStatus: "complete" } });
      }
    } finally {
      restore?.();
      await f.close();
    }
  },
);

test("finalizer rejects invisible, superseded, failed, arbitrary and stale evidence", async () => {
  const f = await fixture();
  try {
    const args = { path: "book.xlsx", mode: "range", range: "Data!A1:C3" };
    await f.execute("workbook_read", args, "other-agent", "worker");
    await f.execute("workbook_read", args, "other-session", "main", "elsewhere");
    await f.execute("workbook_read", { ...args, path: "missing.xlsx" }, "failed");
    await f.execute("workbook_read", args, "read");
    for (const id of ["other-agent", "other-session", "failed", "unknown"]) {
      expect(await f.finalize([{ toolCallId: id, pointer: "/data/values" }])).toMatchObject({
        status: "error",
        error: { code: "INVALID_ARGUMENT" },
      });
    }
    for (const pointer of ["/data/values/99", "/data/docId", "/__proto__", "/data/values/00"]) {
      expect(await f.finalize([{ toolCallId: "read", pointer }])).toMatchObject({
        status: "error",
        error: { code: "INVALID_ARGUMENT" },
      });
    }
    const read = f.db
      .prepare(
        "SELECT from_seq FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')='read'",
      )
      .get() as { from_seq: number };
    f.log.append("s", "main", [
      { type: "history.rewound", data: { fromSeq: read.from_seq, dispatchId: "rewound" } },
    ]);
    expect(await f.finalize([{ toolCallId: "read", pointer: "/data/values" }])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    await f.execute("workbook_read", args, "old");
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [{ op: "cells.set", range: "Data!A2", values: [[4]] }],
      },
      "change",
    );
    expect(await f.finalize([{ toolCallId: "old", pointer: "/data/values" }])).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
    await f.execute("workbook_read", args, "external");
    const path = join(f.dir, "book.xlsx");
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from("external")]));
      expect(await f.finalize([{ toolCallId: "external", pointer: "/data/values" }])).toMatchObject(
        { status: "error", error: { code: "VERSION_CONFLICT" } },
      );
    } finally {
      writeFileSync(path, original);
    }
  } finally {
    await f.close();
  }
});

test("SQL receipts carry actual normalized SQL and all input sources for final rendering", async () => {
  const f = await fixture();
  try {
    const result = await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "sql",
        range: "Data!A1:B3",
        sql: "SELECT SUM(Amount) AS total FROM {{sheet}}",
      },
      "sql",
    );
    expect(result).toMatchObject({
      status: "ok",
      data: {
        sql: "SELECT SUM(Amount) AS total FROM data",
        sources: [
          { name: "data", path: "book.xlsx", range: "Data!A1:B3", rev: expect.any(Number) },
        ],
      },
    });
    const finalized = await f.finalize([{ toolCallId: "sql", pointer: "/data/rows" }]);
    expect(finalized.status).toBe("ok");
    const text = (finalized.data as { finalText: string }).finalText;
    expect(text).toContain("SELECT SUM(Amount)");
    expect(text).toContain("total");
    expect(text).toContain("37.5");
    expect(text).toContain("Data!A1:B3");
  } finally {
    await f.close();
  }
});

test("script records real read-only provenance and never borrows published revisions for old reads", async () => {
  const f = await fixture();
  try {
    const code = `const r = await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"}); return {total:r.data.values.reduce((a,b)=>a+b[0],0),provenance:{docId:"fake"}};`;
    const result = await f.execute("run_script", { code }, "script");
    const docId = (f.edit.data as { docId: string }).docId;
    const rev = f.documents.meta(docId)!.rev;
    expect(result).toMatchObject({
      status: "ok",
      docRevs: { [docId]: rev },
      data: {
        provenance: { code, reads: [{ toolName: "workbook_read", docRevs: { [docId]: rev } }] },
      },
    });
    const final = await f.finalize([{ toolCallId: "script", pointer: "/data/value/total" }]);
    expect(final).toMatchObject({
      status: "ok",
      data: { finalText: expect.stringContaining("37.5") },
    });
    await f.execute(
      "run_script",
      { code: "return { total: 99, provenance: { reads: [{}] } };" },
      "fake",
    );
    expect(await f.finalize([{ toolCallId: "fake", pointer: "/data/value/total" }])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    const mixedCode = `const r = await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"}); await wb.edit({path:"book.xlsx",ops:[{op:"cells.set",range:"Data!B2",values:[[99]]}]}); return r.data.values[0][0];`;
    f.ctx.requestApproval = async () => ({ decision: "approved" });
    const mixed: ToolResult = await f.execute("run_script", { code: mixedCode }, "mixed");
    expect(mixed).toMatchObject({
      status: "ok",
      data: {
        provenance: { reads: [{ docRevs: { [docId]: rev } }] },
      },
    });
    expect(mixed.docRevs?.[docId]).toBeGreaterThan(rev);
    expect(await f.finalize([{ toolCallId: "mixed", pointer: "/data/value" }])).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
  } finally {
    await f.close();
  }
});

test("finalizer refuses a truncated SQL table rather than calling its preview complete", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "sql",
        range: "Data!A1:B3",
        sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<201) SELECT x FROM n",
      },
      "large",
    );
    expect(await f.finalize([{ toolCallId: "large", pointer: "/data/rows" }])).toMatchObject({
      status: "error",
      error: {
        code: "LIMIT_EXCEEDED",
        message: expect.stringContaining("reason=incomplete_window"),
      },
    });
    expect(await f.finalize([{ toolCallId: "large", pointer: "/data/rows/0/0" }])).toMatchObject({
      status: "ok",
      data: { finalText: expect.stringContaining("不代表原请求的全部数据") },
    });
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!A1:C100",
            values: Array.from({ length: 100 }, (_, i) => [i, i, i]),
          },
        ],
      },
      "many-values",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000, interval: 50 },
    );
    const read = await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!A1:C100",
      },
      "many-cells",
    );
    expect(read.status).toBe("ok");
    expect(await f.finalize([{ toolCallId: "many-cells", pointer: "/data/values" }])).toMatchObject(
      {
        status: "ok",
        data: { finalizationStatus: "complete", presentationOverflow: { cells: true } },
      },
    );
    const catalog = numericEvidence("many-cells", "workbook_read", read)!;
    expect(catalog.candidates.truncated).toBe(true);
    const absent = "/data/values/99/2";
    expect(catalog.candidates.items.some((c) => c.pointer === absent)).toBe(false);
    const invalidRef = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: numericRefId({ toolCallId: "many-cells", pointer: absent }) }],
      },
      f.ctx,
    );
    expect(invalidRef).toMatchObject({
      status: "error",
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining('"pointer":"/data/values/99/2"'),
      },
    });
    expect(invalidRef.error?.message).toContain("shownCandidatesTruncated=true");
    expect(invalidRef.error?.message).toContain("不要构造或改写 refId");
    const small = await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!A98:C100",
      },
      "small-window",
    );
    const validRef = numericEvidence("small-window", "workbook_read", small)!.candidates.items.find(
      (c) => c.pointer === "/data/values",
    )!.refId;
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [{ refId: validRef }],
        },
        f.ctx,
      ),
    ).toMatchObject({ status: "ok", data: { finalizationStatus: "complete" } });
  } finally {
    await f.close();
  }
});

test("complete finalization needs a numeric value, not a profile label or script prose", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "profile",
        range: "Data!A1:B3",
      },
      "profile",
    );
    expect(
      await f.finalize([{ toolCallId: "profile", pointer: "/data/columns/0/name" }]),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(
      await f.finalize([{ toolCallId: "profile", pointer: "/data/columns/1/sum" }]),
    ).toMatchObject({ status: "ok", data: { finalText: expect.stringContaining("37.5") } });
    expect(
      await f.finalize([{ toolCallId: "create", pointer: "/data/formulaValues" }]),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
  } finally {
    await f.close();
  }
});

test("read evidence distinguishes true blanks, empty strings, zero and leading-zero text", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!D3:G3",
            values: [[null, "", 0, "00017"]],
          },
        ],
      },
      "typed",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000, interval: 50 },
    );
    await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!D1:G3",
        offset: 2,
      },
      "typed-read",
    );
    const result = await f.finalize([{ toolCallId: "typed-read", pointer: "/data/values" }]);
    expect(result.status).toBe("ok");
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("| Data!D3 | 真空白");
    expect(text).toContain('| Data!E3 | ""');
    expect(text).toContain("| Data!F3 | 0");
    expect(text).toContain('| Data!G3 | "00017"');
    expect(text).not.toContain("| Data!D3 | null");
  } finally {
    await f.close();
  }
});

test("multi-source finalization rechecks earlier revisions after all async source checks", async () => {
  const f = await fixture();
  try {
    const other = await f.execute(
      "workbook_edit",
      {
        path: "other.xlsx",
        create: true,
        sheetNames: ["Other"],
        ops: [{ op: "cells.set", range: "Other!A1:A2", values: [["factor"], [2]] }],
      },
      "other",
    );
    const otherId = (other.data as { docId: string }).docId;
    await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "sql",
        range: "Data!A1:B3",
        sources: [{ name: "extra", path: "other.xlsx", range: "Other!A1:A2" }],
        sql: "SELECT SUM(Amount) * MAX(factor) AS total FROM data CROSS JOIN extra",
      },
      "joined",
    );
    const original = f.documents.sourceStatus.bind(f.documents);
    let changed = false;
    const check = vi.spyOn(f.documents, "sourceStatus").mockImplementation(async (docId, root) => {
      if (docId === otherId && !changed) {
        changed = true;
        await f.execute(
          "workbook_edit",
          {
            path: "book.xlsx",
            ops: [{ op: "cells.set", range: "Data!B2", values: [[100]] }],
          },
          "concurrent-change",
        );
      }
      return original(docId, root);
    });
    try {
      expect(await f.finalize([{ toolCallId: "joined", pointer: "/data/rows" }])).toMatchObject({
        status: "error",
        error: { code: "VERSION_CONFLICT" },
      });
      expect(changed).toBe(true);
    } finally {
      check.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("finalizer refuses log-only values hidden by context truncation and survives projection rebuild", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "run_script",
      {
        code: `const r=await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"});return {total:r.data.values[0][0],padding:"x".repeat(20000)};`,
      },
      "hidden",
    );
    expect(
      await f.finalize([{ toolCallId: "hidden", pointer: "/data/value/total" }]),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!B2:B3",
      },
      "visible",
    );
    f.log.rebuild("s");
    expect(await f.finalize([{ toolCallId: "visible", pointer: "/data/values" }])).toMatchObject({
      status: "ok",
      data: { finalizationStatus: "complete" },
    });
  } finally {
    await f.close();
  }
});

test("a read taken during an external file conflict is not current delivery evidence", async () => {
  const f = await fixture();
  const path = join(f.dir, "book.xlsx");
  const original = readFileSync(path);
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [{ op: "cells.set", range: "Data!B2", values: [[40]] }],
      },
      "pending-edit",
    );
    writeFileSync(path, Buffer.concat([original, Buffer.from("external")]));
    const read = await f.execute(
      "workbook_read",
      {
        path: "book.xlsx",
        mode: "range",
        range: "Data!B2:B3",
      },
      "conflicted",
    );
    expect(read.status).toBe("ok");
    expect(f.documents.meta((read.data as { docId: string }).docId)?.externalConflict).toBe(true);
    expect(await f.finalize([{ toolCallId: "conflicted", pointer: "/data/values" }])).toMatchObject(
      { status: "error", error: { code: "VERSION_CONFLICT" } },
    );
  } finally {
    writeFileSync(path, original);
    await f.close();
  }
});

test("finalizer binds visible cell labels and explicit units without accepting free-form units", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!D1:E3",
            values: [
              ["项目", "金额（元）"],
              ["明细行数", 2],
              ["合计（万元）", 0.00375],
            ],
          },
        ],
      },
      "labels",
    );
    await vi.waitFor(
      () => {
        const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
        expect(meta.checkpointRev).toBe(meta.rev);
      },
      { timeout: 5000, interval: 50 },
    );
    const read = await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!D1:E3" },
      "labels-read",
    );
    const refs = (pointer: string) => numericRefId({ toolCallId: "labels-read", pointer });
    const binding = {
      valueRefId: refs("/data/values/2/1"),
      labelRefId: refs("/data/values/2/0"),
      relation: "same_row" as const,
    };
    expect(numericEvidence("labels-read", "workbook_read", read)).toMatchObject({
      bindingCandidates: { items: expect.arrayContaining([expect.objectContaining(binding)]) },
    });
    const providerReceipt = (await visibleProviderReceipt(f, "labels-read"))!;
    const choice = providerReceipt.bindingCandidates.items.find(
      (item) => item.valueRefId === binding.valueRefId && item.labelRefId === binding.labelRefId,
    )!;
    const args = {
      status: "complete" as const,
      sources: [{ refId: binding.valueRefId }],
      bindings: [{ bindingId: choice.bindingId }],
    };
    const result = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("合计（万元）");
    expect(text).toContain("Data!D3");
    expect(text).toContain("单位：万元");
    expect(f.present.input.safeParse({ finalize: { ...args, unit: "美元" } }).success).toBe(false);
    expect(f.present.input.safeParse({ finalize: { ...args, bindings: [binding] } }).success).toBe(
      false,
    );
    const wrong = {
      ...args,
      bindings: [
        {
          bindingId: numericBindingId({
            toolCallId: "labels-read",
            valuePointer: "/data/values/2/1",
            labelPointer: "/data/values/0/0",
            relation: "same_row",
          }),
        },
      ],
    };
    expect(await finalizeNumeric(f.log, f.documents, wrong, f.ctx)).toMatchObject({
      status: "error",
    });
  } finally {
    await f.close();
  }
});

test("bounded medium label catalog reserves usable binding pairs and reports their coverage", async () => {
  const f = await fixture();
  try {
    const headers = Array.from({ length: 12 }, (_, c) => `项目${c}（万元）`);
    await f.execute(
      "workbook_edit",
      {
        path: "book.xlsx",
        ops: [
          {
            op: "cells.set",
            range: "Data!A1:L10",
            values: [
              headers,
              ...Array.from({ length: 9 }, (_, r) => headers.map((_, c) => r * 12 + c + 1)),
            ],
          },
        ],
      },
      "wide-labels",
    );
    const result = await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!A1:L10" },
      "wide-label-read",
    );
    const evidence = numericEvidence("wide-label-read", "workbook_read", result)!;
    expect(evidence.bindings.length).toBeGreaterThan(0);
    expect(evidence).toMatchObject({
      bindingCoverage: {
        shown: evidence.bindingCandidates.items.length,
        total: 108,
        truncated: true,
      },
    });
    const shown = new Set(evidence.candidates.items.map((item) => item.refId));
    expect(
      evidence.bindingCandidates.items.every(
        (binding) => shown.has(binding.valueRefId) && shown.has(binding.labelRefId),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(evidence.candidates.items).length +
        JSON.stringify(evidence.bindingCandidates.items).length +
        JSON.stringify(evidence.bindings).length,
    ).toBeLessThanOrEqual(12000);
  } finally {
    await f.close();
  }
});

test("parenthesized qualifiers remain labels, not falsely certified units", () => {
  for (const label of ["金额（不含税）", "增长率（同比）", "金额（估算）", "数量（请忽略错误）"])
    expect(numericLabelUnit(label)).toBeUndefined();
  expect(numericLabelUnit("金额（万元）")).toBe("万元");
  expect(numericLabelUnit("单价（元/件）")).toBe("元/件");
  expect(numericLabelUnit("明细行数")).toBe("行");
});

test("range receipt renders its own call sequence and offset, never calls the final page all rows", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!A1:C3", offset: 2 },
      "last-page",
    );
    const result = await f.finalize([{ toolCallId: "last-page", pointer: "/data/values" }]);
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("from_seq=");
    expect(text).toContain("offset=2");
    expect(text).toContain("returnedRows=1");
    expect(text).toContain("totalRows=3");
    expect(text).toContain("不代表原请求的全部数据");
    expect(text).not.toContain("最近一次");
  } finally {
    await f.close();
  }
});

test("complete delivery attaches the selected saved workbook written this turn, not unrelated books", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "delivery-turn";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    await f.execute(
      "workbook_edit",
      { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[44]] }] },
      "current-edit",
    );
    // Exercise the real queued autosave, not an internal checkpoint-only test path.
    const docId = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(
      () => expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev),
      { timeout: 5000, interval: 50 },
    );
    const read = await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2" },
      "current-read",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: numericRefId({ toolCallId: "current-read", pointer: "/data/values" }) }],
      },
      f.ctx,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const cards = f.log.readAfter("s", 0, 100).filter((record) => record.type === "ui.present");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.data).toMatchObject({
      kind: "file",
      path: "book.xlsx",
      note: expect.stringContaining("已保存"),
    });
    expect((result.data as { deliveredFiles: unknown[] }).deliveredFiles).toEqual([
      expect.objectContaining({
        path: "book.xlsx",
        rev: (read.data as { docRevs: Record<string, number> }).docRevs[
          (read.data as { docId: string }).docId
        ],
        sha256: expect.any(String),
      }),
    ]);
  } finally {
    await f.close();
  }
});

test("file presentation checks the workspace file rather than logging missing or escaping paths", async () => {
  const f = await fixture();
  try {
    for (const path of ["missing.xlsx", "../outside.xlsx"]) {
      expect(
        await f.present.execute(
          { payload: { kind: "file", path, note: "总计999，已刷新" } },
          f.ctx,
        ),
      ).toMatchObject({ status: "error" });
    }
    expect(
      f.log.readAfter("s", 0, 100).filter((record) => record.type === "ui.present"),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("ordinary file cards canonicalize in-workspace symlinks just like the download route", async () => {
  const f = await fixture();
  try {
    symlinkSync("book.xlsx", join(f.dir, "alias.xlsx"));
    const result = await f.present.execute(
      { payload: { kind: "file", path: "alias.xlsx" } },
      f.ctx,
    );
    expect(result).toMatchObject({ status: "ok", data: { verifiedFile: { path: "book.xlsx" } } });
    expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("SQL saveTo host publication delivers the selected output after a real readback", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "sql-save";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const saved = await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "sql",
        range: "Data!A1:B3",
        sql: "SELECT SUM(Amount) AS Total FROM data",
        saveTo: { path: "output.xlsx", sheet: "Summary" },
      },
      "sql-save",
    );
    expect(saved).toMatchObject({
      status: "ok",
      data: { saved: { path: "output.xlsx", docId: expect.any(String), rev: 0 } },
    });
    await f.execute(
      "workbook_read",
      { path: "output.xlsx", mode: "range", range: "Summary!A1:A2" },
      "saved-read",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: numericRefId({ toolCallId: "saved-read", pointer: "/data/values" }) }],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { deliveredFiles: [expect.objectContaining({ path: "output.xlsx", rev: 0 })] },
    });
    expect(
      f.log
        .readAfter("s", 0, 100)
        .filter((row) => row.type === "ui.present")
        .map((row) => (row.data as { path: string }).path),
    ).toEqual(["output.xlsx"]);
  } finally {
    await f.close();
  }
});

test("SQL saveTo a new sheet delivers the current workbook without inventing a saved.path field", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "sql-save-sheet";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const saved = await f.execute(
      "workbook_analyze",
      {
        path: "book.xlsx",
        mode: "sql",
        range: "Data!A1:B3",
        sql: "SELECT SUM(Amount) AS Total FROM data",
        saveTo: { sheet: "Summary" },
      },
      "save-sheet",
    );
    expect(saved).toMatchObject({
      status: "ok",
      data: { saved: { docId: expect.any(String), rev: 2 } },
    });
    expect((saved.data as { saved: { path?: string } }).saved.path).toBeUndefined();
    const docId = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(
      () => expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev),
      { timeout: 5000, interval: 50 },
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Summary!A1:A2" },
      "sheet-read",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: numericRefId({ toolCallId: "sheet-read", pointer: "/data/values" }) }],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { deliveredFiles: [expect.objectContaining({ path: "book.xlsx", rev: 2 })] },
    });
    expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("all source revisions are rechecked after asynchronous file preparation and before any card", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "concurrent-delivery";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const output = await f.execute(
      "workbook_edit",
      {
        path: "output.xlsx",
        create: true,
        sheetNames: ["Summary"],
        ops: [{ op: "cells.set", range: "Summary!A1:A2", values: [["Total"], [37.5]] }],
      },
      "create-output",
    );
    const outputId = (output.data as { docId: string }).docId;
    await vi.waitFor(
      () => expect(f.documents.meta(outputId)?.checkpointRev).toBe(f.documents.meta(outputId)?.rev),
      { timeout: 5000, interval: 50 },
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2:B3" },
      "input-read",
    );
    await f.execute(
      "workbook_read",
      { path: "output.xlsx", mode: "range", range: "Summary!A2" },
      "output-read",
    );
    const original = f.documents.sourceStatus.bind(f.documents);
    let outputChecks = 0;
    const spy = vi.spyOn(f.documents, "sourceStatus").mockImplementation(async (docId, root) => {
      if (docId === outputId && ++outputChecks === 2)
        await f.execute(
          "workbook_edit",
          { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[999]] }] },
          "concurrent-input-edit",
        );
      return original(docId, root);
    });
    try {
      const result = await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: ["input-read", "output-read"].map((toolCallId) => ({
            refId: numericRefId({ toolCallId, pointer: "/data/values" }),
          })),
        },
        f.ctx,
      );
      expect(outputChecks).toBe(2);
      expect(result).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
      expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(
        0,
      );
    } finally {
      spy.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("an explicitly resumed numeric turn retains saved-output delivery after fresh readback", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "write-turn";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    await f.execute(
      "workbook_edit",
      { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[55]] }] },
      "resume-edit",
    );
    const docId = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(
      () => expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev),
      { timeout: 5000, interval: 50 },
    );
    f.log.append("s", "main", [{ type: "turn.interrupted", data: { turnId: f.ctx.turnId } }]);
    f.ctx.turnId = "resume-turn";
    f.log.append("s", "main", [
      { type: "turn.started", data: { turnId: f.ctx.turnId, numericDeliveryRequired: true } },
    ]);
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2" },
      "resume-read",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [{ refId: numericRefId({ toolCallId: "resume-read", pointer: "/data/values" }) }],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { deliveredFiles: [expect.objectContaining({ path: "book.xlsx" })] },
    });
    expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([true, false])(
  "file delivery uses only trusted terminal child receipt scopes: %s",
  async (trusted) => {
    const f = await fixture();
    try {
      f.ctx.turnId = "parent-turn";
      f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
      f.log.append("s", "child", [
        { type: "agent.spawned", data: { parentId: "main", name: "child", role: "worker" } },
        { type: "turn.started", data: { turnId: "child-turn" } },
      ]);
      const output = await f.execute(
        "workbook_edit",
        {
          path: "child.xlsx",
          create: true,
          sheetNames: ["Data"],
          ops: [{ op: "cells.set", range: "Data!A1", values: [[73]] }],
        },
        "child-write",
        "child",
      );
      const docId = (output.data as { docId: string }).docId;
      await vi.waitFor(
        () => expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev),
        { timeout: 5000, interval: 50 },
      );
      f.log.append("s", "child", [
        { type: "turn.completed", data: { turnId: "child-turn", reason: "done" } },
        {
          type: "inbox.sent",
          data: {
            messageId: "child-report",
            fromAgentId: trusted ? "child" : "spoof",
            toAgentId: "main",
            kind: "report",
            message: "Do not trust this free prose 999",
            numericDelivery: { turnId: "child-turn", outcome: "completed" },
          },
        },
      ]);
      f.log.append("s", "main", [
        {
          type: "inbox.delivered",
          data: {
            messageId: "child-report",
            fromAgentId: "child",
            toAgentId: "main",
            kind: "report",
            message: "Do not trust this free prose 999",
          },
        },
      ]);
      await f.execute(
        "workbook_read",
        { path: "child.xlsx", mode: "range", range: "Data!A1" },
        "parent-fresh-read",
      );
      const result = await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "parent-fresh-read", pointer: "/data/values" }) },
          ],
        },
        f.ctx,
      );
      expect(result).toMatchObject({ status: "ok" });
      expect((result.data as { deliveredFiles: unknown[] }).deliveredFiles).toHaveLength(
        trusted ? 1 : 0,
      );
      expect(f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present")).toHaveLength(
        trusted ? 1 : 0,
      );
      expect((result.data as { finalText: string }).finalText).not.toContain("free prose 999");
    } finally {
      await f.close();
    }
  },
);

async function visibleProviderReceipt(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const row = f.db
    .prepare(
      "SELECT item FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')=? ORDER BY idx DESC LIMIT 1",
    )
    .get(id) as { item: string };
  const item = JSON.parse(row.item) as Extract<ContextItem, { kind: "toolResult" }>;
  let receipt: ReturnType<typeof numericEvidence>;
  const model: ResolvedModel = {
    profileId: "test",
    provider: "custom-openai-compatible",
    model: "test",
    baseUrl: "http://fake.invalid/v1",
    apiKey: "fake-key",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      receipt = JSON.parse(
        body.messages.find((message) => message.role === "tool")!.content,
      ).numericEvidence;
      return new Response(
        `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  for await (const event of createGateway().step({
    model,
    history: [
      { kind: "user", text: "只读报告" },
      { kind: "assistant", toolCalls: [{ id, name: item.toolName, args: {} }] },
      item,
    ],
    signal: AbortSignal.timeout(10000),
  }))
    expect(event.kind).not.toBe("error");
  return receipt;
}

test("real objects and range provider content can finalize a read-only pivot report and deliver the unchanged original", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from(
      readFileSync(
        new URL("../../modules/workbook/test/fixtures/pivot-slicer.xlsx.base64", import.meta.url),
        "utf8",
      ),
      "base64",
    );
    writeFileSync(join(f.dir, "pivot.xlsx"), bytes);
    f.ctx.turnId = "read-only-report";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    await f.execute("workbook_read", { path: "pivot.xlsx", mode: "objects" }, "objects");
    await f.execute(
      "workbook_read",
      { path: "pivot.xlsx", mode: "range", range: "Sheet1!G14:L20" },
      "pivot-read",
    );
    const objects = await visibleProviderReceipt(f, "objects"),
      range = await visibleProviderReceipt(f, "pivot-read");
    expect(objects?.sources).toEqual([
      { refId: numericRefId({ toolCallId: "objects", pointer: "/data/reportFacts" }) },
    ]);
    expect(objects?.candidates.items.every((item) => item.pointer === "/data/reportFacts")).toBe(
      true,
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      { status: "complete", sources: [...objects!.sources, ...range!.sources] },
      f.ctx,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "ok",
      data: { deliveredFiles: [expect.objectContaining({ path: "pivot.xlsx", rev: 0 })] },
    });
    const text = (result.data as { finalText: string }).finalText;
    for (const fragment of [
      "保存的透视显示总计",
      "Sheet1!L20 = 13",
      "PivotTable1",
      "USA",
      "A1:E10",
      "尚未暴露",
      "需要 Excel",
      "未实际刷新",
      "from_seq=",
    ])
      expect(text).toContain(fragment);
    expect(readFileSync(join(f.dir, "pivot.xlsx"))).toEqual(bytes);
    expect(
      f.log
        .readAfter("s", 0, 100)
        .filter((row) => row.type === "ui.present")
        .map((row) => (row.data as { path: string }).path),
    ).toEqual(["pivot.xlsx"]);
  } finally {
    await f.close();
  }
});

test("host preflight is explanation-only and metadata digits cannot substitute for actual numeric evidence", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_analyze",
      { path: "book.xlsx", mode: "sort_preflight", range: "Data!A2:B3" },
      "preflight",
    );
    const preflight = await visibleProviderReceipt(f, "preflight");
    expect(preflight?.candidates.items.map((item) => item.pointer)).toEqual([
      "/data/sortPreflight",
    ]);
    const only = [
      { refId: numericRefId({ toolCallId: "preflight", pointer: "/data/sortPreflight" }) },
    ];
    expect(
      await finalizeNumeric(f.log, f.documents, { status: "complete", sources: only }, f.ctx),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2:B3" },
      "values",
    );
    const result = await finalizeNumeric(
      f.log,
      f.documents,
      {
        status: "complete",
        sources: [
          ...only,
          { refId: numericRefId({ toolCallId: "values", pointer: "/data/values" }) },
        ],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { finalText: expect.stringContaining("本次只读预检未执行排序") },
    });
    await f.execute("workbook_read", { path: "book.xlsx", mode: "objects" }, "plain-objects");
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "plain-objects", pointer: "/data/reportFacts" }) },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
    expect(
      await finalizeNumeric(
        f.log,
        f.documents,
        {
          status: "complete",
          sources: [
            { refId: numericRefId({ toolCallId: "plain-objects", pointer: "/data/preserved" }) },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ status: "error" });
  } finally {
    await f.close();
  }
});

test("file notes cannot bypass the report and an old revision card cannot satisfy current delivery", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "file-revisions";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const first = await f.present.execute(
      { payload: { kind: "file", path: "book.xlsx", note: "总计999且已刷新，未访问其它路径" } },
      f.ctx,
    );
    expect(first).toMatchObject({ status: "ok" });
    await f.execute(
      "workbook_edit",
      { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[50]] }] },
      "new-rev",
    );
    const docId = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(
      () => expect(f.documents.meta(docId)?.checkpointRev).toBe(f.documents.meta(docId)?.rev),
      { timeout: 5000, interval: 50 },
    );
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2" },
      "new-rev-read",
    );
    const args = {
      status: "complete" as const,
      sources: [{ refId: numericRefId({ toolCallId: "new-rev-read", pointer: "/data/values" }) }],
    };
    expect(await finalizeNumeric(f.log, f.documents, args, f.ctx)).toMatchObject({ status: "ok" });
    let cards = f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.data).not.toEqual(cards[1]?.data);
    expect(JSON.stringify(cards)).not.toContain("总计999");
    expect(JSON.stringify(cards)).not.toContain("未访问其它路径");
    expect(await finalizeNumeric(f.log, f.documents, args, f.ctx)).toMatchObject({ status: "ok" });
    cards = f.log.readAfter("s", 0, 100).filter((row) => row.type === "ui.present");
    expect(cards).toHaveLength(2);
  } finally {
    await f.close();
  }
});

async function roundSevenSummaryFixture(values: (string | number)[][]) {
  const f = await fixture();
  f.ctx.turnId = "round-seven-summary";
  f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
  const endCol = String.fromCharCode(69 + values[0]!.length - 1);
  const range = `Data!E1:${endCol}${values.length}`;
  await f.execute("workbook_edit", {
    path: "book.xlsx",
    ops: [{ op: "cells.set", range, values }],
  }, "summary-write");
  await vi.waitFor(() => {
    const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
    expect(meta.checkpointRev).toBe(meta.rev);
  }, { timeout: 5000 });
  await f.execute("workbook_read", {
    path: "book.xlsx", mode: "range", range, facets: ["values", "formulas"],
  }, "summary-read");
  const evidence = (await visibleProviderReceipt(f, "summary-read"))!;
  const args = { status: "complete" as const,
    sources: [{ refId: evidence.candidates.items.find((item) => item.pointer === "/data/values")!.refId }] };
  return { ...f, args, range };
}

test.each([
  [["有效账单数", "异常数", "P实收合计分", "V实收合计分", "差额合计分"], [12, 1, 3400, 2400, 1000]],
  [["有效交易数", "异常数", "销售额分", "正式应付L分", "对照A分", "差额分"], [13, 1, 602, 24, 19, 5]],
  [["指标", "值"], ["合法退单数", 9], ["异常数", 5], ["本期认可退款分", 25004], ["超额退款分", 1001], ["冲回分", 827], ["净调整分", -827]],
  [["销售员", "本期认可退款分", "本期冲回分"], ["001", 25001, 825], ["1", 3, 2]],
])("round seven summary retains every literal small-window cell and full audit %#", async (...rows) => {
  const values = rows as (string | number)[][];
  const f = await roundSevenSummaryFixture(values);
  try {
    const old = await finalizeNumeric(f.log, f.documents, f.args, f.ctx);
    expect(old).toMatchObject({ status: "ok" });
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, presentation: "summary",
    } as Parameters<typeof finalizeNumeric>[2], f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: {
      presentationUsed: "summary", auditText: (old.data as { finalText: string }).finalText,
      deliveredFiles: [expect.objectContaining({ path: "book.xlsx" })],
    } });
    const text = (result.data as { finalText: string }).finalText;
    for (const value of values.flat()) expect(text).toContain(String(value));
    expect(text).toContain(f.range);
    expect(text).toContain("book.xlsx");
    expect(text).not.toContain("CNY");
    expect(text).not.toContain("from_seq");
    expect(text.length).toBeLessThan(900);
  } finally { await f.close(); }
});

test("round seven summary uses a total 32-cell budget and explicitly falls back", async () => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ...Array.from({ length: 16 }, (_, i) => [`指标${i}`, i])]);
  try {
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, presentation: "summary",
    } as Parameters<typeof finalizeNumeric>[2], f.ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      presentationUsed: "evidence", fallbackReason: expect.stringContaining("32"),
      finalText: expect.stringContaining("未压缩"),
    } });
  } finally { await f.close(); }
});

test("round seven summary never hides failed tool receipts after a successful read", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "workbook_read", toolCallId: "earlier-failure", status: "error",
      result: { status: "error", error: { code: "NOT_FOUND", message: "missing", retryable: false } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, presentation: "summary",
    } as Parameters<typeof finalizeNumeric>[2], f.ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      presentationUsed: "evidence",
      finalText: expect.stringContaining("NOT_FOUND"),
      auditText: expect.stringContaining("earlier-failure"),
    } });
    expect((result.data as { finalText: string }).finalText).toContain("失败");
  } finally { await f.close(); }
});

test.each([282, 251])("harness v1 presentation budgets do not downgrade complete %i-cell evidence", async (count) => {
  const firstCount = Math.ceil(count / 2);
  const f = await roundSevenSummaryFixture([["指标"], ...Array.from({ length: firstCount - 1 }, (_, i) => [i])]);
  try {
    await f.execute("workbook_read", { path: "book.xlsx", mode: "range", range: `Data!E1:E${count - firstCount}`, facets: ["values"] }, "second-budget");
    const second = (await visibleProviderReceipt(f, "second-budget"))!;
    const secondSource = { refId: second.candidates.items.find((item) => item.pointer === "/data/values")!.refId };
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, sources: [...f.args.sources, secondSource, ...f.args.sources],
    }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationOverflow: { cells: true } } });
    expect((result.data as { finalText: string }).finalText).toContain(String(firstCount - 2));
    expect(result.error).toBeUndefined();
  } finally { await f.close(); }
});


test.each(["", "   "])("round seven summary falls back for blank object identity %j", async (identity) => {
  const f = await roundSevenSummaryFixture([["销售员", "冲回分"], [identity, 827]]);
  try {
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, presentation: "summary",
    } as Parameters<typeof finalizeNumeric>[2], f.ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      presentationUsed: "evidence", fallbackReason: expect.stringMatching(/空白|缺失/),
    } });
  } finally { await f.close(); }
});

test.each(["workbook_read", "workbook_analyze", "present"])("round seven summary retains unknown failure message for %s", async (name) => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: name, toolCallId: "unknown-execution", status: "error",
      result: { status: "error", error: { code: "INTERNAL", message: "执行状态未知，不能确认是否完成", retryable: false } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, presentation: "summary",
    } as Parameters<typeof finalizeNumeric>[2], f.ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      presentationUsed: "evidence", fallbackReason: expect.any(String),
      finalText: expect.stringContaining("执行状态未知，不能确认是否完成"),
    } });
    expect((result.data as { finalText: string }).finalText).toContain("INTERNAL");
  } finally { await f.close(); }
});


test("round seven summary preserves explicit parameter rejection detail without claiming recovery", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "present", toolCallId: "rejected-parameter", status: "error",
      result: { status: "error", error: { code: "INVALID_ARGUMENT", message: "binding未选择同次来源", retryable: false } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "summary",
      finalText: expect.stringContaining("binding未选择同次来源") } });
    expect((result.data as { finalText: string }).finalText).toContain("不等同这些失败已恢复");
  } finally { await f.close(); }
});

test("round seven summary preserves recovery facts even when a script reports no publications", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "run_script", toolCallId: "recovery-facts", status: "ok",
      result: { status: "ok", data: { published: [], rolledBack: ["rollback.xlsx"], unrecovered: ["unrecovered.xlsx"] } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "evidence",
      finalText: expect.stringContaining("unrecovered.xlsx") } });
    expect((result.data as { finalText: string }).finalText).toContain("rollback.xlsx");
  } finally { await f.close(); }
});


async function appendRoundSevenAlignmentReceipt(
  f: Awaited<ReturnType<typeof roundSevenSummaryFixture>>,
  status: "verified" | "failed" | "unverified",
  rev: number,
  malformed = false,
  sourcePolicies: unknown[] = [],
) {
  const meta = f.documents.meta((f.edit.data as { docId: string }).docId)!;
  const sourceFile = await f.documents.sourceStatus(meta.id, f.ctx.workspaceRoot);
  const payload = {
    docId: meta.id, path: "book.xlsx", mode: "source_alignment", docRevs: { [meta.id]: rev }, sourceFile,
    verification: {
      status, scope: "declared_fields_only",
      target: { docId: meta.id, path: "book.xlsx", rev, sheet: "Data", range: f.range },
      sources: [{ name: "original", docId: meta.id, path: "book.xlsx", rev, range: f.range }],
      requiredColumns: ["E", "F"], coveredColumns: status === "verified" ? ["E", "F"] : ["E"],
      uncoveredColumns: status === "verified" ? [] : ["F"],
      declaredCellCount: 2, checkedCellCount: 2, failedCount: status === "failed" ? 1 : 0,
      unverifiedCount: status === "unverified" ? 1 : 0, conflictKeyCount: 0, sourcePolicies,
      failures: status === "verified" ? [] : [{ targetCell: "Data!F2", ruleIndex: 0, code: "VALUE_MISMATCH" }],
      failuresTruncated: false, limitation: "只校验声明字段，不证明全部业务要求或未声明列",
    },
    ...(!malformed ? { versionBindings: [{ docId: meta.id, path: "book.xlsx", rev,
      sha256: sourceFile.currentSha256, checkpointRev: rev, isCurrentSaved: true }] } : {}),
  };
  f.log.append("s", "main", [{ type: "tool.result", data: {
    toolName: "workbook_analyze", toolCallId: `alignment-${status}-${rev}`, status: "ok",
    result: { status: "ok", data: payload },
  } }]);
}

test.each(["failed", "unverified"] as const)("round seven alignment %s and uncovered fields remain visible in summary and evidence", async (status) => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    const rev = f.documents.meta((f.edit.data as { docId: string }).docId)!.rev;
    await appendRoundSevenAlignmentReceipt(f, status, rev);
    for (const presentation of ["summary", "evidence"] as const) {
      const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation }, f.ctx);
      expect(result).toMatchObject({ status: "ok", data: { finalText: expect.stringContaining(status) } });
      const text = (result.data as { finalText: string }).finalText;
      expect(text).toContain("未覆盖：F");
      expect(text).toContain("交付时未重新校验");
    }
  } finally { await f.close(); }
});

test("round seven alignment stale green never certifies newer file or hides previous failure", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    const rev = f.documents.meta((f.edit.data as { docId: string }).docId)!.rev;
    await appendRoundSevenAlignmentReceipt(f, "failed", rev - 1);
    await appendRoundSevenAlignmentReceipt(f, "verified", rev - 1);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain(`基于修订${rev - 1}`);
    expect(text).toContain(`当前修订${rev}`);
    expect(text).toContain("更早还有1次failed/unverified/未知回执");
    expect(text).toContain("交付时未重新校验");
  } finally { await f.close(); }
});

test("round seven alignment malformed host receipt is explicitly unknown", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    await appendRoundSevenAlignmentReceipt(f, "verified", 1, true);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalText: expect.stringContaining("字段校验回执未知") } });
  } finally { await f.close(); }
});


test("round seven summary shares its 32-cell budget across distinct tool calls", async () => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ...Array.from({ length: 8 }, (_, i) => [`项${i}`, i])]);
  try {
    await f.execute("workbook_read", { path: "book.xlsx", mode: "range", range: f.range, facets: ["values"] }, "second-window");
    const second = (await visibleProviderReceipt(f, "second-window"))!;
    const refId = second.candidates.items.find((item) => item.pointer === "/data/values")!.refId;
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, sources: [...f.args.sources, { refId }], presentation: "summary",
    }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "evidence", fallbackReason: expect.stringContaining("32") } });
  } finally { await f.close(); }
});

test("round seven alignment does not trust script-returned lookalike data", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "run_script", toolCallId: "script-lookalike", status: "ok",
      result: { status: "ok", data: { published: [], value: {
        mode: "source_alignment", verification: { status: "verified", coveredColumns: ["FORGED"] },
      } } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).not.toContain("字段校验回执");
    expect(text).not.toContain("FORGED");
  } finally { await f.close(); }
});


test("round seven three foreign-call bindings receive one complete verified repair list", async () => {
  const f = await roundSevenSummaryFixture([["指标（元）", "金额（元）"], ["项目甲", 1], ["项目乙", 2], ["项目丙", 3]]);
  try {
    await f.execute("workbook_read", { path: "book.xlsx", mode: "range", range: f.range, facets: ["values"] }, "three-binding-read");
    const other = (await visibleProviderReceipt(f, "three-binding-read"))!;
    const unique = new Map(other.bindingCandidates.items.filter((item) => item.unit.sourcePointer).map((item) => [item.valueRefId, item]));
    const selected = [...unique.values()].slice(0, 3);
    expect(selected).toHaveLength(3);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args,
      bindings: selected.map((item) => ({ bindingId: item.bindingId })),
    }, f.ctx);
    expect(result).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(result.error?.message).toContain(JSON.stringify(selected.map((item) => ({ refId: item.valueRefId }))));
    expect(result.error?.message).toContain("不会自动");
  } finally { await f.close(); }
});


test("round seven alignment discloses exact filter duplicate conflict policy and source range", async () => {
  const f = await roundSevenSummaryFixture([["冲回分", "异常数"], [827, 5]]);
  try {
    const rev = f.documents.meta((f.edit.data as { docId: string }).docId)!.rev;
    const policies = [{ ruleIndex: 0, source: "original", where: [{ column: "状态", equals: "纳入" }],
      duplicatePolicy: "identical_rows", duplicateColumns: ["标识", "状态"], conflictPolicy: "expect_blank" }];
    await appendRoundSevenAlignmentReceipt(f, "verified", rev, false, policies);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain(JSON.stringify(policies));
    expect(text).toContain("original=book.xlsx");
    expect(text).toContain(f.range);
    expect(text).toContain("严格类型");
  } finally { await f.close(); }
});

test("round seven binding mismatch rejects and suggests only its verified same-call value ref", async () => {
  const f = await roundSevenSummaryFixture([["指标（元）", "金额（元）"], ["合计", 827]]);
  try {
    await f.execute("workbook_read", { path: "book.xlsx", mode: "range", range: f.range, facets: ["values"] }, "other-read");
    const other = (await visibleProviderReceipt(f, "other-read"))!;
    const binding = other.bindingCandidates.items.find((item) => item.unit.sourcePointer)!;
    const result = await finalizeNumeric(f.log, f.documents, {
      ...f.args, bindings: [{ bindingId: binding.bindingId }],
    }, f.ctx);
    expect(result).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(result.error?.message).toContain("other-read");
    expect(result.error?.message).toContain(JSON.stringify([{ refId: binding.valueRefId }]));
    expect(result.error?.message).toContain("不会自动");
  } finally { await f.close(); }
});


test("harness v1 summary retains independent diagnostics without changing evidence completeness", async () => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ...Array.from({ length: 16 }, (_, i) => [`指标${i}`, i])]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "run_script", toolCallId: "historical-failure", status: "error",
      result: { status: "error", error: { code: "SANDBOX_ERROR", message: "invalid edit at=0", retryable: false } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: {
      finalizationStatus: "complete", presentationUsed: "evidence", presentationSatisfied: false,
      summaryDiagnostics: { complete: true, overflow: false, blockers: expect.arrayContaining([
        expect.objectContaining({ code: "SUMMARY_CELL_LIMIT", actual: 34, limit: 32 }),
        expect.objectContaining({ code: "SCRIPT_PUBLICATION_UNKNOWN", toolCallId: "historical-failure" }),
      ]) },
      deliveredFiles: [expect.objectContaining({ path: "book.xlsx" })],
    } });
    const data = result.data as { finalText: string; auditText: string };
    expect(data.finalText).toContain(data.auditText);
    expect(data.finalText).toContain("简短呈现要求未满足");
    expect(data.finalText).toContain("invalid edit at=0");
    expect(f.log.readAfter("s", 0, 1000).some((row) => row.type === "ui.present" && row.data.path === "book.xlsx")).toBe(true);
  } finally { await f.close(); }
});

test("round eight summary diagnostics are finite and hard evidence gates do not claim complete diagnostics", async () => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ["净分", 827]]);
  try {
    for (let i = 0; i < 45; i++) f.log.append("s", "main", [{ type: "tool.result", data: {
      toolName: "run_script", toolCallId: `unknown-${i}`, status: "error",
      result: { status: "error", error: { code: "SANDBOX_ERROR", message: "x", retryable: false } },
    } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete",
      summaryDiagnostics: { complete: false, overflow: true, limit: 32 } } });
    expect((result.data as { summaryDiagnostics: { blockers: unknown[] } }).summaryDiagnostics.blockers).toHaveLength(32);
    const hard = await finalizeNumeric(f.log, f.documents, { status: "complete", presentation: "summary", sources: [{ refId: "invented" }] }, f.ctx);
    expect(hard.status).toBe("error");
    expect(hard.data).toBeUndefined();
  } finally { await f.close(); }
});

test("round eight A2-shaped 30+9+91+45 selection reports 175 cells and the independent historical publication blocker", async () => {
  const f = await fixture();
  try {
    f.ctx.turnId = "a2-shaped";
    f.log.append("s", "main", [{ type: "turn.started", data: { turnId: f.ctx.turnId } }]);
    const windows = [["Data!E1:F15", 15, 2], ["Data!H1:J3", 3, 3], ["Data!L1:X7", 7, 13], ["Data!Z1:AH5", 5, 9]] as const;
    const write = await f.execute("workbook_edit", { path: "book.xlsx", ops: windows.map(([range, rows, cols]) => ({
      op: "cells.set", range, values: Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => row === 0 ? `原文列${col}` : row * 10 + col)),
    })) }, "a2-write");
    expect(write.status).toBe("ok");
    const id = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(() => expect(f.documents.meta(id)!.checkpointRev).toBe(f.documents.meta(id)!.rev), { timeout: 5000 });
    const sources: { refId: string }[] = [];
    for (const [i, [range]] of windows.entries()) {
      await f.execute("workbook_read", { path: "book.xlsx", mode: "range", range, facets: ["values"] }, `a2-read-${i}`);
      const evidence = (await visibleProviderReceipt(f, `a2-read-${i}`))!;
      sources.push({ refId: evidence.candidates.items.find((item) => item.pointer === "/data/values")!.refId });
    }
    f.log.append("s", "main", [{ type: "tool.result", data: { toolName: "run_script", toolCallId: "a2-old-failure", status: "error", result: {
      status: "error", error: { code: "SANDBOX_ERROR", message: "at=0 rejected", retryable: false },
    } } }]);
    const result = await finalizeNumeric(f.log, f.documents, { status: "complete", presentation: "summary", sources }, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", summaryDiagnostics: {
      complete: true, blockers: expect.arrayContaining([
        expect.objectContaining({ code: "SUMMARY_CELL_LIMIT", actual: 175, limit: 32 }),
        expect.objectContaining({ code: "SCRIPT_PUBLICATION_UNKNOWN", toolCallId: "a2-old-failure" }),
      ]),
    } } });
  } finally { await f.close(); }
});

test("round eight invalid heading and body report independent blockers before complete diagnostics", async () => {
  const f = await roundSevenSummaryFixture([["", "金额"], ["001", null], ["002", 2]] as (string | number)[][]);
  try {
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", summaryDiagnostics: { complete: true,
      blockers: expect.arrayContaining([expect.objectContaining({ code: "WINDOW_HEADERS_INVALID" }), expect.objectContaining({ code: "WINDOW_CELLS_INVALID" })]),
    } } });
  } finally { await f.close(); }
});

test("round eight present schema only accepts current bindingId objects, not obsolete relationship advice", async () => {
  const f = await roundSevenSummaryFixture([["对象", "金额（分）"], ["001", 827]]);
  try {
    const evidence = (await visibleProviderReceipt(f, "summary-read"))!;
    const binding = evidence.bindingCandidates.items[0]!;
    expect(binding).toBeDefined();
    expect(f.present.input.safeParse({ finalize: { ...f.args, presentation: "summary", bindings: [{ bindingId: binding.bindingId }] } }).success).toBe(true);
    expect(f.present.input.safeParse({ finalize: { ...f.args, bindings: [{ valueRefId: binding.valueRefId, labelRefId: binding.labelRefId, relation: "same_column" }] } }).success).toBe(false);
    expect(f.present.description).toContain("非终结");
    expect(f.present.description).toContain("deliver");
    expect(JSON.stringify(f.present.inputJsonSchema)).not.toContain('"finalize"');
  } finally { await f.close(); }
});

test.each([
  'await wb.edit({path:"book.xlsx",ops:[{op:"cols.width",sheet:"Data",at:0,count:1,mode:"pixels",pixels:60}]});',
  'await wb.edit({path:"book.xlsx",ops:[{op:"cells.set",range:"Data!A2",values:[[999]]}]}); await wb.edit({path:"book.xlsx",ops:[{op:"cols.width",sheet:"Data",at:0,count:1,mode:"pixels",pixels:60}]});',
  'await files.writeText({path:"staged.txt",content:"temporary"}); throw new Error("after staging");',
])("round eight actual prepublication failure is host-owned and supports an accurate short failure note %#", async (code) => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ["净分", 827]]);
  try {
    const id = (f.edit.data as { docId: string }).docId, rev = f.documents.meta(id)!.rev;
    const script = await f.execute("run_script", { code }, "prepublish");
    expect(script).toMatchObject({ status: "error", data: { publicationPhase: "not_started", published: [], committedRevs: [] } });
    expect(f.documents.meta(id)!.rev).toBe(rev);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM doc_ops WHERE tool_call_id='prepublish'").get()).toMatchObject({ n: 0 });
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("未进入发布阶段");
    expect(text.replaceAll("&gt;", ">")).toContain(script.error!.message.replaceAll("\n", "\\n"));
    expect(text).toContain("不等同这些失败已恢复");
    expect(text).not.toContain("无副作用");
    expect(text).not.toContain("清理成功");
  } finally { await f.close(); }
});

test("round eight cleanup failure does not turn prepublication into a recovery or cleanup claim", async () => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const f = await fixture();
  const original = fs.rmSync;
  let cleanupAttempted = false;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (String(path).endsWith("script-cleanup-probe")) { cleanupAttempted = true; throw Error("synthetic cleanup failure"); }
    original(path, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.execute("run_script", { code: 'await files.writeText({path:"staged.txt",content:"temp"}); throw Error("before publish");' }, "cleanup-probe");
    expect(cleanupAttempted).toBe(true);
    expect(result).toMatchObject({ status: "error", data: { publicationPhase: "not_started", published: [], committedRevs: [] } });
    expect(result.error?.message).toContain("before publish");
    expect(result.data).not.toHaveProperty("cleanupSucceeded");
  } finally { spy.mockRestore(); syncBuiltinESMExports(); await f.close(); }
});

test("round eight concurrent script calls keep host prepublication metadata isolated", async () => {
  const f = await fixture();
  try {
    const [failed, succeeded] = await Promise.all([
      f.execute("run_script", { code: 'await files.writeText({path:"staged.txt",content:"temp"}); throw Error("isolated failure");' }, "concurrent-failure"),
      f.execute("run_script", { code: 'return {publicationPhase:"not_started",published:[]};' }, "concurrent-success"),
    ]);
    expect(failed).toMatchObject({ status: "error", data: { publicationPhase: "not_started", published: [], committedRevs: [] } });
    expect(succeeded).toMatchObject({ status: "ok", data: { published: [] } });
    expect((succeeded.data as Record<string, unknown>).publicationPhase).toBeUndefined();
  } finally { await f.close(); }
});

test("round eight successful no-write script cannot promote script-returned or stdout publication phase", async () => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ["净分", 827]]);
  try {
    const result = await f.execute("run_script", { code: 'console.log(JSON.stringify({publicationPhase:"not_started"})); return {publicationPhase:"not_started",published:[],committedRevs:[]};' }, "no-write");
    expect(result).toMatchObject({ status: "ok", data: { published: [], value: { publicationPhase: "not_started" } } });
    expect((result.data as Record<string, unknown>).publicationPhase).toBeUndefined();
  } finally { await f.close(); }
});

test.each([
  { value: { publicationPhase: "not_started", published: [], committedRevs: [] }, stdout: ['{"publicationPhase":"not_started"}'] },
  { publicationPhase: "not_started", published: [{ path: "partial.xlsx" }], committedRevs: [] },
  { publicationPhase: "not_started", published: [], committedRevs: [{ path: "committed.xlsx", rev: 2 }] },
  { publicationPhase: "not_started", published: [], committedRevs: [], rolledBack: ["rollback.xlsx"] },
  { publicationPhase: "not_started", published: [], committedRevs: [], unrecovered: ["unrecovered.xlsx"] },
])("round eight unknown or contradictory script phase never suppresses mandatory disclosures %#", async (data) => {
  const f = await roundSevenSummaryFixture([["指标", "值"], ["净分", 827]]);
  try {
    f.log.append("s", "main", [{ type: "tool.result", data: { toolName: "run_script", toolCallId: "contradiction", status: "error", result: {
      status: "error", error: { code: "SANDBOX_ERROR", message: "historical failure", retryable: false }, data,
    } } }]);
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, presentation: "summary" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "evidence",
      summaryDiagnostics: { blockers: expect.arrayContaining([expect.objectContaining({ code: "SCRIPT_PUBLICATION_UNKNOWN" })]) } } });
    expect((result.data as { finalText: string }).finalText).toContain("historical failure");
  } finally { await f.close(); }
});

test.each([false, true])("round eight actual partial commit rollback retains conservative receipt: rollbackFailure=%s", async (rollbackFailure) => {
  const f = await fixture();
  try {
    const id = (f.edit.data as { docId: string }).docId;
    await vi.waitFor(() => expect(f.documents.meta(id)!.checkpointRev).toBe(f.documents.meta(id)!.rev));
    mkdirSync(join(f.dir, "notes"));
    writeFileSync(join(f.dir, "notes/out.txt"), "before");
    if (rollbackFailure) vi.spyOn(f.documents, "revert").mockRejectedValueOnce(new Error("injected rollback failure"));
    f.ctx.requestApproval = async () => { rmSync(join(f.dir, "notes"), { recursive: true }); return { decision: "approved" }; };
    const result = await f.execute("run_script", { code: 'await wb.edit({path:"book.xlsx",ops:[{op:"cells.set",range:"Data!A2",values:[[999]]}]}); await files.writeText({path:"notes/out.txt",content:"after"});' }, "partial-publish");
    expect(result).toMatchObject({ status: rollbackFailure ? "uncertain" : "error", data: {
      committedRevs: [expect.objectContaining({ docId: id })], published: [expect.objectContaining({ path: "book.xlsx" })],
      [rollbackFailure ? "unrecovered" : "rolledBack"]: ["book.xlsx"],
    } });
    expect((result.data as Record<string, unknown>).publicationPhase).toBeUndefined();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

async function roundNineSqlFixture(sql = 'SELECT COUNT(*) AS "记录数", SUM("Qty") AS "总量" FROM data', args: Record<string, unknown> = {}) {
  const f = await roundSevenSummaryFixture([["对象", "净分"], ["001", 25]]);
  const result = await f.execute("workbook_analyze", {
    path: "book.xlsx", mode: "sql", range: "Data!A1:B3", sql, ...args,
  }, "sql-summary");
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
  const evidence = (await visibleProviderReceipt(f, "sql-summary"))!;
  const root = evidence.candidates.items.find((item) => item.pointer === "/data/rows")!;
  expect(root).toBeDefined();
  return { ...f, sqlResult: result, sqlEvidence: evidence, sqlArgs: {
    status: "complete" as const, presentation: "summary" as const, sources: [{ refId: root.refId }],
  } };
}

test("round nine real SQL aggregate present renders same-call headers and saved file without losing audit", async () => {
  const f = await roundNineSqlFixture();
  try {
    const audit = await finalizeNumeric(f.log, f.documents, { ...f.sqlArgs, presentation: "evidence" }, f.ctx);
    const result = await f.present.execute({ finalize: f.sqlArgs }, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: {
      finalizationStatus: "complete", presentationUsed: "summary",
      auditText: (audit.data as { finalText: string }).finalText,
      deliveredFiles: [{ path: "book.xlsx" }],
    } });
    const rendered = (result.data as { finalText: string }).finalText;
    for (const value of ["SQL 查询结果", "sql-summary", "记录数", "总量", "| 2 | 5 |", "SELECT COUNT(\\*)", "data", "Data!A1:B3", "rev", "非 Excel 格式化显示", "不证明原始行覆盖"])
      expect(rendered).toContain(value);
    expect(f.sqlEvidence.bindingCandidates.items).toEqual([]);
    expect((result.data as { auditText: string }).auditText).toContain("未提供格式信息");
  } finally { await f.close(); }
});

type RoundNineFixture = Awaited<ReturnType<typeof roundNineSqlFixture>>;
function roundNineMutateReceipt(f: RoundNineFixture, mutate: (data: Record<string, unknown>) => void, visibleOnly = false) {
  const row = f.db.prepare("SELECT seq,data FROM session_log WHERE type='tool.result' AND json_extract(data,'$.toolCallId')='sql-summary'").get() as { seq: number; data: string };
  const receipt = JSON.parse(row.data);
  mutate(receipt.result.data);
  if (!visibleOnly) f.db.prepare("UPDATE session_log SET data=? WHERE seq=?").run(JSON.stringify(receipt), row.seq);
  const itemRow = f.db.prepare("SELECT idx,item FROM agent_context WHERE from_seq=? AND session_id='s' AND agent_id='main'").get(row.seq) as { idx: number; item: string };
  const item = JSON.parse(itemRow.item);
  item.output = receipt.result;
  f.db.prepare("UPDATE agent_context SET item=? WHERE idx=? AND session_id='s' AND agent_id='main'").run(JSON.stringify(item), itemRow.idx);
}
function roundNineFallback(result: ToolResult, code: string) {
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: {
    finalizationStatus: "complete", presentationUsed: "evidence",
    deliveredFiles: [{ path: "book.xlsx" }],
    summaryDiagnostics: { blockers: expect.arrayContaining([expect.objectContaining({ code })]) },
  } });
  const data = result.data as { finalText: string; auditText: string };
  expect(data.finalText).toContain(data.auditText);
}

test.each([
  ["long form", "SELECT '明细条数' AS 项目, COUNT(*) AS 值 FROM data UNION ALL SELECT '异常条数', 1 UNION ALL SELECT '2026-08 数量件合计', 6 UNION ALL SELECT '2026-08 收入元合计', 140 UNION ALL SELECT '2026-09 数量件合计', 5 UNION ALL SELECT '2026-09 收入元合计', 130", ['| "项目" | "值" |', '| "明细条数" | 2 |', '| "2026-09 收入元合计" | 130 |']],
  ["typed cells", "SELECT '001' AS identifier, '9007199254740993' AS largeId, 0 AS zero, -2.5 AS net, 2 AS '001', 2026 AS month2026", ['| "001" | "9007199254740993" | 0 | -2.5 | 2 | 2026 |', '"month2026"', '"001"']],
  ["zero count", "SELECT COUNT(*) AS 'COUNT(*)' FROM data WHERE Qty < 0", ['| 0 |']],
  ["literal unit alias", "SELECT SUM(Amount) AS 'total(USD)' FROM data WHERE Qty > 1 LIMIT 1", ['"total(USD)"', "WHERE Qty &gt; 1 LIMIT 1", "不认证业务口径或单位"]],
])("round nine real SQL preserves %s", async (_name, sql, expected) => {
  const f = await roundNineSqlFixture(sql);
  try {
    const result = await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    for (const part of expected) expect(text).toContain(part);
    expect(text).not.toContain("单位：USD");
    expect(f.sqlEvidence.bindingCandidates.items).toEqual([]);
  } finally { await f.close(); }
});

test("round nine SQL string and query Markdown remain literal rather than links or images", async () => {
  const tick = String.fromCharCode(96);
  const f = await roundNineSqlFixture("SELECT '[claimed](https://example.invalid)' AS '[header]', '![999](x)' AS image, '" + tick + "code" + tick + "*bold*~~100~~|<x>' AS text, 7 AS metric");
  try {
    const result = await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    for (const literal of ["\\[claimed\\]", "!\\[999\\]", "\\" + tick + "code\\" + tick + "\\*bold\\*", "&#124;&lt;x&gt;", "\\[header\\]", "\\~\\~100\\~\\~"]) expect(text).toContain(literal);
    expect(text).not.toContain("[claimed](https://example.invalid)");
  } finally { await f.close(); }
});

test.each(["NULL", "''", "'   '", "'#DIV/0!'", "9007199254740992.0", "1e999"])(
  "round nine SQL unsupported real cell %s retains complete audit and cards", async (value) => {
    const f = await roundNineSqlFixture("SELECT " + value + " AS identity, 7 AS metric");
    try { roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), "WINDOW_CELLS_INVALID"); }
    finally { await f.close(); }
  });

test.each(["'2'", "'1'", "'0'", "'4294967294'"])(
  "round nine real SQL rejects canonical index header %s without repairing producer order", async (header) => {
    const f = await roundNineSqlFixture("SELECT 'actual text' AS label, 7 AS " + header);
    try { roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), "WINDOW_HEADERS_INVALID"); }
    finally { await f.close(); }
  });

test.each([
  ["boolean", (d: Record<string, unknown>) => { d.rows = [[true, 5]]; }, "WINDOW_CELLS_INVALID"],
  ["object", (d: Record<string, unknown>) => { d.rows = [[{ misleading: 2 }, 5]]; }, "WINDOW_CELLS_INVALID"],
  ["nested array", (d: Record<string, unknown>) => { d.rows = [[[2], 5]]; }, "WINDOW_CELLS_INVALID"],
  ["ragged", (d: Record<string, unknown>) => { d.rows = [[2]]; }, "WINDOW_CELLS_INVALID"],
  ["missing columns", (d: Record<string, unknown>) => { delete d.columns; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["duplicate columns", (d: Record<string, unknown>) => { d.columns = ["same", "same"]; }, "WINDOW_HEADERS_INVALID"],
  ["empty column", (d: Record<string, unknown>) => { d.columns = ["", "total"]; }, "WINDOW_HEADERS_INVALID"],
  ["missing count", (d: Record<string, unknown>) => { delete d.rowCount; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["wrong count", (d: Record<string, unknown>) => { d.rowCount = 2; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["missing truncation", (d: Record<string, unknown>) => { delete d.truncated; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["page marker", (d: Record<string, unknown>) => { d.nextCursor = "page2"; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["contradictory error", (d: Record<string, unknown>) => { d.error = { code: "FAILED", message: "not complete" }; }, "SOURCE_WINDOW_UNSUPPORTED"],
  ["multiple result sets", (d: Record<string, unknown>) => { d.resultSets = []; }, "SOURCE_WINDOW_UNSUPPORTED"],
] as const)("round nine malformed same-call SQL %s cannot become a complete summary", async (_name, mutate, code) => {
  const f = await roundNineSqlFixture();
  try { roundNineMutateReceipt(f, mutate); roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), code); }
  finally { await f.close(); }
});

test.each(["columns", "sql", "rowCount", "truncated"])(
  "round nine hidden or mismatching visible SQL %s cannot borrow recorded metadata", async (field) => {
    const f = await roundNineSqlFixture();
    try {
      roundNineMutateReceipt(f, (data) => { if (field === "columns") data.columns = ["fake", "headers"]; else delete data[field]; }, true);
      roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), "SOURCE_WINDOW_UNSUPPORTED");
    } finally { await f.close(); }
  });

test.each(["missing", "other agent", "duplicate"])("round nine %s SQL intent is not an input-scope proof", async (kind) => {
  const f = await roundNineSqlFixture();
  try {
    const row = f.db.prepare("SELECT seq,data FROM session_log WHERE type='tool.intent' AND json_extract(data,'$.toolCallId')='sql-summary'").get() as { seq: number; data: string };
    if (kind === "duplicate") {
      // Preserve the before-result order while duplicating the call identity on an earlier real intent.
      f.db.prepare("UPDATE session_log SET data=? WHERE type='tool.intent' AND json_extract(data,'$.toolCallId')='summary-read'").run(row.data);
    } else if (kind === "other agent") f.db.prepare("UPDATE session_log SET agent_id='other' WHERE seq=?").run(row.seq);
    else f.db.prepare("UPDATE session_log SET data=json_set(data,'$.toolCallId','missing') WHERE seq=?").run(row.seq);
    roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), "SOURCE_WINDOW_UNSUPPORTED");
  } finally { await f.close(); }
});

test.each([
  ["unclipped explicit", { range: "'Data'!A1:B3", sheet: "ignored" }, true],
  ["whole sheet", { range: undefined }, true],
  ["clipped explicit", { range: "Data!A1:XFD1048576" }, false],
  ["clipped unused alias", { sources: [{ name: "unused", range: "Data!A1:XFD1048576" }] }, false],
])("round nine actual input intent detects %s", async (_name, args, complete) => {
  const f = await roundNineSqlFixture(undefined, args);
  try {
    const result = await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx);
    if (complete) expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete" } });
    else roundNineFallback(result, "SOURCE_WINDOW_UNSUPPORTED");
  } finally { await f.close(); }
});

test.each([23, 24, 27, 32, 33, 39])("round nine combined SQL and range header budget is %i, without pruning", async (cells) => {
  const layout: Record<number, [number, number, number[]]> = { 23: [3, 3, [7]], 24: [2, 6, [6]], 27: [5, 3, [6]], 32: [2, 13, [3]], 33: [3, 9, [3]], 39: [5, 3, [7, 5]] };
  const [width, rows, counts] = layout[cells]!;
  const values = [Array.from({ length: width }, (_, i) => "column" + i),
    ...Array.from({ length: rows - 1 }, (_, r) => Array.from({ length: width }, (_, c) => r + c))];
  const f = await roundSevenSummaryFixture(values);
  try {
    const sources = [...f.args.sources];
    for (const [index, count] of counts.entries()) {
      const id = "budget-sql-" + index;
      await f.execute("workbook_analyze", { path: "book.xlsx", mode: "sql", range: "Data!A1:B3",
        sql: "SELECT " + Array.from({ length: count }, (_, i) => (i + 10) + " AS column" + i).join(", ") }, id);
      const receipt = (await visibleProviderReceipt(f, id))!;
      sources.push({ refId: receipt.candidates.items.find((item) => item.pointer === "/data/rows")!.refId });
    }
    const result = await finalizeNumeric(f.log, f.documents, { ...f.args, sources: [...sources, ...sources], presentation: "summary" }, f.ctx);
    if (cells <= 32) expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete" } });
    else {
      roundNineFallback(result, "SUMMARY_CELL_LIMIT");
      expect(result).toMatchObject({ data: { summaryDiagnostics: { blockers: expect.arrayContaining([
        expect.objectContaining({ code: "SUMMARY_CELL_LIMIT", actual: cells, limit: 32 }),
      ]) } } });
    }
  } finally { await f.close(); }
});

test("round nine root-only SQL does not promote scalar subset or a truncated preview", async () => {
  const f = await roundNineSqlFixture();
  try {
    const scalar = f.sqlEvidence.candidates.items.find((item) => item.pointer === "/data/rows/0/0")!;
    roundNineFallback(await finalizeNumeric(f.log, f.documents, { ...f.sqlArgs, sources: [{ refId: scalar.refId }] }, f.ctx), "SOURCE_WINDOW_UNSUPPORTED");
    roundNineMutateReceipt(f, (data) => { data.truncated = true; });
    expect(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("候选目录") } });
  } finally { await f.close(); }
});

test("round nine SQL preserves an earlier parameter failure without claiming recovery", async () => {
  const f = await roundNineSqlFixture();
  try {
    await f.execute("workbook_analyze", { path: "book.xlsx", mode: "sql", sql: "DELETE FROM data" }, "bad-sql");
    const result = await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    expect(text).toContain("INVALID_ARGUMENT");
    expect(text).not.toContain("恢复成功");
  } finally { await f.close(); }
});

test("round nine same-valued distinct SQL calls count separately but exact roots deduplicate", async () => {
  const sql = "SELECT 10 AS a, 11 AS b, 12 AS c, 13 AS d, 14 AS e, 15 AS f, 16 AS g";
  const f = await roundNineSqlFixture(sql);
  try {
    const sources = [...f.sqlArgs.sources];
    for (const id of ["same-two", "same-three"]) {
      await f.execute("workbook_analyze", { path: "book.xlsx", mode: "sql", range: "Data!A1:B3", sql }, id);
      const evidence = (await visibleProviderReceipt(f, id))!;
      sources.push({ refId: evidence.candidates.items.find((item) => item.pointer === "/data/rows")!.refId });
    }
    const result = await finalizeNumeric(f.log, f.documents, { ...f.sqlArgs, sources: [...sources, ...sources] }, f.ctx);
    roundNineFallback(result, "SUMMARY_CELL_LIMIT");
    expect(result).toMatchObject({ data: { summaryDiagnostics: { blockers: expect.arrayContaining([
      expect.objectContaining({ code: "SUMMARY_CELL_LIMIT", actual: 42, limit: 32 }),
    ]) } } });
  } finally { await f.close(); }
});

test("round nine combined SQL text budget includes all query, provenance, caveat and range text", async () => {
  const sql = "SELECT 7 AS metric", caveat = "列名/单位仅查询输出原文，不认证业务口径或单位；非 Excel 格式化显示，不证明原始行覆盖。";
  const base = await roundNineSqlFixture(sql);
  let bodyLength = 0;
  try {
    const result = await finalizeNumeric(base.log, base.documents, { ...base.sqlArgs, sources: [...base.args.sources, ...base.sqlArgs.sources] }, base.ctx);
    expect(result).toMatchObject({ status: "ok", data: { presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    const start = text.indexOf("book.xlsx · " + base.range), end = text.indexOf(caveat) + caveat.length;
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    bodyLength = text.slice(start, end).length;
  } finally { await base.close(); }
  for (const size of [2000, 2001]) {
    const f = await roundNineSqlFixture(sql.replace("SELECT ", "SELECT " + " ".repeat(size - bodyLength)));
    try {
      const result = await finalizeNumeric(f.log, f.documents, { ...f.sqlArgs, sources: [...f.args.sources, ...f.sqlArgs.sources] }, f.ctx);
      if (size === 2000) expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationUsed: "summary" } });
      else {
        roundNineFallback(result, "SUMMARY_TEXT_LIMIT");
        expect(result).toMatchObject({ data: { summaryDiagnostics: { blockers: expect.arrayContaining([
          expect.objectContaining({ code: "SUMMARY_TEXT_LIMIT", actual: 2001, limit: 2000 }),
        ]) } } });
      }
    } finally { await f.close(); }
  }
});

test.each(["revision", "SHA"])("round nine SQL retains secondary source %s hard gate", async (kind) => {
  const f = await roundNineSqlFixture();
  try {
    const other = await f.execute("workbook_edit", { path: "secondary.xlsx", create: true, sheetNames: ["Extra"],
      ops: [{ op: "cells.set", range: "Extra!A1:A2", values: [["factor"], [2]] }] }, "secondary-write");
    const id = (other.data as { docId: string }).docId;
    await vi.waitFor(() => expect(f.documents.meta(id)!.checkpointRev).toBe(f.documents.meta(id)!.rev), { timeout: 5000 });
    await f.execute("workbook_analyze", { path: "book.xlsx", mode: "sql", range: "Data!A1:B3",
      sources: [{ name: "extra", path: "secondary.xlsx", range: "Extra!A1:A2" }],
      sql: "SELECT SUM(Qty) * MAX(factor) AS total FROM data CROSS JOIN extra" }, "joined-summary");
    const evidence = (await visibleProviderReceipt(f, "joined-summary"))!;
    const args = { ...f.sqlArgs, sources: [{ refId: evidence.candidates.items.find((item) => item.pointer === "/data/rows")!.refId }] };
    const current = await finalizeNumeric(f.log, f.documents, args, f.ctx);
    expect(current, JSON.stringify(current)).toMatchObject({ status: "ok", data: { presentationUsed: "summary", deliveredFiles: [{ path: "book.xlsx" }, { path: "secondary.xlsx" }] } });
    const file = join(f.dir, "secondary.xlsx"), original = readFileSync(file);
    try {
      if (kind === "revision") await f.execute("workbook_edit", { path: "secondary.xlsx", ops: [{ op: "cells.set", range: "Extra!A2", values: [[3]] }] }, "secondary-change");
      else writeFileSync(file, Buffer.concat([original, Buffer.from("external")]));
      expect(await finalizeNumeric(f.log, f.documents, args, f.ctx)).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
    } finally { if (kind === "SHA") writeFileSync(file, original); }
  } finally { await f.close(); }
});

test("round nine empty SQL rows are not certified as a numeric zero", async () => {
  const f = await roundNineSqlFixture("SELECT Qty FROM data WHERE Qty < 0");
  try {
    expect(f.sqlResult).toMatchObject({ status: "ok", data: { rows: [], rowCount: 0, truncated: false } });
    expect(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx)).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
  } finally { await f.close(); }
});

test.each([
  ["warnings string", { warnings: "not complete" }],
  ["truncated object", { truncated: { shown: 1, total: 2, cursor: "more" } }],
  ["truncated string", { truncated: "false" }],
  ["complete string", { complete: "true" }],
  ["visible error", { error: { code: "FAILED", message: "contradiction" } }],
])("round nine visible-only top-level %s cannot hide behind intact SQL rows", async (_name, patch) => {
  const f = await roundNineSqlFixture();
  try {
    const row = f.db.prepare("SELECT idx,item FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')='sql-summary'").get() as { idx: number; item: string };
    const item = JSON.parse(row.item); Object.assign(item.output, patch);
    f.db.prepare("UPDATE agent_context SET item=? WHERE session_id='s' AND agent_id='main' AND idx=?").run(JSON.stringify(item), row.idx);
    roundNineFallback(await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx), "SOURCE_WINDOW_UNSUPPORTED");
  } finally { await f.close(); }
});

test.each(["failed", "unverified"] as const)("round nine SQL does not turn %s alignment or uncovered columns into a semantic pass", async (status) => {
  const f = await roundNineSqlFixture();
  try {
    const rev = f.documents.meta((f.edit.data as { docId: string }).docId)!.rev;
    const policies = [{ ruleIndex: 0, source: "original", where: [{ column: "状态", equals: "纳入" }], duplicatePolicy: "identical_rows", duplicateColumns: ["标识", "状态"], conflictPolicy: "expect_blank" }];
    await appendRoundSevenAlignmentReceipt(f, status, rev, false, policies);
    const result = await finalizeNumeric(f.log, f.documents, f.sqlArgs, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { presentationUsed: "summary" } });
    const text = (result.data as { finalText: string }).finalText;
    for (const fact of [status, "未覆盖：F", "交付时未重新校验", JSON.stringify(policies), "original=book.xlsx"]) expect(text).toContain(fact);
    expect(text).not.toContain("全部业务要求已验证");
  } finally { await f.close(); }
});

test.each(["cells", "text"])("harness v1 SQL summary reports %s presentation overflow without changing evidence completeness", async (kind) => {
  const sql = kind === "cells"
    ? "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101) SELECT x FROM n"
    : "SELECT " + " ".repeat(12000) + "7 AS metric";
  const f = await roundNineSqlFixture(sql);
  try {
    await f.execute("workbook_analyze", { path: "book.xlsx", mode: "sql", range: "Data!A1:B3", sql }, "audit-two");
    const evidence = (await visibleProviderReceipt(f, "audit-two"))!;
    const root = evidence.candidates.items.find((item) => item.pointer === "/data/rows")!;
    expect(root).toBeDefined();
    const result = await finalizeNumeric(f.log, f.documents, { ...f.sqlArgs, sources: [...f.sqlArgs.sources, { refId: root.refId }] }, f.ctx);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", data: { finalizationStatus: "complete", presentationOverflow: { [kind]: true } } });
    expect(result.error).toBeUndefined();
    const data = result.data as { finalText: string; auditText: string };
    expect(data.finalText).toContain(data.auditText);
  } finally { await f.close(); }
});
