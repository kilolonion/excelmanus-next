import { createHash } from "node:crypto";
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
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { exportXlsx, pendingChanges } from "../src/checkpoint.ts";
import { workbookEditTool } from "../src/edit.ts";
import type { DocMutation } from "../src/engine.ts";
import {
  externalFormulaIndexes,
  externalLinkMetadata,
  isExternalFormula,
} from "../src/external-links.ts";
import type { ChangeOp } from "../src/ops.ts";
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

const fixture = (name: string) =>
  Buffer.from(
    readFileSync(new URL(`./fixtures/${name}.base64`, import.meta.url), "utf8"),
    "base64",
  );
const source = fixture("external-links.xlsx");
const companion = fixture("book1.xlsx");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sheetPart = "xl/worksheets/sheet1.xml";
const migrations = [
  ...KERNEL_MIGRATIONS,
  DOCUMENTS_MIGRATION,
  DOC_OPS_MIGRATION,
  BACKUPS_MIGRATION,
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
];

function setup(bytes: Uint8Array = source) {
  const dir = mkdtempSync(join(tmpdir(), "external-links-"));
  const db = openDb(join(dir, "test.sqlite"), migrations);
  const svc = new DocumentService(db);
  writeFileSync(join(dir, "external-links.xlsx"), bytes);
  writeFileSync(join(dir, "book1.xlsx"), companion);
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('w','w',?,1,0,'2026-10-21T00:00:00.000Z')",
  ).run(dir);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    agentId: "main",
    sessionId: "s",
    toolCallId: "external-test",
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
  return {
    dir,
    db,
    svc,
    ctx,
    close: async () => {
      await svc.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function patchedWorkbook(bytes: Uint8Array, patch: (xml: string) => string) {
  const parts = unzipSync(bytes);
  parts["xl/workbook.xml"] = strToU8(patch(strFromU8(parts["xl/workbook.xml"]!)));
  return zipSync(parts);
}

test("real fixture identities and relative external link are frozen", () => {
  expect(hash(source)).toBe("c83865c79e2fb92b98c9859f5952a2f7897d9022e0d5db7e278087a4b9c03ee0");
  expect(hash(companion)).toBe("89774a97de49613d58f015db411e9e164f239257b32055a1f4086a69e3e532ff");
  const parts = unzipSync(source);
  expect(strFromU8(parts["xl/externalLinks/_rels/externalLink1.xml.rels"]!)).toContain(
    'Target="book1.xlsx"',
  );
  expect(strFromU8(parts["xl/externalLinks/externalLink1.xml"]!)).toContain("hello world");
});

test.each([
  ["fully prefixed workbook", companion],
  [
    "default root with prefixed sheets",
    patchedWorkbook(companion, (xml) =>
      xml
        .replace(
          "<x:workbook",
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        )
        .replace("</x:workbook>", "</workbook>"),
    ),
  ],
] as const)(
  "standard workbook namespaces import without rewriting original parts: %s",
  (_name, bytes) => {
    const imported = importXlsx(bytes, "book1.xlsx");
    expect(imported.snapshot.sheetOrder).toHaveLength(1);
    const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!]!;
    expect(sheet.name).toBe("Sheet1");
    expect(sheet.cellData?.[0]?.[0]?.v).toBe("hello world");
    expect(imported.preservation?.parts["xl/workbook.xml"]).toEqual(
      unzipSync(bytes)["xl/workbook.xml"],
    );
  },
);

test("ordinary cell edit checkpoints while all external formulas, caches and other ZIP parts remain byte-identical", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
    const result = await workbookEditTool(t.svc).execute(
      {
        path: "external-links.xlsx",
        ops: [{ op: "cells.set", range: "Sheet1!A1", values: [[77]] }],
      },
      t.ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    await t.svc.checkpoint(opened.meta.id, t.dir);
    const output = readFileSync(join(t.dir, "external-links.xlsx"));
    const before = unzipSync(source),
      after = unzipSync(output);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(
      Object.keys(before).filter((part) => hash(before[part]!) !== hash(after[part]!)),
    ).toEqual([sheetPart]);
    expect(
      strFromU8(after[sheetPart]!)
        .replace('<row r="1"><c r="A1"><v>77</v></c></row>', "")
        .replace('ref="A1:B2"', 'ref="B2"'),
    ).toBe(strFromU8(before[sheetPart]!));
    const saved = importXlsx(output, "saved.xlsx").snapshot;
    const sheet = saved.sheets[saved.sheetOrder[0]!]!;
    expect(sheet.cellData?.[0]?.[0]?.v).toBe(77);
    expect(sheet.cellData?.[1]?.[1]).toMatchObject({ f: "=[1]Sheet1!$A$1", v: "hello world" });
    expect(readFileSync(join(t.dir, "book1.xlsx"))).toEqual(companion);
  } finally {
    await t.close();
  }
}, 60000);

const forbiddenOps: Array<[string, ChangeOp]> = [
  [
    "change external formula",
    { op: "cells.set", range: "Sheet1!B2", values: [["=[1]Sheet1!$A$2"]] },
  ],
  ["replace external formula with value", { op: "cells.set", range: "Sheet1!B2", values: [[9]] }],
  ["clear external formula", { op: "cells.clear", range: "Sheet1!B2", what: "contents" }],
  [
    "create external formula",
    { op: "cells.set", range: "Sheet1!C3", values: [["='[book1.xlsx]Sheet1'!$A$1"]] },
  ],
  [
    "copy external formula",
    { op: "cells.fill", source: "Sheet1!B2", range: "Sheet1!B3", mode: "copy" },
  ],
  [
    "sort external formula",
    { op: "sort", range: "Sheet1!A1:C3", header: false, keys: [{ column: 2, order: "asc" }] },
  ],
  [
    "table calculated column introduces external formula",
    {
      op: "table.add",
      range: "Sheet1!D1:D3",
      name: "ExtTable",
      columns: [{ name: "Amount", formula: "=[1]Sheet1!A1" }],
    },
  ],
];
test.each(forbiddenOps)(
  "unsupported external content edits reject the whole mixed batch before writes: %s",
  async (_name, op) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const before = await t.svc.snapshot(opened.meta.id, t.dir);
      const entry = await t.svc.entry(opened.meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: before.meta.rev,
        source: { kind: "script", id: "s:main" },
        sessionId: "s",
        ops: [{ op: "cells.set", range: "Sheet1!A1", values: [[77]] }, op],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(before.meta.rev);
      expect((await t.svc.snapshot(opened.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
      expect(
        t.db.prepare("SELECT count(*) AS n FROM doc_ops WHERE doc_id=?").get(opened.meta.id),
      ).toEqual({ n: 0 });
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
      expect(readFileSync(join(t.dir, "book1.xlsx"))).toEqual(companion);
    } finally {
      await t.close();
    }
  },
  60000,
);

test.each(["user", "agent", "script"] as const)(
  "raw %s mutations cannot replace an external formula or partially commit a mixed batch",
  async (kind) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const before = await t.svc.snapshot(opened.meta.id, t.dir);
      const entry = await t.svc.entry(opened.meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const mutation: DocMutation = {
        id: "sheet.mutation.set-range-values",
        params: {
          unitId: before.snapshot.id,
          subUnitId: before.snapshot.sheetOrder[0],
          trigger: "sheet.command.set-range-values",
          cellValue: { 0: { 0: { v: 77 } }, 1: { 1: { f: "=[1]Sheet1!$A$2", v: null } } },
        },
      };
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: before.meta.rev,
        source: { kind, id: "s:main" },
        sessionId: "s",
        mutations: [mutation],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(before.meta.rev);
      expect((await t.svc.snapshot(opened.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    } finally {
      await t.close();
    }
  },
  60000,
);

test("public metadata exposes target and both saved caches without accessing the companion", async () => {
  const t = setup();
  rmSync(join(t.dir, "book1.xlsx"));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw Error("unexpected external access");
  });
  try {
    const read = workbookTools(t.svc).find((tool) => tool.name === "workbook_read")!;
    const result = await read.execute({ path: "external-links.xlsx", mode: "objects" }, t.ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.data).toMatchObject({
      preserved: {
        externalLinks: ["xl/externalLinks/externalLink1.xml"],
        externalLinkDetails: {
          source: "preserved_package",
          updated: false,
          links: [
            {
              index: 1,
              relationshipId: "rId2",
              part: "xl/externalLinks/externalLink1.xml",
              kind: "externalBook",
              linked: true,
              target: { raw: "book1.xlsx", mode: "External", relationshipId: "rId1" },
              sheetNames: ["Sheet1"],
              cache: {
                source: "saved_external_link",
                cells: [
                  {
                    sheetId: "0",
                    sheet: "Sheet1",
                    cell: "A1",
                    type: "str",
                    rawValue: "hello world",
                    present: true,
                  },
                ],
                totalCells: 1,
                returnedCells: 1,
                truncated: false,
              },
            },
          ],
          formulaCaches: [
            {
              sheet: "Sheet1",
              sheetPart,
              cell: "B2",
              formula: "=[1]Sheet1!$A$1",
              linkIndexes: [1],
              cache: {
                source: "saved_worksheet",
                type: "str",
                rawValue: "hello world",
                present: true,
              },
            },
          ],
          totalFormulaCells: 1,
          returnedFormulaCells: 1,
          truncated: false,
        },
      },
      checkpointExternalLinks: {
        source: "preserved_package",
        checkpointRev: 0,
        currentRev: 0,
        isCurrent: true,
        packageState: "confirmed_checkpoint",
      },
    });
    expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await t.close();
  }
}, 60000);

test.each(["api", "op", "mixed"] as const)(
  "explicit external recalculate is rejected before revision or backup: %s",
  async (route) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const before = await t.svc.snapshot(opened.meta.id, t.dir);
      const entry = await t.svc.entry(opened.meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      if (route === "api")
        await expect(t.svc.recalculate(opened.meta.id, t.dir)).rejects.toMatchObject({
          code: "UNSUPPORTED_FEATURE",
        });
      else {
        const result = await t.svc.submit(opened.meta.id, t.dir, {
          baseRev: 0,
          source: { kind: "agent", id: "s:main" },
          ops:
            route === "mixed"
              ? [{ op: "cells.set", range: "Sheet1!A1", values: [[77]] }, { op: "recalculate" }]
              : [{ op: "recalculate" }],
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: false,
          code: "UNSUPPORTED_FEATURE",
        });
        expect(execute).not.toHaveBeenCalled();
      }
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(before.meta.rev);
      expect((await t.svc.snapshot(opened.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    } finally {
      await t.close();
    }
  },
  60000,
);

test("checkpoint never substitutes a derived external error for the original saved cache, including an untouched or restyled cell", () => {
  for (const style of [false, true]) {
    const imported = importXlsx(source, "external-links.xlsx");
    const after = structuredClone(imported.snapshot),
      sid = after.sheetOrder[0]!;
    after.sheets[sid]!.cellData![0] = { 0: { v: 77, t: 2 } };
    after.sheets[sid]!.cellData![1]![1] = {
      f: "=[1]Sheet1!$A$1",
      v: "#REF!",
      t: 4,
      ...(style ? { s: { bl: 1 } } : {}),
    };
    const changes = pendingChanges([
      {
        sourceKind: "agent",
        writeSet: {
          ranges: [
            { sheetId: sid, r0: 0, c0: 0, r1: 0, c1: 0 },
            ...(style ? [{ sheetId: sid, r0: 1, c0: 1, r1: 1, c1: 1 }] : []),
          ],
          structural: [],
        },
      },
    ]);
    const output = unzipSync(exportXlsx(imported, after, imported.snapshot, changes));
    expect(strFromU8(output[sheetPart]!)).toContain("<f>[1]Sheet1!$A$1</f><v>hello world</v>");
    expect(strFromU8(output[sheetPart]!)).not.toContain("#REF!");
    expect(strFromU8(output[sheetPart]!)).toMatch(/<c\b[^>]*\br="B2"[^>]*\bt="str"/);
    expect(output["xl/externalLinks/externalLink1.xml"]).toEqual(
      unzipSync(source)["xl/externalLinks/externalLink1.xml"],
    );
  }
});

test("style-only sparse UI patch leaves external formula and cache intact", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
    const before = await t.svc.snapshot(opened.meta.id, t.dir);
    const result = await t.svc.submit(opened.meta.id, t.dir, {
      baseRev: 0,
      source: { kind: "user", id: "style" },
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: before.snapshot.id,
            subUnitId: before.snapshot.sheetOrder[0],
            trigger: "sheet.command.set-style",
            cellValue: { 1: { 1: { s: { bl: 1 } } } },
          },
        },
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await t.svc.checkpoint(opened.meta.id, t.dir);
    const parts = unzipSync(readFileSync(join(t.dir, "external-links.xlsx")));
    expect(strFromU8(parts[sheetPart]!)).toContain("<f>[1]Sheet1!$A$1</f><v>hello world</v>");
    expect(parts["xl/externalLinks/externalLink1.xml"]).toEqual(
      unzipSync(source)["xl/externalLinks/externalLink1.xml"],
    );
  } finally {
    await t.close();
  }
}, 60000);

test.each(['="[1]Sheet1!A1"', "=SUM(Table1[Amount])", "=1+1"])(
  "ordinary formula syntax is not mistaken for an external reference: %s",
  async (formula) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "agent", id: "normal" },
        ops: [{ op: "cells.set", range: "Sheet1!C3", values: [[formula]] }],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      await t.svc.checkpoint(opened.meta.id, t.dir);
      expect(
        strFromU8(unzipSync(readFileSync(join(t.dir, "external-links.xlsx")))[sheetPart]!),
      ).toContain("<f>[1]Sheet1!$A$1</f><v>hello world</v>");
    } finally {
      await t.close();
    }
  },
  60000,
);

test.each([
  ["=[1]外部名称", true],
  ["=server|topic!item", true],
  ["=app|'topic'!item", true],
  ["='Sales|2026'!A1", false],
  ['="server|topic!item"', false],
  ["=SUM(Table1[Amount])", false],
] as const)(
  "external syntax recognizer distinguishes authoring boundary: %s",
  (formula, expected) => {
    expect(isExternalFormula(formula)).toBe(expected);
  },
);

test.each(["=[1]外部名称", "=app|'topic'!item"])(
  "external names and DDE introduction reject before commands: %s",
  async (formula) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const entry = await t.svc.entry(opened.meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "agent", id: "boundary" },
        ops: [
          { op: "cells.set", range: "Sheet1!A1", values: [[77]] },
          { op: "cells.set", range: "Sheet1!C3", values: [[formula]] },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(0);
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    } finally {
      await t.close();
    }
  },
);

test("external defined-name indirection is conservatively read-only before applying even an ordinary edit", async () => {
  const bytes = patchedWorkbook(source, (xml) =>
    xml.replace(
      "<calcPr",
      '<definedNames><definedName name="Rate">[1]Sheet1!$A$1</definedName></definedNames><calcPr',
    ),
  );
  const t = setup(bytes);
  try {
    const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
    const entry = await t.svc.entry(opened.meta.id, t.dir);
    const execute = vi.spyOn(entry.live.boot, "executeCommand");
    const result = await t.svc.submit(opened.meta.id, t.dir, {
      baseRev: 0,
      source: { kind: "agent", id: "indirect" },
      ops: [
        { op: "cells.set", range: "Sheet1!A1", values: [[77]] },
        { op: "cells.set", range: "Sheet1!C3", values: [["=Rate+1"]] },
      ],
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FEATURE",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(t.svc.headRev(opened.meta.id)).toBe(0);
    expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(Buffer.from(bytes));
  } finally {
    await t.close();
  }
});

test("metadata does not invent relationships, empty or missing caches, or shared formula coverage", () => {
  const parts = unzipSync(source);
  const external = "xl/externalLinks/externalLink1.xml",
    rel = "xl/externalLinks/_rels/externalLink1.xml.rels";
  parts[sheetPart] = strToU8(
    strFromU8(parts[sheetPart]!)
      .replace("<v>hello world</v>", "")
      .replace("</row>", '<c r="C2"><f t="shared" si="9"/><v>123</v></c></row>'),
  );
  parts[external] = strToU8(strFromU8(parts[external]!).replace("<v>hello world</v>", "<v/>"));
  const metadata = externalLinkMetadata(parts);
  expect(metadata.formulaCaches[0]?.cache).toMatchObject({ present: false, type: "str" });
  expect(metadata.formulaCaches[0]?.cache).not.toHaveProperty("rawValue");
  expect(metadata.links[0]?.cache?.cells[0]).toMatchObject({ present: true, rawValue: "" });
  expect(metadata).toMatchObject({
    formulaCoverage: "explicit_formula_text_only",
    unresolvedSharedFormulaCells: 1,
    totalFormulaCells: 1,
  });
  const originalRel = parts[rel]!;
  parts[rel] = strToU8(
    strFromU8(originalRel).replace(
      'Target="book1.xlsx"',
      'Target="https://invalid.example/not-accessed.xlsx"',
    ),
  );
  expect(externalLinkMetadata(parts).links[0]?.target?.raw).toBe(
    "https://invalid.example/not-accessed.xlsx",
  );
  parts[rel] = strToU8(
    strFromU8(originalRel).replace(
      "</Relationships>",
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="other.xlsx" TargetMode="External"/></Relationships>',
    ),
  );
  expect(externalLinkMetadata(parts).links[0]).toMatchObject({
    linked: false,
    kind: "externalBook",
  });
  expect(externalLinkMetadata(parts).links[0]).not.toHaveProperty("target");
  parts[rel] = originalRel;
  parts[external] = strToU8(
    strFromU8(parts[external]!).replace(
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      'xmlns:r="urn:not-rel"',
    ),
  );
  expect(externalLinkMetadata(parts).links[0]?.linked).toBe(false);
});

test("metadata saved external cache output is bounded and explicit about truncation", () => {
  const parts = unzipSync(source),
    external = "xl/externalLinks/externalLink1.xml";
  parts[external] = strToU8(
    strFromU8(parts[external]!).replace(
      '<cell r="A1" t="str"><v>hello world</v></cell>',
      Array.from({ length: 2100 }, (_, i) => `<cell r="A${i + 1}" t="n"><v>${i}</v></cell>`).join(
        "",
      ),
    ),
  );
  const cache = externalLinkMetadata(parts).links[0]?.cache;
  expect(cache).toMatchObject({ totalCells: 2100, truncated: true });
  expect(cache!.returnedCells).toBeGreaterThan(0);
  expect(cache!.returnedCells).toBeLessThan(2100);
  expect(JSON.stringify(cache!.cells).length).toBeLessThan(17000);
});

test.each(["synchronous", "asynchronous"] as const)(
  "controlled %s engine result cannot persist an external error through the actual actor/checkpoint",
  async (route) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const entry = await t.svc.entry(opened.meta.id, t.dir),
        sid = entry.live.save().sheetOrder[0]!;
      const inject = async () => {
        expect(
          await entry.live.boot.executeCommand("sheet.mutation.set-range-values", {
            unitId: entry.live.unitId,
            subUnitId: sid,
            cellValue: {
              1: { 1: { f: "=[1]Sheet1!$A$1", v: "#REF!", t: 4 } },
              2: { 2: { f: "=1+1", v: 2, t: 2 } },
            },
          }),
        ).toBe(true);
      };
      const waitCalc = entry.live.boot.waitCalc.bind(entry.live.boot);
      const wait =
        route === "synchronous"
          ? vi.spyOn(entry.live.boot, "waitCalc").mockImplementation(async (...args) => {
              const done = await waitCalc(...args);
              await inject();
              return done;
            })
          : undefined;
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "agent", id: "engine" },
        ops: [
          { op: "cells.set", range: "Sheet1!A1", values: [[77]] },
          { op: "cells.set", range: "Sheet1!C3", values: [["=1+1"]] },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      wait?.mockRestore();
      if (route === "asynchronous") {
        await inject();
        entry.live.capture.onEngineResults?.();
        await entry.tail;
      }
      expect(entry.live.save().sheets[sid]?.cellData?.[1]?.[1]?.v).toBe("#REF!");
      const rows = t.db
        .prepare("SELECT mutations FROM doc_ops WHERE doc_id=? ORDER BY rev")
        .all(opened.meta.id) as { mutations: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.mutations).join("")).not.toContain("#REF!");
      expect(rows.map((r) => r.mutations).join("")).toContain('"2"');
      const read = workbookTools(t.svc).find((tool) => tool.name === "workbook_read")!;
      const liveRead = await read.execute(
        {
          path: "external-links.xlsx",
          mode: "range",
          range: "Sheet1!B2",
          facets: ["values", "formulas"],
        },
        t.ctx,
      );
      expect(liveRead).toMatchObject({
        status: "ok",
        data: {
          values: [["#REF!"]],
          sourceFile: { calculation: "computed-in-memory-not-persisted" },
        },
      });
      const savedRead = await read.execute({ path: "external-links.xlsx", mode: "objects" }, t.ctx);
      expect(savedRead).toMatchObject({
        status: "ok",
        data: {
          preserved: {
            externalLinkDetails: {
              updated: false,
              formulaCaches: [{ cache: { source: "saved_worksheet", rawValue: "hello world" } }],
              links: [
                { cache: { source: "saved_external_link", cells: [{ rawValue: "hello world" }] } },
              ],
            },
          },
          sourceFile: { calculation: "computed-in-memory-not-persisted" },
          checkpointExternalLinks: { isCurrent: false, packageState: "preserved_base_only" },
        },
      });
      expect(await t.svc.sourceStatus(opened.meta.id, t.dir)).toMatchObject({
        calculation: "computed-in-memory-not-persisted",
      });
      await t.svc.checkpoint(opened.meta.id, t.dir);
      const out = unzipSync(readFileSync(join(t.dir, "external-links.xlsx")));
      expect(strFromU8(out[sheetPart]!)).toContain("<f>[1]Sheet1!$A$1</f><v>hello world</v>");
      expect(strFromU8(out[sheetPart]!)).not.toContain("#REF!");
      for (const part of [
        "xl/externalLinks/externalLink1.xml",
        "xl/externalLinks/_rels/externalLink1.xml.rels",
      ])
        expect(out[part]).toEqual(unzipSync(source)[part]);
      // Introducing the ordinary local formula legitimately invalidates calcChain, not the external relation.
      expect(strFromU8(out["xl/_rels/workbook.xml.rels"]!)).toBe(
        strFromU8(unzipSync(source)["xl/_rels/workbook.xml.rels"]!).replace(
          /<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/,
          "",
        ),
      );
      expect(readFileSync(join(t.dir, "book1.xlsx"))).toEqual(companion);
      expect(await t.svc.sourceStatus(opened.meta.id, t.dir)).toMatchObject({
        calculation: "computed-in-memory-not-persisted",
      });
      await t.svc.close();
      const reopened = new DocumentService(t.db);
      try {
        const same = await reopened.open("w", t.dir, "external-links.xlsx");
        const restored = await reopened.snapshot(same.meta.id, t.dir);
        expect(
          restored.snapshot.sheets[restored.snapshot.sheetOrder[0]!]!.cellData?.[1]?.[1],
        ).toMatchObject({ f: "=[1]Sheet1!$A$1", v: "hello world" });
        expect(await reopened.sourceStatus(same.meta.id, t.dir)).toMatchObject({
          calculation: "no-unpersisted-calculation-observed",
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await t.close();
    }
  },
  60000,
);

test.each(["sheet.mutation.move-rows", "sheet.mutation.move-columns"])(
  "raw structure movement cannot move an external formula before applying a mixed batch: %s",
  async (id) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, "external-links.xlsx");
      const entry = await t.svc.entry(opened.meta.id, t.dir),
        before = entry.live.save(),
        sid = before.sheetOrder[0]!;
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await t.svc.submit(opened.meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "user", id: "move" },
        mutations: [
          {
            id: "sheet.mutation.set-range-values",
            params: {
              unitId: before.id,
              subUnitId: sid,
              trigger: "sheet.command.set-range-values",
              cellValue: { 0: { 0: { v: 77 } } },
            },
          },
          {
            id,
            params: {
              unitId: before.id,
              subUnitId: sid,
              sourceRange: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 },
              targetRange: { startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 },
            },
          },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(0);
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    } finally {
      await t.close();
    }
  },
);

test("legal prefixed metadata and digit/space sheet names resolve only declared link indexes", () => {
  const parts = unzipSync(source),
    original = externalLinkMetadata(parts);
  for (const path of ["xl/workbook.xml", sheetPart, "xl/externalLinks/externalLink1.xml"]) {
    const xml = strFromU8(parts[path]!);
    parts[path] = strToU8(
      xml
        .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, "<$1m:$2")
        .replace(
          /<m:(workbook|worksheet|externalLink)\b/,
          '<m:$1 xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        ),
    );
  }
  expect(externalLinkMetadata(parts)).toEqual(original);
  expect(externalFormulaIndexes("=[1]2026!A1+'[1] Data'!A1")).toEqual([1]);
  parts[sheetPart] = strToU8(strFromU8(parts[sheetPart]!).replace("[1]Sheet1!", "[9]Sheet1!"));
  expect(externalLinkMetadata(parts).formulaCaches[0]).toMatchObject({
    linkIndexes: [9],
    association: "unknown",
  });
});

test.each([false, true])(
  "reverse mixed order and dryRun refuse before first command (dryRun=%s)",
  async (dryRun) => {
    const t = setup();
    try {
      const { meta } = await t.svc.open("w", t.dir, "external-links.xlsx"),
        entry = await t.svc.entry(meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await t.svc.submit(meta.id, t.dir, {
        baseRev: 0,
        dryRun,
        source: { kind: "agent", id: "reverse" },
        ops: [
          { op: "cells.clear", range: "Sheet1!B2", what: "all" },
          { op: "cells.set", range: "Sheet1!A1", values: [[77]] },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(meta.id)).toBe(0);
      expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(source);
    } finally {
      await t.close();
    }
  },
);

test("new workbook preview rejects external formulas without creating a file", async () => {
  const t = setup();
  try {
    const result = await t.svc.previewCreate(
      [{ op: "cells.set", range: "A1", values: [["=[1]Sheet1!A1"]] }],
      t.dir,
    );
    expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
    expect(t.db.prepare("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
  } finally {
    await t.close();
  }
});

test.each(["replace", "name"] as const)(
  "formula authoring alternate route rejects external content: %s",
  async (route) => {
    const parts = unzipSync(source);
    parts[sheetPart] = strToU8(
      strFromU8(parts[sheetPart]!).replace("</row>", '<c r="C2"><f>1+1</f><v>2</v></c></row>'),
    );
    const bytes = zipSync(parts),
      t = setup(bytes);
    try {
      const { meta } = await t.svc.open("w", t.dir, "external-links.xlsx"),
        entry = await t.svc.entry(meta.id, t.dir);
      const execute = vi.spyOn(entry.live.boot, "executeCommand");
      const result = await t.svc.submit(meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "agent", id: "route" },
        ...(route === "replace"
          ? {
              ops: [
                {
                  op: "find_replace" as const,
                  range: "Sheet1!C2",
                  find: "1+1",
                  replacement: "[1]Sheet1!A1",
                  regex: false,
                  caseSensitive: false,
                  formulas: true,
                },
              ],
            }
          : {
              mutations: [
                {
                  id: "formula.mutation.set-defined-name",
                  params: {
                    unitId: entry.live.unitId,
                    id: "rate",
                    name: "Rate",
                    formulaOrRefString: "=[1]Sheet1!A1",
                  },
                },
              ],
            }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_FEATURE",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(t.svc.headRev(meta.id)).toBe(0);
      expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(Buffer.from(bytes));
    } finally {
      await t.close();
    }
  },
);

test("shared external followers preserve original empty f and saved cache under a controlled style-only export", () => {
  const parts = unzipSync(source);
  parts[sheetPart] = strToU8(
    strFromU8(parts[sheetPart]!)
      .replace("<f>[1]Sheet1!$A$1</f>", '<f t="shared" si="0" ref="B2:C2">[1]Sheet1!$A$1</f>')
      .replace("</row>", '<c r="C2" t="str"><f t="shared" si="0"/><v>hello world</v></c></row>'),
  );
  const imported = importXlsx(zipSync(parts), "shared.xlsx"),
    after = structuredClone(imported.snapshot),
    sid = after.sheetOrder[0]!;
  const follower = after.sheets[sid]!.cellData![1]![2]!;
  expect(follower.f).toContain("[1]");
  follower.v = "#REF!";
  follower.t = 4;
  follower.s = { bl: 1 };
  const changes = pendingChanges([
    {
      sourceKind: "user",
      writeSet: { ranges: [{ sheetId: sid, r0: 1, r1: 1, c0: 2, c1: 2 }], structural: [] },
    },
  ]);
  const output = unzipSync(exportXlsx(imported, after, imported.snapshot, changes));
  expect(strFromU8(output[sheetPart]!)).toContain('<f t="shared" si="0"/><v>hello world</v>');
  expect(strFromU8(output[sheetPart]!)).not.toContain("#REF!");
});

test("external array workbook remains conservatively read-only", async () => {
  const parts = unzipSync(source);
  parts[sheetPart] = strToU8(
    strFromU8(parts[sheetPart]!).replace(
      "<f>[1]Sheet1!$A$1</f>",
      '<f t="array" ref="B2:C2">[1]Sheet1!$A$1</f>',
    ),
  );
  const bytes = zipSync(parts),
    t = setup(bytes);
  try {
    const { meta } = await t.svc.open("w", t.dir, "external-links.xlsx"),
      entry = await t.svc.entry(meta.id, t.dir);
    const execute = vi.spyOn(entry.live.boot, "executeCommand");
    const result = await t.svc.submit(meta.id, t.dir, {
      baseRev: 0,
      source: { kind: "agent", id: "array" },
      ops: [{ op: "cells.set", range: "Sheet1!A1", values: [[77]] }],
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FEATURE",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(t.svc.headRev(meta.id)).toBe(0);
    expect(readFileSync(join(t.dir, "external-links.xlsx"))).toEqual(Buffer.from(bytes));
  } finally {
    await t.close();
  }
});

test.each([false, true])(
  "ordinary formula find_replace remains available, including preceding formatting (style=%s)",
  async (style) => {
    const parts = unzipSync(source);
    parts[sheetPart] = strToU8(
      strFromU8(parts[sheetPart]!).replace("</row>", '<c r="C2"><f>1+1</f><v>2</v></c></row>'),
    );
    const t = setup(zipSync(parts));
    try {
      const { meta } = await t.svc.open("w", t.dir, "external-links.xlsx");
      const result = await t.svc.submit(meta.id, t.dir, {
        baseRev: 0,
        source: { kind: "agent", id: "local-replace" },
        ops: [
          ...(style ? [{ op: "style.set" as const, range: "Sheet1!A1", bold: true }] : []),
          {
            op: "find_replace",
            range: "Sheet1!C2",
            find: "1+1",
            replacement: "2+2",
            regex: false,
            caseSensitive: false,
            formulas: true,
          },
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const snapshot = (await t.svc.snapshot(meta.id, t.dir)).snapshot;
      expect(snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData?.[1]?.[2]?.f).toBe("=2+2");
      await t.svc.checkpoint(meta.id, t.dir);
      expect(
        strFromU8(unzipSync(readFileSync(join(t.dir, "external-links.xlsx")))[sheetPart]!),
      ).toContain("<f>[1]Sheet1!$A$1</f><v>hello world</v>");
    } finally {
      await t.close();
    }
  },
);
