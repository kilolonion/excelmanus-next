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
      error: { code: "LIMIT_EXCEEDED" },
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
      { status: "error", error: { code: "LIMIT_EXCEEDED" } },
    );
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
