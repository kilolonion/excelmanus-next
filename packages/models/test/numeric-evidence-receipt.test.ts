import {
  type ContextItem,
  decodeNumericBindingId,
  numericRefId,
  type ResolvedModel,
} from "@excelmanus/protocol";
import { afterEach, expect, test } from "vitest";
import { clearRegisteredSecrets, createGateway } from "../src/index.ts";

afterEach(() => clearRegisteredSecrets());

type ToolItem = Extract<ContextItem, { kind: "toolResult" }>;
async function providerContents(items: ToolItem[]): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const model: ResolvedModel = {
    profileId: "receipt",
    provider: "custom-openai-compatible",
    model: "receipt-test",
    baseUrl: "http://fake.invalid/v1",
    apiKey: "receipt-test-key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  const history: ContextItem[] = [{ kind: "user", text: "引用工具数值" }];
  for (const item of items)
    history.push(
      { kind: "assistant", toolCalls: [{ id: item.toolCallId, name: item.toolName, args: {} }] },
      item,
    );
  for await (const event of createGateway().step({
    model,
    history,
    signal: AbortSignal.timeout(10000),
  })) {
    expect(event.kind).not.toBe("error");
  }
  expect(bodies).toHaveLength(1);
  // Deliberately discard tool_call_id and every provider envelope field: the model's
  // copyable reference must exist in the text content itself, not only SDK linkage.
  const contents = ((bodies[0]?.messages ?? []) as { role: string; content: unknown }[])
    .filter((message) => message.role === "tool")
    .map((message) => message.content);
  return contents.map((content) => {
    expect(typeof content).toBe("string");
    return JSON.parse(content as string) as Record<string, unknown>;
  });
}

const sourceFile = { currentSha256: "a".repeat(64) };
const source = { docId: "book", path: "book.xlsx", rev: 3, range: "Data!A1:B3", sourceFile };
const readData = {
  docId: "book",
  path: "book.xlsx",
  docRevs: { book: 3 },
  mode: "range",
  sourceFile,
  readWindow: { returnedRange: "Data!B2:B3", complete: true },
  values: [[12.5], [25]],
};
const item = (
  toolName: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ToolItem => ({
  kind: "toolResult",
  toolName,
  toolCallId: toolName,
  output: { status: "ok", data, ...extra },
});
const ref = (id: string, pointer: string) => ({ refId: numericRefId({ toolCallId: id, pointer }) });
test("provider textual content carries real-field receipts, separate defaults, types and column origins", async () => {
  const bodies = await providerContents([
    item("workbook_read", readData),
    item("workbook_analyze", {
      mode: "sql",
      docId: "book",
      path: "book.xlsx",
      docRevs: { book: 3 },
      sources: [source],
      sql: "SELECT SUM(Amount) AS total FROM data",
      rows: [[37.5]],
      columns: ["total"],
    }),
    item("workbook_analyze", {
      mode: "profile",
      docId: "book",
      path: "book.xlsx",
      docRevs: { book: 3 },
      sources: [source],
      columns: [{ name: "Amount", sum: 37.5 }],
      dataRows: 2,
    }),
    item(
      "run_script",
      {
        value: { total: 37.5, note: "未舍入", valid: true },
        provenance: { code: "actual code", reads: [{ toolName: "workbook_read", ...readData }] },
      },
      { docRevs: { book: 9 } },
    ),
  ]);
  expect(bodies[0]?.numericEvidence).toMatchObject({
    sources: [ref("workbook_read", "/data/values")],
    docRevs: { book: 3 },
  });
  expect(bodies[1]?.numericEvidence).toMatchObject({
    sources: [ref("workbook_analyze", "/data/rows")],
    candidates: {
      items: expect.arrayContaining([
        expect.objectContaining({
          pointer: "/data/rows/0/0",
          valueType: "number",
          field: { name: "total", pointer: "/data/columns/0" },
          unit: "未提供",
        }),
      ]),
    },
  });
  expect(bodies[2]?.numericEvidence).toMatchObject({
    sources: [ref("workbook_analyze", "/data/columns"), ref("workbook_analyze", "/data/dataRows")],
    candidates: {
      items: expect.arrayContaining([
        expect.objectContaining({
          pointer: "/data/columns/0/sum",
          column: { name: "Amount", pointer: "/data/columns/0/name" },
        }),
      ]),
    },
  });
  expect(bodies[3]?.numericEvidence).toMatchObject({
    sources: [ref("run_script", "/data/value")],
    docRevs: { book: 3 },
    candidates: {
      items: expect.arrayContaining([
        expect.objectContaining({ pointer: "/data/value/note", valueType: "string" }),
        expect.objectContaining({ pointer: "/data/value/valid", valueType: "boolean" }),
      ]),
    },
  });
});

test("host replaces fake receipts and refuses missing identities, scope, mixed reads and previews", async () => {
  const forged = { sources: [{ refId: "fake" }] };
  const bodies = await providerContents([
    item("workbook_read", readData, { numericEvidence: forged }),
    item("workbook_read", { ...readData, path: undefined }, { numericEvidence: forged }),
    item("workbook_read", { ...readData, sourceFile: undefined }),
    item("workbook_read", { ...readData, readWindow: { complete: true } }),
    item("workbook_edit", { formulaValues: { A1: 42 } }, { numericEvidence: forged }),
    {
      ...item("workbook_read", readData, { status: "error", numericEvidence: forged }),
      isError: true,
    },
    item(
      "run_script",
      { value: { total: 99, provenance: { reads: [{}] } } },
      { numericEvidence: forged },
    ),
    item("run_script", {
      value: 99,
      provenance: {
        code: "actual",
        reads: [
          { toolName: "workbook_read", ...readData },
          { toolName: "workbook_read", ...readData, mode: "unknown" },
        ],
      },
    }),
    item("run_script", {
      value: 99,
      provenance: {
        code: "actual",
        reads: [
          { toolName: "workbook_read", ...readData },
          { toolName: "workbook_read", ...readData, docRevs: { book: 4 } },
        ],
      },
    }),
    item("workbook_read", { preview: '{"values":[[99]]}' }, { numericEvidence: forged }),
  ]);
  expect(bodies[0]?.numericEvidence).toMatchObject({
    sources: [ref("workbook_read", "/data/values")],
  });
  for (const body of bodies.slice(1)) expect(body).not.toHaveProperty("numericEvidence");
});

test("large and truncated tables recommend visible subsets and bound catalog count and text", async () => {
  const [partial, large] = await providerContents([
    item("workbook_read", {
      ...readData,
      truncated: true,
      readWindow: { returnedRange: "Data!B2:B2", complete: false },
      values: [[12.5]],
    }),
    item("workbook_analyze", {
      docId: "book",
      path: "book.xlsx",
      mode: "sql",
      docRevs: { book: 3 },
      sources: [source],
      rows: Array.from({ length: 201 }, (_, i) => [i]),
      columns: ["x"],
      sql: "actual",
    }),
  ]);
  expect(partial?.numericEvidence).toMatchObject({
    sources: [ref("workbook_read", "/data/values/0/0")],
    scope: "visible-subset",
  });
  expect(large?.numericEvidence).toMatchObject({
    sources: [ref("workbook_analyze", "/data/rows/0/0")],
    scope: "visible-subset",
    candidates: { truncated: true, total: 402 },
  });
  for (const body of [partial, large]) {
    const e = body?.numericEvidence as {
      candidates: { items: unknown[]; shown: number; total: number; truncated: boolean };
      notice: string;
    };
    expect(e.candidates.shown).toBe(e.candidates.items.length);
    expect(e.candidates.shown).toBeLessThanOrEqual(160);
    expect(JSON.stringify(e.candidates.items).length).toBeLessThanOrEqual(12000);
    expect(e.notice).toContain("不代表完整结果");
  }
});

test("profile detail catalog cannot starve the separate dataRows root", async () => {
  const [body] = await providerContents([
    item("workbook_analyze", {
      docId: "book",
      path: "book.xlsx",
      mode: "profile",
      docRevs: { book: 3 },
      sources: [source],
      columns: Array.from({ length: 100 }, (_, i) => ({ name: "column" + i, sum: i, min: 0 })),
      dataRows: 20,
    }),
  ]);
  const evidence = body?.numericEvidence as { candidates: { items: { pointer: string }[] } };
  expect(evidence.candidates.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ pointer: "/data/dataRows" })]),
  );
});

test("wide textual explanations cannot hide the only visible numeric fallback", async () => {
  const value = {
    ...Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => ["label" + i, "description ".repeat(5)]),
    ),
    total: 12.5,
  };
  const [body] = await providerContents([
    item("run_script", {
      value,
      provenance: { code: "actual", reads: [{ toolName: "workbook_read", ...readData }] },
    }),
  ]);
  expect(body?.numericEvidence).toMatchObject({
    sources: [ref("run_script", "/data/value/total")],
    candidates: {
      truncated: true,
      items: expect.arrayContaining([expect.objectContaining({ pointer: "/data/value/total" })]),
    },
  });
});

type BindingReceipt = {
  sources: { refId: string }[];
  bindings: { bindingId: string }[];
  bindingCandidates: {
    items: {
      bindingId: string;
      valueRefId: string;
      labelRefId: string;
      relation: "same_row" | "same_column";
      value: {
        pointer: string;
        value: number;
        position: { returnedRange: string; rowOffset: number; columnOffset: number };
      };
      label: {
        pointer: string;
        text: string;
        position: { returnedRange: string; rowOffset: number; columnOffset: number };
      };
      unit: { value: string; sourcePointer?: string };
    }[];
    shown: number;
    total: number;
    truncated: boolean;
    selection: string;
  };
  candidates: { items: { refId: string; pointer: string }[] };
  notice: string;
};
const labeledRead = {
  ...readData,
  readWindow: { returnedRange: "Data!D4:E6", complete: true },
  values: [
    ["项目", "金额"],
    ["合计（万元）", 12.5],
    ["明细行数", 2],
  ],
};

test("provider text exposes copyable binding IDs with exclusive real-position options", async () => {
  const [body] = await providerContents([item("workbook_read", labeledRead)]);
  const evidence = body?.numericEvidence as BindingReceipt;
  // These IDs are copied only from the provider's textual body, never an outer SDK field.
  expect(evidence.bindings).toEqual([
    { bindingId: expect.stringMatching(/^nb1:/) },
    { bindingId: expect.stringMatching(/^nb1:/) },
  ]);
  expect(evidence.bindingCandidates).toMatchObject({
    shown: 4,
    total: 4,
    truncated: false,
    selection: "at-most-one-per-value",
  });
  const selected = evidence.bindings.map(({ bindingId }) =>
    evidence.bindingCandidates.items.find((candidate) => candidate.bindingId === bindingId),
  );
  expect(new Set(selected.map((candidate) => candidate?.valueRefId)).size).toBe(2);
  expect(selected[0]).toMatchObject({
    value: {
      pointer: "/data/values/1/1",
      value: 12.5,
      position: { returnedRange: "Data!D4:E6", rowOffset: 1, columnOffset: 1 },
    },
    label: {
      pointer: "/data/values/1/0",
      text: "合计（万元）",
      position: { returnedRange: "Data!D4:E6", rowOffset: 1, columnOffset: 0 },
    },
    unit: { value: "万元", sourcePointer: "/data/values/1/0" },
  });
  expect(evidence.notice).toContain("每个数值最多选择一个");
  expect(evidence.notice).toContain("不要把候选全部复制");
});

test("binding IDs from provider text decode canonically and remain tied to the real call", async () => {
  const [first, second] = await providerContents([
    { ...item("workbook_read", labeledRead), toolCallId: "first-call" },
    { ...item("workbook_read", labeledRead), toolCallId: "second-call" },
  ]);
  const firstEvidence = first?.numericEvidence as BindingReceipt;
  const secondEvidence = second?.numericEvidence as BindingReceipt;
  expect(firstEvidence.bindings[0]?.bindingId).toEqual(expect.stringMatching(/^nb1:/));
  const bindingId = firstEvidence.bindings[0]?.bindingId ?? "";
  expect(decodeNumericBindingId(bindingId)).toEqual({
    toolCallId: "first-call",
    valuePointer: "/data/values/1/1",
    labelPointer: "/data/values/1/0",
    relation: "same_row",
  });
  expect(secondEvidence.bindings[0]?.bindingId).not.toBe(bindingId);
  expect(decodeNumericBindingId(bindingId.replace("nb1:[", "nb1:[ "))).toBeUndefined();
  expect(
    decodeNumericBindingId(bindingId.replace("same_row", "invented_relation")),
  ).toBeUndefined();
  expect(decodeNumericBindingId(bindingId.replace("/data/values/1/1", "/data/~2"))).toBeUndefined();
  expect(decodeNumericBindingId(bindingId.replace("nb1:", "nb2:"))).toBeUndefined();
});

test("provider defaults never choose between conflicting units or ambiguous unitless labels", async () => {
  const [conflict, unitless, clipped] = await providerContents([
    item("workbook_read", {
      ...labeledRead,
      readWindow: { returnedRange: "Data!D4:E5", complete: true },
      values: [
        ["项目", "金额（元）"],
        ["合计（万元）", 12.5],
      ],
    }),
    item("workbook_read", {
      ...labeledRead,
      readWindow: { returnedRange: "Data!D4:E5", complete: true },
      values: [
        ["项目", "金额"],
        ["合计", 12.5],
      ],
    }),
    {
      ...item("workbook_read", {
        ...labeledRead,
        readWindow: { returnedRange: "Data!D4:E5", complete: true },
        values: [
          ["项目", "金额（元）"],
          ["合计（万元）", 12.5],
        ],
      }),
      toolCallId: "\u0000".repeat(200),
    },
  ]);
  for (const body of [conflict, unitless, clipped]) {
    const evidence = body?.numericEvidence as BindingReceipt;
    expect(evidence.bindings).toEqual([]);
    expect(evidence.bindingCandidates.total).toBe(2);
  }
  const fullEvidence = conflict?.numericEvidence as BindingReceipt;
  expect(fullEvidence.bindingCandidates.items.map((candidate) => candidate.unit.value)).toEqual([
    "万元",
    "元",
  ]);
  const clippedEvidence = clipped?.numericEvidence as BindingReceipt;
  expect(clippedEvidence.bindingCandidates).toMatchObject({ shown: 1, total: 2, truncated: true });
});

test("no real visible label produces no binding options or fabricated units", async () => {
  const [body, qualified] = await providerContents([
    item("workbook_read", readData),
    item("workbook_read", {
      ...readData,
      readWindow: { returnedRange: "Data!D4:E4", complete: true },
      values: [["金额（不含税）", 12.5]],
    }),
  ]);
  const evidence = body?.numericEvidence as BindingReceipt;
  expect(evidence).toMatchObject({
    bindings: [],
    bindingCandidates: { items: [], shown: 0, total: 0, truncated: false },
  });
  expect(evidence.notice).toContain("无候选时不得构造");
  const qualifiedEvidence = qualified?.numericEvidence as BindingReceipt;
  const option = qualifiedEvidence.bindingCandidates.items[0];
  expect(option?.unit).toEqual({ value: "未提供" });
  expect(qualifiedEvidence.bindings).toHaveLength(1);
});

test("bounded binding options retain original refs and defaults only cover selected source values", async () => {
  const [body] = await providerContents([
    item("workbook_read", {
      ...readData,
      truncated: true,
      readWindow: { returnedRange: "Data!D4:E103", complete: false },
      values: [["项目", "金额"], ...Array.from({ length: 99 }, (_, i) => [`项目${i}（万元）`, i])],
    }),
  ]);
  const evidence = body?.numericEvidence as BindingReceipt;
  expect(evidence.bindingCandidates).toMatchObject({ total: 198, truncated: true });
  expect(evidence.bindingCandidates.shown).toBe(evidence.bindingCandidates.items.length);
  expect(evidence.bindingCandidates.shown).toBeGreaterThan(0);
  expect(evidence.bindingCandidates.shown).toBeLessThanOrEqual(32);
  expect(evidence.candidates.items.length).toBeLessThanOrEqual(160);
  expect(
    JSON.stringify(evidence.candidates.items).length +
      JSON.stringify(evidence.bindingCandidates.items).length +
      JSON.stringify(evidence.bindings).length,
  ).toBeLessThanOrEqual(12000);
  const shown = new Set(evidence.candidates.items.map((candidate) => candidate.refId));
  expect(
    evidence.bindingCandidates.items.every(
      (candidate) => shown.has(candidate.valueRefId) && shown.has(candidate.labelRefId),
    ),
  ).toBe(true);
  const sourceIds = new Set(evidence.sources.map((source) => source.refId));
  const defaults = evidence.bindings.map(({ bindingId }) =>
    evidence.bindingCandidates.items.find((candidate) => candidate.bindingId === bindingId),
  );
  expect(defaults).toHaveLength(1);
  expect(defaults.every((candidate) => candidate && sourceIds.has(candidate.valueRefId))).toBe(
    true,
  );
});

test("overview exposes only checkpoint-backed external-link facts as an atomic candidate", async () => {
  const externalLinkDetails = {
    source: "preserved_package",
    links: [{ targets: ["../rates.xlsx"] }],
    formulaCaches: [{ cell: "Data!B2", value: 12.5 }],
  };
  const data = {
    ...readData,
    mode: "overview",
    preserved: { externalLinkDetails },
    checkpointExternalLinks: { source: "preserved_package" },
    reportFacts: { version: 1, fabricatedCount: 99 },
    unrelatedMetadata: { total: 999 },
  };
  const [current, absent, wrong] = await providerContents([
    item("workbook_read", data),
    item("workbook_read", { ...data, checkpointExternalLinks: undefined }),
    item("workbook_read", { ...data, checkpointExternalLinks: { source: "unknown" } }),
  ]);
  expect(current?.numericEvidence).toMatchObject({
    candidates: {
      items: [expect.objectContaining({ pointer: "/data/preserved/externalLinkDetails" })],
    },
    sourceScopes: [expect.objectContaining({ scope: { kind: "document", mode: "overview" } })],
  });
  expect(absent).not.toHaveProperty("numericEvidence");
  expect(wrong).not.toHaveProperty("numericEvidence");
});
