import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { workbookEditTool } from "../src/edit.ts";
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

const source = Buffer.from(
  readFileSync(new URL("./fixtures/real-macro.xlsm.base64", import.meta.url), "utf8"),
  "base64",
);
const packageSha256 = "f76c986f4ebc25c2cc57c088b2511a1269f4bd61d6223a2ab58db351da348ba6";
const projectSha256 = "f9becb822f01de291b0ec95ea4061235e1f98ea31f80d840009a6caab829ce90";
const vbaType = "http://schemas.microsoft.com/office/2006/relationships/vbaProject";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function setup(bytes: Uint8Array = source, path = "source.xlsm") {
  const dir = mkdtempSync(join(tmpdir(), "macro-evidence-"));
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
  writeFileSync(join(dir, path), bytes);
  db.prepare(
    "INSERT INTO workspaces (id,name,path,is_default,sort,created_at) VALUES ('w','w',?,1,0,'2026-10-21T00:00:00.000Z')",
  ).run(dir);
  const ctx: ToolContext = {
    workspaceId: "w",
    workspaceRoot: dir,
    agentId: "main",
    sessionId: "s",
    toolCallId: "macro-test",
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
    path,
    close: async () => {
      await svc.close().catch(() => {});
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function read(
  t: ReturnType<typeof setup>,
  mode: "overview" | "objects" = "objects",
  path = t.path,
) {
  const tool = workbookTools(t.svc).find((tool) => tool.name === "workbook_read")!;
  const result = await tool.execute({ path, mode }, t.ctx);
  expect(result.status, JSON.stringify(result.error)).toBe("ok");
  return result.data as Record<string, unknown>;
}

function variant(patch: (parts: Record<string, Uint8Array>) => void) {
  const parts = unzipSync(source);
  patch(parts);
  return zipSync(parts);
}

const literal: ChangeOp = {
  op: "cells.set",
  range: "Sheet1!A1",
  values: [["QA macro content preserved"]],
};
const earlyMethods = (svc: DocumentService) =>
  svc as unknown as {
    prepareWriteOrigin: (...args: unknown[]) => Promise<void>;
    commitEngine: (...args: unknown[]) => Promise<void>;
  };

test.each(["overview", "objects"] as const)(
  "real macro %s evidence is read-only and names the actual relationship, Default type and codeNames",
  async (mode) => {
    const t = setup();
    try {
      expect(source.byteLength).toBe(13796);
      expect(hash(source)).toBe(packageSha256);
      const opened = await t.svc.open("w", t.dir, t.path);
      const before = await t.svc.snapshot(opened.meta.id, t.dir);
      const data = await read(t, mode);
      expect(data.macroEvidence).toMatchObject({
        version: 1,
        source: "current_disk_bytes",
        package: { path: t.path, sha256: packageSha256, byteLength: 13796 },
        checkpoint: {
          checkpointRev: 0,
          currentRev: 0,
          packageRev: 0,
          isCurrent: true,
          packageState: "confirmed_checkpoint",
        },
        format: {
          macroEnabled: true,
          workbookContentType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
        },
        project: {
          status: "present",
          part: "xl/vbaProject.bin",
          byteLength: 16384,
          sha256: projectSha256,
          cfbHeaderPresent: true,
        },
        relationships: [
          {
            sourcePart: "xl/workbook.xml",
            relsPart: "xl/_rels/workbook.xml.rels",
            id: "rId7",
            type: vbaType,
            target: "vbaProject.bin",
            targetMode: null,
            resolvedPart: "xl/vbaProject.bin",
          },
        ],
        contentTypes: {
          vba: {
            contentType: "application/vnd.ms-office.vbaProject",
            source: "Default",
            match: "bin",
          },
        },
        codeNames: {
          workbook: "ThisWorkbook",
          sheets: [
            { name: "Sheet1", part: "xl/worksheets/sheet1.xml", codeName: "Sheet1" },
            { name: "Sheet2", part: "xl/worksheets/sheet2.xml", codeName: "Sheet2" },
            { name: "Sheet3", part: "xl/worksheets/sheet3.xml", codeName: "Sheet3" },
          ],
        },
        inspection: { status: "complete", reasonCode: "none" },
        cellEditSupport: { status: "conditional", reasonCode: "literal_cells_only" },
        capabilities: {
          macroExecution: false,
          runtimeValidation: false,
          inspection: "static_package_only",
        },
      });
      expect(data.docRevs).toEqual({ [opened.meta.id]: 0 });
      expect(data.sourceFile).toMatchObject({ currentSha256: packageSha256, pendingWrite: false });
      expect(readFileSync(join(t.dir, t.path))).toEqual(source);
      expect(await t.svc.snapshot(opened.meta.id, t.dir)).toEqual(before);
      expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
      expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
    } finally {
      await t.close();
    }
  },
  60000,
);

test("copy literal edit reports pending then the actual saved package; source and macro members stay unchanged", async () => {
  const t = setup();
  try {
    copyFileSync(join(t.dir, t.path), join(t.dir, "copy.xlsm"));
    const opened = await t.svc.open("w", t.dir, "copy.xlsm");
    const result = await workbookEditTool(t.svc).execute(
      { path: "copy.xlsm", ops: [literal] },
      t.ctx,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const pending = await read(t, "objects", "copy.xlsm");
    expect(pending.macroEvidence).toMatchObject({
      package: { sha256: packageSha256 },
      checkpoint: {
        checkpointRev: 0,
        currentRev: 1,
        packageRev: 0,
        isCurrent: false,
        packageState: "saved_checkpoint_not_current",
      },
    });
    expect(readFileSync(join(t.dir, "copy.xlsm"))).toEqual(source);
    await t.svc.checkpoint(opened.meta.id, t.dir);
    const output = readFileSync(join(t.dir, "copy.xlsm"));
    const data = await read(t, "objects", "copy.xlsm");
    expect(hash(output)).not.toBe(packageSha256);
    expect(data.sourceFile).toMatchObject({ currentSha256: hash(output), pendingWrite: false });
    expect(data.docRevs).toEqual({ [opened.meta.id]: 1 });
    expect(data.macroEvidence).toMatchObject({
      package: { path: "copy.xlsm", sha256: hash(output), byteLength: output.byteLength },
      checkpoint: {
        checkpointRev: 1,
        currentRev: 1,
        packageRev: 1,
        isCurrent: true,
        packageState: "confirmed_checkpoint",
      },
      project: { sha256: projectSha256, byteLength: 16384 },
      codeNames: {
        workbook: "ThisWorkbook",
        sheets: [{ codeName: "Sheet1" }, { codeName: "Sheet2" }, { codeName: "Sheet3" }],
      },
    });
    const before = unzipSync(source),
      after = unzipSync(output);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(
      Object.keys(before).filter((part) => hash(before[part]!) !== hash(after[part]!)),
    ).toEqual(["xl/worksheets/sheet1.xml"]);
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
    const imported = importXlsx(output, "copy.xlsm").snapshot;
    expect(imported.sheets[imported.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v).toBe(
      "QA macro content preserved",
    );
  } finally {
    await t.close();
  }
}, 60000);

const rejectedPackages: Array<[string, Uint8Array]> = [
  [
    "OPC signature origin in a custom directory",
    variant((p) => {
      p["custom-signatures/origin.sigs"] = new Uint8Array();
      p["custom-signatures/proof.xml"] = strToU8(
        '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
      );
      p["custom-signatures/_rels/origin.sigs.rels"] = strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="proof" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature" Target="proof.xml"/></Relationships>',
      );
      p["_rels/.rels"] = strToU8(
        strFromU8(p["_rels/.rels"]!).replace(
          "</Relationships>",
          '<Relationship Id="signature-origin" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="custom-signatures/origin.sigs"/></Relationships>',
        ),
      );
      p["[Content_Types].xml"] = strToU8(
        strFromU8(p["[Content_Types].xml"]!).replace(
          "</Types>",
          '<Override PartName="/custom-signatures/origin.sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/custom-signatures/proof.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/></Types>',
        ),
      );
    }),
  ],
  [
    "VBA signature",
    variant((p) => {
      p["xl/vbaProjectSignature.bin"] = new Uint8Array([1, 2, 3]);
      p["xl/_rels/vbaProject.bin.rels"] = strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sig" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProjectSignature" Target="vbaProjectSignature.bin"/></Relationships>',
      );
    }),
  ],
  [
    "duplicate VBA relationship",
    variant((p) => {
      p["xl/_rels/workbook.xml.rels"] = strToU8(
        strFromU8(p["xl/_rels/workbook.xml.rels"]!).replace(
          "</Relationships>",
          `<Relationship Id="vba2" Type="${vbaType}" Target="vbaProject.bin"/></Relationships>`,
        ),
      );
    }),
  ],
  [
    "external VBA target",
    variant((p) => {
      p["xl/_rels/workbook.xml.rels"] = strToU8(
        strFromU8(p["xl/_rels/workbook.xml.rels"]!).replace(
          'Target="vbaProject.bin"',
          'Target="https://example.invalid/vba.bin" TargetMode="External"',
        ),
      );
    }),
  ],
  [
    "conflicting VBA type",
    variant((p) => {
      p["[Content_Types].xml"] = strToU8(
        strFromU8(p["[Content_Types].xml"]!).replace(
          "</Types>",
          '<Override PartName="/xl/vbaProject.bin" ContentType="application/xml"/></Types>',
        ),
      );
    }),
  ],
];

test.each(rejectedPackages)(
  "macro %s is rejected before origin flush, engine commit, revision or backup",
  async (_name, bytes) => {
    const t = setup(bytes);
    try {
      const opened = await t.svc.open("w", t.dir, t.path);
      const before = await t.svc.snapshot(opened.meta.id, t.dir);
      const origin = vi.spyOn(earlyMethods(t.svc), "prepareWriteOrigin");
      const engine = vi.spyOn(earlyMethods(t.svc), "commitEngine");
      const result = await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx);
      expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
      expect(origin).not.toHaveBeenCalled();
      expect(engine).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(0);
      expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
      expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, t.path))).toEqual(Buffer.from(bytes));
      expect((await t.svc.snapshot(opened.meta.id, t.dir)).snapshot).toEqual(before.snapshot);
    } finally {
      await t.close();
    }
  },
  60000,
);

test.each([
  ["formula", { op: "cells.set", range: "Sheet1!B1", values: [["=1+1"]] }],
  ["sheet rename", { op: "sheet.rename", sheet: "Sheet1", name: "Renamed" }],
  ["style", { op: "style.set", range: "Sheet1!A1", bold: true }],
  ["sheet add", { op: "sheet.add", name: "Added" }],
] satisfies Array<[string, ChangeOp]>)(
  "mixed ordinary and unsupported macro %s batch is rejected before side effects",
  async (_name, op) => {
    const t = setup();
    try {
      const opened = await t.svc.open("w", t.dir, t.path);
      const origin = vi.spyOn(earlyMethods(t.svc), "prepareWriteOrigin");
      const engine = vi.spyOn(earlyMethods(t.svc), "commitEngine");
      const result = await workbookEditTool(t.svc).execute(
        { path: t.path, ops: [literal, op] },
        t.ctx,
      );
      expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
      expect(origin).not.toHaveBeenCalled();
      expect(engine).not.toHaveBeenCalled();
      expect(t.svc.headRev(opened.meta.id)).toBe(0);
      expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
      expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, t.path))).toEqual(source);
    } finally {
      await t.close();
    }
  },
  60000,
);

test("actor macro read does not reload or publish an external disk change as the current checkpoint", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const replacement = variant((p) => {
      p["xl/vbaProject.bin"] = p["xl/vbaProject.bin"]!.slice();
      p["xl/vbaProject.bin"]![100] = p["xl/vbaProject.bin"]![100]! ^ 1;
    });
    writeFileSync(join(t.dir, t.path), replacement);
    expect("macroEvidence" in t.svc).toBe(true);
    const svc = t.svc as DocumentService & {
      macroEvidence(id: string, root: string): Promise<Record<string, unknown>>;
    };
    const read = await svc.macroEvidence(opened.meta.id, t.dir);
    expect(read.macroEvidence).toMatchObject({
      package: { sha256: hash(replacement) },
      checkpoint: {
        checkpointRev: 0,
        currentRev: 0,
        packageRev: null,
        isCurrent: false,
        packageState: "unconfirmed_disk",
      },
      project: { sha256: hash(unzipSync(replacement)["xl/vbaProject.bin"]!) },
    });
    expect(t.svc.headRev(opened.meta.id)).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(Buffer.from(replacement));
  } finally {
    await t.close();
  }
}, 60000);

test("non-macro workbook retains normal literal editing and has no macro evidence family", async () => {
  const plain = Buffer.from(
    readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
  const t = setup(plain, "plain.xlsx");
  try {
    const result = await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const data = await read(t);
    expect(data.macroEvidence).toBeUndefined();
  } finally {
    await t.close();
  }
}, 60000);

test("checkpoint macro invariant failure preserves disk and creates no publication intent", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const result = await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    const entry = await t.svc.entry(opened.meta.id, t.dir);
    // Fault injection into the mutable preservation cache must never redefine disk evidence.
    const bytes = entry.imported.preservation!.parts["xl/vbaProject.bin"]!.slice();
    bytes[100] = bytes[100]! ^ 1;
    entry.imported.preservation!.parts["xl/vbaProject.bin"] = bytes;
    await expect(t.svc.checkpoint(opened.meta.id, t.dir)).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
    expect(t.db.prepare("SELECT count(*) n FROM doc_checkpoints").get()).toEqual({ n: 0 });
    expect(
      t.db.prepare("SELECT head_rev,checkpoint_rev FROM documents WHERE id=?").get(opened.meta.id),
    ).toEqual({ head_rev: 1, checkpoint_rev: 0 });
  } finally {
    await t.close();
  }
}, 60000);

test("submit candidate macro invariant rejects a corrupted preservation cache before revision publication", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const entry = await t.svc.entry(opened.meta.id, t.dir);
    const bytes = entry.imported.preservation!.parts["xl/vbaProject.bin"]!.slice();
    bytes[100] = bytes[100]! ^ 1;
    entry.imported.preservation!.parts["xl/vbaProject.bin"] = bytes;
    const result = await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx);
    expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
    expect(t.svc.headRev(opened.meta.id)).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT count(*) n FROM doc_checkpoints").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
    // Export validation follows the existing backup stage; it is not a zero-backup guarantee.
  } finally {
    await t.close();
  }
}, 60000);

test("cold pending macro read refuses before materialization even with an xlsx filename", async () => {
  const t = setup(source, "macro.xlsx");
  const cold = new DocumentService(t.db);
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    expect(
      await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
    ).toMatchObject({ status: "ok" });
    const entry = await t.svc.entry(opened.meta.id, t.dir);
    clearTimeout(entry.timer);
    const before = t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id);
    const ops = t.db.prepare("SELECT * FROM doc_ops").all();
    const backups = t.db.prepare("SELECT * FROM backups").all();
    const materialize = vi.spyOn(
      cold as unknown as { materialize: (...args: unknown[]) => unknown },
      "materialize",
    );
    const tool = workbookTools(cold).find((tool) => tool.name === "workbook_read")!;
    expect(await tool.execute({ path: t.path, mode: "objects" }, t.ctx)).toMatchObject({
      status: "error",
      error: { code: "VERSION_CONFLICT" },
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id)).toEqual(before);
    expect(t.db.prepare("SELECT * FROM doc_ops").all()).toEqual(ops);
    expect(t.db.prepare("SELECT * FROM backups").all()).toEqual(backups);
    expect(t.db.prepare("SELECT count(*) n FROM doc_checkpoints").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
  } finally {
    await cold.close();
    await t.close();
  }
}, 60000);

test("raw formula mutations and direct recalculation cannot bypass the macro guard; trusted literal undo still works", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const before = await t.svc.snapshot(opened.meta.id, t.dir);
    const result = await t.svc.submit(opened.meta.id, t.dir, {
      baseRev: 0,
      source: { kind: "user", id: "u" },
      mutations: [
        {
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: before.snapshot.id,
            subUnitId: before.snapshot.sheetOrder[0],
            cellValue: { 0: { 0: { v: "changed" }, 1: { f: "=1+1" } } },
          },
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_FEATURE" });
    await expect(t.svc.recalculate(opened.meta.id, t.dir)).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
    expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(
      await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
    ).toMatchObject({ status: "ok" });
    expect(
      await t.svc.revert(opened.meta.id, t.dir, 1, { kind: "script", id: "s:main" }, "s"),
    ).toMatchObject({ ok: true });
    await t.svc.checkpoint(opened.meta.id, t.dir);
    const after = await t.svc.snapshot(opened.meta.id, t.dir);
    expect(after.snapshot.sheets[after.snapshot.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v).toBe(
      before.snapshot.sheets[before.snapshot.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v,
    );
    expect(hash(unzipSync(readFileSync(join(t.dir, t.path)))["xl/vbaProject.bin"]!)).toBe(
      projectSha256,
    );
  } finally {
    await t.close();
  }
}, 60000);

test("a revision arriving between the snapshot and macro capture rejects rather than relabeling stale facts", async () => {
  const t = setup();
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const capture = t.svc.macroEvidence.bind(t.svc);
    vi.spyOn(t.svc, "macroEvidence").mockImplementationOnce(async (id, root) => {
      expect(
        await t.svc.submit(id, root, {
          baseRev: 0,
          source: { kind: "user", id: "u" },
          ops: [literal],
        }),
      ).toMatchObject({ ok: true, rev: 1 });
      return capture(id, root);
    });
    const tool = workbookTools(t.svc).find((tool) => tool.name === "workbook_read")!;
    const result = await tool.execute({ path: t.path, mode: "objects" }, t.ctx);
    expect(result).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
    expect(t.svc.headRev(opened.meta.id)).toBe(1);
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
  } finally {
    await t.close();
  }
}, 60000);

test("XML character references and a custom VBA part cannot bypass early macro write rejection", async () => {
  const bytes = variant((parts) => {
    parts["xl/opaque/project.bin"] = parts["xl/vbaProject.bin"]!;
    delete parts["xl/vbaProject.bin"];
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(parts["[Content_Types].xml"]!)
        .replaceAll("macroEnabled", "macro&#69;nabled")
        .replaceAll("vbaProject", "vbaProj&#101;ct"),
    );
    parts["xl/_rels/workbook.xml.rels"] = strToU8(
      strFromU8(parts["xl/_rels/workbook.xml.rels"]!)
        .replace('Target="vbaProject.bin"', 'Target="opaque/project.bin"')
        .replaceAll("vbaProject", "vbaProj&#101;ct"),
    );
  });
  const t = setup(bytes, "encoded.xlsx");
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    const origin = vi.spyOn(earlyMethods(t.svc), "prepareWriteOrigin");
    const result = await workbookEditTool(t.svc).execute(
      { path: t.path, ops: [literal, { op: "sheet.rename", sheet: "Sheet1", name: "Renamed" }] },
      t.ctx,
    );
    expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
    expect(origin).not.toHaveBeenCalled();
    expect(t.svc.headRev(opened.meta.id)).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM backups").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(Buffer.from(bytes));
    expect((await read(t)).macroEvidence).toMatchObject({
      project: { part: "xl/opaque/project.bin", sha256: projectSha256 },
      inspection: { status: "complete" },
    });
  } finally {
    await t.close();
  }
}, 60000);

test("comments mentioning VBA are not declarations and do not restrict ordinary workbook edits", async () => {
  const plain = Buffer.from(
    readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
  const parts = unzipSync(plain);
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(parts["[Content_Types].xml"]!).replace(
      "</Types>",
      "<!-- vbaProject macroEnabled --></Types>",
    ),
  );
  const t = setup(zipSync(parts), "plain.xlsx");
  try {
    expect(
      await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
    ).toMatchObject({ status: "ok" });
    expect((await read(t)).macroEvidence).toBeUndefined();
  } finally {
    await t.close();
  }
}, 60000);

test("a non-VBA relationship target name is not a macro declaration", async () => {
  const plain = Buffer.from(
    readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
  const parts = unzipSync(plain);
  parts["xl/theme/vbaProject-reference.xml"] = parts["xl/theme/theme1.xml"]!;
  delete parts["xl/theme/theme1.xml"];
  for (const part of ["[Content_Types].xml", "xl/_rels/workbook.xml.rels"])
    parts[part] = strToU8(
      strFromU8(parts[part]!).replaceAll("theme/theme1.xml", "theme/vbaProject-reference.xml"),
    );
  const t = setup(zipSync(parts), "plain.xlsx");
  try {
    expect(
      await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
    ).toMatchObject({ status: "ok" });
    expect((await read(t)).macroEvidence).toBeUndefined();
  } finally {
    await t.close();
  }
}, 60000);

test("sourceStatus used by file verification cannot recover a cold pending macro as a read side effect", async () => {
  const t = setup(source, "macro.xlsx");
  const cold = new DocumentService(t.db);
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    expect(
      await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
    ).toMatchObject({ status: "ok" });
    clearTimeout((await t.svc.entry(opened.meta.id, t.dir)).timer);
    const before = t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id);
    const ops = t.db.prepare("SELECT * FROM doc_ops").all();
    const backups = t.db.prepare("SELECT * FROM backups").all();
    const materialize = vi.spyOn(
      cold as unknown as { materialize: (...args: unknown[]) => unknown },
      "materialize",
    );
    await expect(
      Promise.resolve().then(() => cold.sourceStatus(opened.meta.id, t.dir)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(materialize).not.toHaveBeenCalled();
    expect(t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id)).toEqual(before);
    expect(t.db.prepare("SELECT * FROM doc_ops").all()).toEqual(ops);
    expect(t.db.prepare("SELECT * FROM backups").all()).toEqual(backups);
    expect(t.db.prepare("SELECT count(*) n FROM doc_checkpoints").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(source);
  } finally {
    await cold.close();
    await t.close();
  }
}, 60000);

test("cold non-macro sourceStatus keeps the existing normal read lifecycle", async () => {
  const plain = Buffer.from(
    readFileSync(new URL("./fixtures/book1.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
  const t = setup(plain, "plain.xlsx");
  const cold = new DocumentService(t.db);
  try {
    const opened = await t.svc.open("w", t.dir, t.path);
    expect(await cold.sourceStatus(opened.meta.id, t.dir)).toMatchObject({
      currentSha256: hash(plain),
      pendingWrite: false,
    });
    expect(t.db.prepare("SELECT count(*) n FROM doc_ops").get()).toEqual({ n: 0 });
    expect(readFileSync(join(t.dir, t.path))).toEqual(plain);
  } finally {
    await cold.close();
    await t.close();
  }
}, 60000);

test.each(["tool edit", "submit", "recalculate"] as const)(
  "cold pending macro %s rejects before recovery or any new write",
  async (action) => {
    const t = setup(source, "macro.xlsx");
    const cold = new DocumentService(t.db);
    try {
      const opened = await t.svc.open("w", t.dir, t.path);
      expect(
        await workbookEditTool(t.svc).execute({ path: t.path, ops: [literal] }, t.ctx),
      ).toMatchObject({ status: "ok" });
      clearTimeout((await t.svc.entry(opened.meta.id, t.dir)).timer);
      const before = t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id);
      const ops = t.db.prepare("SELECT * FROM doc_ops").all();
      const backups = t.db.prepare("SELECT * FROM backups").all();
      const materialize = vi.spyOn(
        cold as unknown as { materialize: (...args: unknown[]) => unknown },
        "materialize",
      );
      if (action === "tool edit") {
        expect(
          await workbookEditTool(cold).execute(
            { path: t.path, ops: [{ op: "sheet.rename", sheet: "Sheet1", name: "Renamed" }] },
            t.ctx,
          ),
        ).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
      } else if (action === "submit") {
        expect(
          await cold.submit(opened.meta.id, t.dir, {
            baseRev: 1,
            source: { kind: "user", id: "u" },
            ops: [literal],
          }),
        ).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
      } else {
        await expect(cold.recalculate(opened.meta.id, t.dir)).rejects.toMatchObject({
          code: "VERSION_CONFLICT",
        });
      }
      expect(materialize).not.toHaveBeenCalled();
      expect(t.db.prepare("SELECT * FROM documents WHERE id=?").get(opened.meta.id)).toEqual(
        before,
      );
      expect(t.db.prepare("SELECT * FROM doc_ops").all()).toEqual(ops);
      expect(t.db.prepare("SELECT * FROM backups").all()).toEqual(backups);
      expect(t.db.prepare("SELECT count(*) n FROM doc_checkpoints").get()).toEqual({ n: 0 });
      expect(readFileSync(join(t.dir, t.path))).toEqual(source);
    } finally {
      await cold.close();
      await t.close();
    }
  },
  60000,
);
