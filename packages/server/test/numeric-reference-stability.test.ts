import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  QuestionCoordinator,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import { createGateway } from "@excelmanus/models";
import type { ContextItem, ResolvedModel } from "@excelmanus/protocol";
import { SandboxPool } from "@excelmanus/sandbox";
import { workbookModule } from "@excelmanus/workbook";
import { expect, test } from "vitest";
import { interactionTools } from "../src/interactions.ts";
import { finalizeNumericPointers } from "../src/numeric-finalizer.ts";
import { runScriptTool } from "../src/script.ts";

async function fixture() {
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
  const tools = new Map(module.tools!.map((tool) => [tool.name, tool]));
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
    log.append(sessionId, agentId, [
      {
        type: "tool.intent",
        data: { stepId: "step", toolCallId: id, toolName: name, args, targets: [], replay: "safe" },
      },
    ]);
    const result = await tools
      .get(name)!
      .execute(args, { ...ctx, toolCallId: id, agentId, sessionId });
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
      sheetNames: ["Data"],
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Candidate = {
  refId: string;
  pointer: string;
  valueType: string;
  field: unknown;
  unit: string;
};
type Receipt = {
  sources: { refId: string }[];
  candidates: { items: Candidate[]; shown: number; total: number; truncated: boolean };
  sourceScopes: unknown[];
};
async function receipt(f: Fixture, id: string): Promise<Receipt> {
  const row = f.db
    .prepare(
      "SELECT item FROM agent_context WHERE session_id='s' AND agent_id='main' AND json_extract(item,'$.toolCallId')=? ORDER BY idx DESC LIMIT 1",
    )
    .get(id) as { item: string };
  const item = JSON.parse(row.item) as ContextItem;
  let body: { messages: { role: string; content: string }[] } | undefined;
  const model: ResolvedModel = {
    profileId: "receipt",
    provider: "custom-openai-compatible",
    model: "receipt-test",
    baseUrl: "http://fake.invalid/v1",
    apiKey: "local-fake-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  for await (const event of createGateway().step({
    model,
    history: [
      { kind: "user", text: "数值终稿" },
      { kind: "assistant", toolCalls: [{ id, name: "run_script", args: {} }] },
      item,
    ],
    signal: AbortSignal.timeout(10000),
  }))
    expect(event.kind).not.toBe("error");
  // Copy only the actual compatible provider's textual content; discard linkage IDs.
  const content = body?.messages.find((m) => m.role === "tool")?.content;
  expect(typeof content).toBe("string");
  const evidence = JSON.parse(content!).numericEvidence as Receipt;
  expect(evidence?.candidates.items.length).toBeGreaterThan(0);
  for (const source of evidence.sources) expect(source).toHaveProperty("refId");
  return evidence;
}
const finish = (f: Fixture, sources: { refId: string }[]) =>
  f.present.execute(f.present.input.parse({ finalize: { status: "complete", sources } }), f.ctx);

for (const mode of ["overview", "objects"] as const) {
  test(`actual ${mode}+range script copies provider content refs into finalizer`, async () => {
    const f = await fixture();
    try {
      const result = await f.execute(
        "run_script",
        {
          code: `const m=await wb.read({path:"book.xlsx",mode:"${mode}"}); const r=await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"}); return {total:r.data.values[0][0]+r.data.values[1][0],sourceSha:m.data.sourceFile.currentSha256};`,
        },
        mode,
      );
      expect(result.status).toBe("ok");
      const e = await receipt(f, mode);
      expect(e.sourceScopes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope: { kind: "document", mode } }),
          expect.objectContaining({ scope: { kind: "range", range: "Data!B2:B3" } }),
        ]),
      );
      const resultFinal = await finish(f, e.sources);
      expect(resultFinal).toMatchObject({
        status: "ok",
        data: { finalText: expect.stringContaining("37.5") },
      });
    } finally {
      await f.close();
    }
  });
}

test("thirteen legal fine-grained references render a long script once without widening to root", async () => {
  const f = await fixture();
  try {
    const code = `const r=await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"}); /*${"actual code ".repeat(120)}*/ return {...Object.fromEntries(Array.from({length:13},(_,i)=>["metric"+i,Array.from({length:8},()=>r.data.values[0][0])])),unselected:987654321};`;
    await f.execute("run_script", { code }, "long-script");
    const result = await f.finalize(
      Array.from({ length: 13 }, (_, i) => ({
        toolCallId: "long-script",
        pointer: `/data/value/metric${i}`,
      })),
    );
    expect(result).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text.match(/实际脚本：/g)).toHaveLength(1);
    expect(text).toContain("/data/value/metric12");
    expect(text.length).toBeLessThan(24000);
    const e = await receipt(f, "long-script");
    const fine = Array.from({ length: 13 }, (_, i) =>
      e.candidates.items.find((c) => c.pointer === `/data/value/metric${i}`),
    );
    expect(fine.every(Boolean)).toBe(true);
    const online = await finish(
      f,
      fine.map((c) => ({ refId: c!.refId })),
    );
    expect(online).toMatchObject({ status: "ok" });
    const onlineText = (online.data as { finalText: string }).finalText;
    expect(onlineText.match(/实际脚本：/g)).toHaveLength(1);
    expect(onlineText).not.toContain("| unselected |");
    expect(onlineText).not.toContain("选择：/data/value\n");
  } finally {
    await f.close();
  }
});

test("new present schema accepts only copied refs, with strict one-level decoding", async () => {
  const f = await fixture();
  try {
    const old = { status: "complete", sources: [{ toolCallId: "read", pointer: "/data/values" }] };
    expect(f.present.input.safeParse({ finalize: old }).success).toBe(false);
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2:B3" },
      "read",
    );
    const e = await receipt(f, "read");
    const current = { status: "complete", sources: e.sources };
    expect(f.present.input.safeParse({ finalize: current }).success).toBe(true);
    expect(f.present.input.safeParse({ finalize: JSON.stringify(current) }).success).toBe(true);
    expect(
      f.present.input.safeParse({ finalize: JSON.stringify(JSON.stringify(current)) }).success,
    ).toBe(false);
    for (const key of ["value", "title", "note", "pointer", "toolCallId"])
      expect(
        f.present.input.safeParse({
          finalize: { ...current, sources: [{ ...e.sources[0], [key]: "forged" }] },
        }).success,
      ).toBe(false);
  } finally {
    await f.close();
  }
});

test("new refs preserve Unicode, slash and tilde fields and never infer units", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"}); return {"金额/每~项🙂":12.5,note:"原始解释",confirmed:true};`,
      },
      "调用/~🙂",
    );
    const e = await receipt(f, "调用/~🙂");
    const metric = e.candidates.items.find((c) => c.pointer === "/data/value/金额~1每~0项🙂")!;
    expect(metric).toMatchObject({
      valueType: "number",
      field: { name: "金额/每~项🙂", pointer: "/data/value/金额~1每~0项🙂" },
      unit: "未提供",
    });
    const selected = e.candidates.items
      .filter((c) =>
        [metric.pointer, "/data/value/note", "/data/value/confirmed"].includes(c.pointer),
      )
      .map((c) => ({ refId: c.refId }));
    expect(await finish(f, selected)).toMatchObject({
      status: "ok",
      data: { finalText: expect.stringContaining("原始解释") },
    });
    expect(await finish(f, [{ refId: metric.refId.replace("nr1:", "nr2:") }])).toMatchObject({
      status: "error",
    });
  } finally {
    await f.close();
  }
});

test("new refs reject cross-session, cross-agent, hidden, stale and undisplayed selections", async () => {
  const f = await fixture();
  try {
    const args = { path: "book.xlsx", mode: "range", range: "Data!B2:B3" };
    await f.execute("workbook_read", args, "read");
    const e = await receipt(f, "read");
    const input = f.present.input.parse({ finalize: { status: "complete", sources: e.sources } });
    for (const ctx of [
      { ...f.ctx, agentId: "other" },
      { ...f.ctx, sessionId: "other" },
    ])
      expect(await f.present.execute(input, ctx)).toMatchObject({
        status: "error",
        error: { code: "INVALID_ARGUMENT" },
      });
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"});return {total:12.5,padding:"x".repeat(20000)};`,
      },
      "hidden",
    );
    const hidden = { refId: 'nr1:["hidden","/data/value/total"]' };
    expect(await finish(f, [hidden])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"});return Object.fromEntries(Array.from({length:250},(_,i)=>["metric"+i,i]));`,
      },
      "catalog",
    );
    const catalog = await receipt(f, "catalog");
    expect(catalog.candidates).toMatchObject({
      total: 250,
      truncated: true,
      shown: catalog.candidates.items.length,
    });
    expect(catalog.candidates.items.some((c) => c.pointer === "/data/value/metric249")).toBe(false);
    expect(await finish(f, [{ refId: 'nr1:["catalog","/data/value/metric249"]' }])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    // One invalid reference poisons the whole submission; never silently drop it.
    expect(await finish(f, [...e.sources, hidden])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    f.log.rebuild("s");
    expect(await finish(f, e.sources)).toMatchObject({ status: "ok" });
    await f.execute(
      "workbook_edit",
      { path: "book.xlsx", ops: [{ op: "cells.set", range: "Data!B2", values: [[99]] }] },
      "edit-after-read",
    );
    expect(await finish(f, e.sources)).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
  } finally {
    await f.close();
  }
});

test("root and child overlap counts each leaf once, with original limits unchanged", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"});return Object.fromEntries(Array.from({length:13},(_,i)=>["metric"+i,Array.from({length:8},()=>12.5)]));`,
      },
      "overlap",
    );
    const e = await receipt(f, "overlap");
    const sources = e.candidates.items
      .filter((c) => c.pointer === "/data/value" || /^\/data\/value\/metric\d+$/.test(c.pointer))
      .map((c) => ({ refId: c.refId }));
    expect(sources).toHaveLength(14);
    const result = await finish(f, sources);
    expect(result).toMatchObject({ status: "ok" });
    const text = (result.data as { finalText: string }).finalText;
    expect(text.match(/\| 12.5 \|/g)).toHaveLength(104);
    expect(
      f.present.input.safeParse({
        finalize: { status: "complete", sources: Array.from({ length: 33 }, () => sources[0]) },
      }).success,
    ).toBe(false);
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"range",range:"Data!B2:B3"});return {number:1,text:Array.from({length:180},()=>"<".repeat(28))};`,
      },
      "render-limit",
    );
    const large = await receipt(f, "render-limit");
    const root = large.candidates.items.find((c) => c.pointer === "/data/value")!;
    expect(root).toBeDefined();
    expect(await finish(f, [{ refId: root.refId }])).toMatchObject({
      status: "error",
      error: { code: "LIMIT_EXCEEDED" },
    });
  } finally {
    await f.close();
  }
});

test("text and boolean script explanations remain selectable alongside actual numeric evidence", async () => {
  const f = await fixture();
  try {
    await f.execute(
      "workbook_read",
      { path: "book.xlsx", mode: "range", range: "Data!B2:B3" },
      "numbers",
    );
    const numbers = await receipt(f, "numbers");
    await f.execute(
      "run_script",
      {
        code: `await wb.read({path:"book.xlsx",mode:"objects"});return {refreshed:false,note:"未刷新，仅设置下次打开刷新标记"};`,
      },
      "explanation",
    );
    const explanation = await receipt(f, "explanation");
    expect(explanation.sources).toEqual([]);
    const root = explanation.candidates.items.find((c) => c.pointer === "/data/value")!;
    expect(await finish(f, [...numbers.sources, { refId: root.refId }])).toMatchObject({
      status: "ok",
      data: { finalText: expect.stringContaining("未刷新，仅设置下次打开刷新标记") },
    });
    expect(await finish(f, [{ refId: root.refId }])).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
  } finally {
    await f.close();
  }
});
