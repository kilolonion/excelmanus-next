import { KERNEL_MIGRATIONS, kernelProjections, openDb, SessionLog } from "@excelmanus/kernel";
import type { NumericPointer } from "@excelmanus/protocol";
import { ChangeOp } from "@excelmanus/workbook";
import { expect, test } from "vitest";
import { planNumericCompleteness } from "../src/numeric-completeness.ts";

function macroCompletenessFixture(
  options: {
    copy?:
      | "valid"
      | "absent"
      | "missing_baseline"
      | "wrong_source"
      | "wrong_destination"
      | "failed";
    evidence?: "missing" | "pending" | "wrong_rev" | "hidden" | "tampered";
    sourceHash?: string;
    outputSignature?: "present" | "unknown";
  } = {},
) {
  const f = fixture();
  const sourceHash = "a".repeat(64),
    outputHash = "b".repeat(64),
    vbaHash = "c".repeat(64);
  const macro = (path: string, hash: string, rev: number) => ({
    version: 1,
    source: "current_disk_bytes",
    package: { path, sha256: hash, byteLength: 13796 },
    checkpoint: {
      checkpointRev: rev,
      currentRev: rev,
      packageRev: rev,
      isCurrent: true,
      packageState: "confirmed_checkpoint",
    },
    format: {
      workbookContentType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
      macroEnabled: true,
    },
    project: {
      status: "present",
      part: "xl/vbaProject.bin",
      byteLength: 16384,
      sha256: vbaHash,
      cfbHeaderPresent: true,
    },
    relationships: [
      {
        sourcePart: "xl/workbook.xml",
        relsPart: "xl/_rels/workbook.xml.rels",
        relsSha256: "d".repeat(64),
        id: "rId7",
        type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
        target: "vbaProject.bin",
        targetMode: null,
        resolvedPart: "xl/vbaProject.bin",
      },
    ],
    contentTypes: {
      partSha256: "e".repeat(64),
      workbook: {
        contentType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
        source: "Override",
        match: "/xl/workbook.xml",
      },
      vba: { contentType: "application/vnd.ms-office.vbaProject", source: "Default", match: "bin" },
    },
    codeNames: {
      workbook: "ThisWorkbook",
      sheets: [1, 2, 3].map((n) => ({
        name: `Sheet${n}`,
        sheetId: String(n),
        relationshipId: `rId${n}`,
        part: `xl/worksheets/sheet${n}.xml`,
        codeName: `Sheet${n}`,
      })),
    },
    signatureStatus: "absent",
    inspection: { status: "complete", reasonCode: "none" },
    cellEditSupport: { status: "conditional", reasonCode: "literal_cells_only" },
    capabilities: {
      macroExecution: false,
      runtimeValidation: false,
      inspection: "static_package_only",
    },
  });
  const receipt = (
    id: string,
    path: string,
    docId: string,
    hash: string,
    rev: number,
    corrupt = false,
  ) => {
    const macroEvidence = macro(path, hash, rev);
    if (corrupt && options.outputSignature) macroEvidence.signatureStatus = options.outputSignature;
    if (corrupt && options.evidence === "pending")
      Object.assign(macroEvidence.checkpoint, {
        packageRev: rev - 1,
        checkpointRev: rev - 1,
        isCurrent: false,
        packageState: "saved_checkpoint_not_current",
      });
    if (corrupt && options.evidence === "wrong_rev") macroEvidence.checkpoint.currentRev++;
    f.receipt(id, "workbook_read", {
      ...f.base(rev, docId, path),
      sourceFile: { currentSha256: hash, pendingWrite: false },
      mode: "objects",
      packageFormat: { macroEnabled: true, vbaProjectPresent: true },
      ...(corrupt && options.evidence === "missing" ? {} : { macroEvidence }),
    });
  };
  receipt("macro-source", "source.xlsm", "source", options.sourceHash ?? sourceHash, 0);
  if (options.copy !== "absent") {
    f.event("tool.intent", {
      stepId: "copy-step",
      targets: ["source.xlsm", "out.xlsm"],
      replay: "unsafe",
      toolCallId: "macro-copy",
      toolName: "files",
      args: { ops: [{ op: "copy", path: "source.xlsm", to: "out.xlsm" }] },
      intentMeta: { workspaceId: "w", paths: { "source.xlsm": sourceHash, "out.xlsm": null } },
    });
    const data = {
      results: [
        {
          path: "source.xlsm",
          to: "out.xlsm",
          ...(options.copy === "missing_baseline"
            ? {}
            : {
                copyBaseline: {
                  version: 1,
                  sourceSha256: options.copy === "wrong_source" ? outputHash : sourceHash,
                  destinationSha256: options.copy === "wrong_destination" ? outputHash : sourceHash,
                  destinationWasAbsent: true,
                },
              }),
        },
      ],
    };
    if (options.copy === "failed")
      f.event("tool.result", {
        toolCallId: "macro-copy",
        toolName: "files",
        status: "error",
        result: { status: "error", data },
      });
    else f.receipt("macro-copy", "files", data);
  }
  receipt("macro-after", "out.xlsm", "book", outputHash, 1, true);
  if (options.evidence === "hidden")
    f.db
      .prepare(
        "UPDATE agent_context SET superseded=1 WHERE json_extract(item,'$.toolCallId')='macro-after'",
      )
      .run();
  if (options.evidence === "tampered")
    f.db
      .prepare(
        "UPDATE agent_context SET item=json_set(item,'$.output.data.macroEvidence.project.sha256',?) WHERE json_extract(item,'$.toolCallId')='macro-after'",
      )
      .run("f".repeat(64));
  f.read("selected", 1, "Sheet1", "main", "s", "book", "out.xlsm");
  const plan = () =>
    planNumericCompleteness(f.db, {
      sessionId: "s",
      agentId: "main",
      turnId: "current",
      sources: f.selected("selected"),
      currentDocument: (id) =>
        id === "book" ? { path: "out.xlsm", rev: 1 } : { path: "source.xlsm", rev: 0 },
    });
  return { ...f, plan };
}

test("macro completeness adds the current atomic family and exact successful copy baseline", () => {
  const f = macroCompletenessFixture();
  try {
    expect(f.plan()).toMatchObject({
      missing: [],
      sources: expect.arrayContaining([
        { toolCallId: "macro-after", pointer: "/data/macroEvidence" },
      ]),
      macroPreservations: [
        expect.objectContaining({
          path: "out.xlsm",
          outcome: "equal",
          copy: expect.objectContaining({
            toolCallId: "macro-copy",
            sourcePath: "source.xlsm",
            outputPath: "out.xlsm",
            sourceSha256: "a".repeat(64),
          }),
          before: expect.objectContaining({ toolCallId: "macro-source" }),
          after: expect.objectContaining({ toolCallId: "macro-after" }),
        }),
      ],
    });
  } finally {
    f.db.close();
  }
});

test("macro completeness never invents copy lineage from unrelated files with the same VBA hash", () => {
  const f = macroCompletenessFixture({ copy: "absent" });
  try {
    expect(f.plan()).toMatchObject({
      missing: [],
      macroPreservations: [],
      sources: expect.arrayContaining([
        { toolCallId: "macro-after", pointer: "/data/macroEvidence" },
      ]),
    });
  } finally {
    f.db.close();
  }
});

test("macro completeness does not claim preservation when the output signature state changes", () => {
  const f = macroCompletenessFixture({ outputSignature: "present" });
  try {
    expect(f.plan()).toMatchObject({
      missing: [],
      macroPreservations: [
        expect.objectContaining({
          outcome: "unavailable",
        }),
      ],
    });
  } finally {
    f.db.close();
  }
});

for (const copy of ["missing_baseline", "wrong_source", "wrong_destination", "failed"] as const)
  test(`macro completeness rejects copy ${copy} despite an identical VBA hash`, () => {
    const f = macroCompletenessFixture({ copy });
    try {
      expect(f.plan()).toMatchObject({
        macroPreservations: [],
        missing: expect.arrayContaining([
          expect.objectContaining({ kind: "macro_preservation", path: "out.xlsm" }),
        ]),
      });
    } finally {
      f.db.close();
    }
  });

test("macro completeness rejects a changed source package even when its VBA hash still matches", () => {
  const f = macroCompletenessFixture({ sourceHash: "f".repeat(64) });
  try {
    expect(f.plan()).toMatchObject({
      macroPreservations: [],
      missing: expect.arrayContaining([expect.objectContaining({ kind: "macro_preservation" })]),
    });
  } finally {
    f.db.close();
  }
});

for (const evidence of ["missing", "pending", "wrong_rev", "hidden", "tampered"] as const)
  test(`macro completeness requires a real current root for ${evidence} evidence`, () => {
    const f = macroCompletenessFixture({ evidence });
    try {
      expect(f.plan()).toMatchObject({
        macroPreservations: [],
        missing: expect.arrayContaining([
          expect.objectContaining({
            kind: "macro_evidence",
            path: "out.xlsm",
            reread: { toolName: "workbook_read", args: { path: "out.xlsm", mode: "objects" } },
          }),
        ]),
      });
    } finally {
      f.db.close();
    }
  });

function fixture() {
  const db = openDb(":memory:", KERNEL_MIGRATIONS);
  const log = new SessionLog(db, { projections: kernelProjections() });
  const event = (type: string, data: object, agentId = "main", sessionId = "s") =>
    log.append(sessionId, agentId, [{ type, data }]);
  event("turn.started", { turnId: "current" });
  const base = (rev: number, docId = "book", path = "out.xlsx") => ({
    docId,
    path,
    docRevs: { [docId]: rev },
    sourceFile: { currentSha256: `sha-${rev}` },
  });
  const receipt = (id: string, name: string, data: object, agentId = "main", sessionId = "s") =>
    event(
      "tool.result",
      { toolCallId: id, toolName: name, status: "ok", result: { status: "ok", data } },
      agentId,
      sessionId,
    );
  const preflight = (
    id: string,
    rev: number,
    sheet = "Blocked",
    agentId = "main",
    sessionId = "s",
  ) =>
    receipt(
      id,
      "workbook_analyze",
      {
        ...base(rev),
        mode: "sort_preflight",
        range: `${sheet}!A2:C3`,
        sortPreflight: {
          sheet,
          targetRange: `${sheet}!A2:C3`,
          dataRange: `${sheet}!A2:C3`,
          hasHeader: false,
          status: sheet === "Blocked" ? "blocked" : "safe",
          execution: "not_executed",
          reason: "host reason",
          merges: [{ range: `${sheet}!B2:B3`, relation: "inside_data" }],
        },
      },
      agentId,
      sessionId,
    );
  const read = (
    id: string,
    rev: number,
    sheet = "Blocked",
    agentId = "main",
    sessionId = "s",
    docId = "book",
    path = "out.xlsx",
  ) =>
    receipt(
      id,
      "workbook_read",
      {
        ...base(rev, docId, path),
        mode: "range",
        sheet,
        range: `${sheet}!A2:C3`,
        readWindow: {
          returnedRange: `${sheet}!A2:C3`,
          complete: true,
          offset: 0,
          returnedRows: 2,
          totalRows: 2,
        },
        values: [
          [2, "record-b", 4],
          [1, "record-a", 2],
        ],
        formulas: [
          [null, null, "=A2*2"],
          [null, null, "=A3*2"],
        ],
        coverage: { values: "read", formulas: "read" },
      },
      agentId,
      sessionId,
    );
  const selected = (id: string): NumericPointer[] => [
    { toolCallId: id, pointer: "/data/values/0/0" },
  ];
  const plan = (sources = selected("selected")) =>
    planNumericCompleteness(db, {
      sessionId: "s",
      agentId: "main",
      turnId: "current",
      sources,
      currentDocument: (docId) =>
        docId === "book" ? { path: "out.xlsx", rev: 1 } : { path: "other.xlsx", rev: 1 },
    });
  return { db, log, event, base, receipt, preflight, read, selected, plan };
}

function preservationFixture(
  options: {
    operation?: "copy" | "move";
    baselineAfterWrite?: boolean;
    sourceHash?: string;
    supportHash?: string;
    worksheetHash?: string;
    hideSource?: boolean;
    sourceRev?: number;
    unavailable?: boolean;
    copyBaseline?: "valid" | "mismatch" | "wrong_version";
    omitHistorical?: boolean;
    copyTruncated?: boolean;
  } = {},
) {
  const f = fixture(),
    h0 = "0".repeat(64),
    h1 = "1".repeat(64);
  const original = (path: string, docId: string, rev: number, hash: string) => ({
    docId,
    path,
    docRevs: { [docId]: rev },
    sourceFile: { currentSha256: hash, openedSha256: h0, pendingWrite: false },
  });
  const preflight = (id: string, path: string, docId: string, rev: number, hash: string) => {
    f.receipt(id, "workbook_analyze", {
      ...original(path, docId, rev, hash),
      mode: "sort_preflight",
      range: "Blocked!A2:C3",
      sortPreflight: {
        sheet: "Blocked",
        targetRange: "Blocked!A2:C3",
        dataRange: "Blocked!A2:C3",
        hasHeader: false,
        status: "blocked",
        execution: "not_executed",
        reason: "host rejection",
        merges: [{ range: "Blocked!B2:B3", relation: "inside_data", risk: "spans_data_rows" }],
        savedSheet: {
          scope: "worksheet_xml_and_nonworksheet_package_parts",
          status: options.unavailable && docId === "book" ? "unavailable" : "confirmed_checkpoint",
          sheet: "Blocked",
          checkpointRev: rev,
          packageSha256: hash,
          worksheetPart: "xl/worksheets/sheet1.xml",
          worksheetSha256:
            docId === "book" ? (options.worksheetHash ?? "2".repeat(64)) : "2".repeat(64),
          supportingPartsSha256:
            docId === "book" ? (options.supportHash ?? "3".repeat(64)) : "3".repeat(64),
        },
      },
    });
  };
  preflight(
    "source-preflight",
    "source.xlsx",
    "source",
    options.sourceRev ?? 0,
    options.sourceHash ?? h0,
  );
  f.event("tool.intent", {
    stepId: "copy-step",
    targets: ["source.xlsx", "out.xlsx"],
    replay: "unsafe",
    toolCallId: "copy",
    toolName: "files",
    args: { ops: [{ op: options.operation ?? "copy", path: "source.xlsx", to: "out.xlsx" }] },
    intentMeta: { workspaceId: "w", paths: { "source.xlsx": h0, "out.xlsx": null } },
  });
  f.receipt("copy", "files", {
    ...(options.copyTruncated ? { truncated: true } : {}),
    results: [
      {
        path: "source.xlsx",
        to: "out.xlsx",
        ...(options.copyBaseline
          ? {
              copyBaseline: {
                version: options.copyBaseline === "wrong_version" ? 2 : 1,
                sourceSha256: h0,
                destinationSha256: options.copyBaseline === "mismatch" ? h1 : h0,
                destinationWasAbsent: true,
              },
            }
          : {}),
      },
    ],
  });
  const baseline = () =>
    f.receipt("initial-copy-read", "workbook_read", {
      ...original("out.xlsx", "book", 0, h0),
      mode: "overview",
      sheets: [{ name: "Blocked" }],
    });
  if (!options.omitHistorical && !options.baselineAfterWrite) baseline();
  f.event("tool.intent", {
    stepId: "sort-step",
    targets: ["out.xlsx"],
    replay: "unsafe",
    toolCallId: "safe-sort",
    toolName: "workbook_edit",
    args: {
      path: "out.xlsx",
      ops: [
        { op: "sort", range: "Safe!A2:C3", header: false, keys: [{ column: 1, order: "asc" }] },
      ],
    },
  });
  f.receipt("safe-sort", "workbook_edit", {
    ...original("out.xlsx", "book", 1, h1),
    dryRun: false,
  });
  if (!options.omitHistorical && options.baselineAfterWrite) baseline();
  preflight("output-preflight", "out.xlsx", "book", 1, h1);
  f.read("selected", 1);
  if (options.hideSource)
    f.db
      .prepare(
        "UPDATE agent_context SET superseded=1 WHERE json_extract(item,'$.toolCallId')='source-preflight'",
      )
      .run();
  const plan = (sources = f.selected("selected")) =>
    planNumericCompleteness(f.db, {
      sessionId: "s",
      agentId: "main",
      turnId: "current",
      sources,
      currentDocument: (id) =>
        id === "book" ? { path: "out.xlsx", rev: 1 } : { path: "source.xlsx", rev: 0 },
    });
  return { ...f, plan };
}

test("copied blocked sheets get a current two-source saved-package comparison, not a historical source exemption", () => {
  const f = preservationFixture();
  try {
    const plan = f.plan();
    expect(plan.missing).toEqual([]);
    expect(plan.sortPreservations).toEqual([
      expect.objectContaining({
        outcome: "saved_equal",
        scope: "worksheet_xml_and_nonworksheet_package_parts",
        path: "out.xlsx",
        targetRange: "Blocked!A2:C3",
        copy: expect.objectContaining({
          toolCallId: "copy",
          sourcePath: "source.xlsx",
          outputPath: "out.xlsx",
        }),
        before: expect.objectContaining({
          toolCallId: "source-preflight",
          source: expect.objectContaining({ docId: "source", rev: 0 }),
        }),
        after: expect.objectContaining({
          toolCallId: "output-preflight",
          source: expect.objectContaining({ docId: "book", rev: 1 }),
        }),
        baseline: expect.objectContaining({ toolCallId: "initial-copy-read", rev: 0 }),
      }),
    ]);
    expect(plan.sources.some((ref) => ref.toolCallId === "initial-copy-read")).toBe(false);
    expect(plan.sortExecutions[0]?.outcome).toBe("preflight_only");
  } finally {
    f.db.close();
  }
});

test("truncated copy receipts cannot establish preservation identity", () => {
  const f = preservationFixture({
    copyBaseline: "valid",
    omitHistorical: true,
    copyTruncated: true,
  });
  try {
    expect(f.plan().sortPreservations).toEqual([]);
    expect(f.plan().missing.some((gap) => gap.kind === "sort_preservation")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("preservation references share the existing 32-reference budget", () => {
  const f = preservationFixture({ copyBaseline: "valid", omitHistorical: true });
  try {
    const sources = f.selected("selected");
    for (let i = 0; i < 30; i++) {
      f.read(`extra-${i}`, 1);
      sources.push(...f.selected(`extra-${i}`));
    }
    const plan = f.plan(sources);
    expect(plan.missing.some((gap) => gap.kind === "limit")).toBe(true);
    expect(plan.sortPreservations).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("copy preservation rejects stale, hidden, mismatched and post-write identities", () => {
  for (const options of [
    { baselineAfterWrite: true },
    { sourceHash: "f".repeat(64) },
    { hideSource: true },
    { sourceRev: 9 },
    { unavailable: true },
    { copyBaseline: "mismatch" as const, omitHistorical: true },
    { copyBaseline: "wrong_version" as const, omitHistorical: true },
  ]) {
    const f = preservationFixture(options);
    try {
      const plan = f.plan();
      expect(plan.sortPreservations, JSON.stringify(options)).toEqual([]);
      expect(
        plan.missing.some((gap) => gap.kind === "sort_preservation"),
        JSON.stringify(options),
      ).toBe(true);
    } finally {
      f.db.close();
    }
  }
});

test("actual copy receipt baseline closes copy-to-edit without inventing a historical revision read", () => {
  const f = preservationFixture({ copyBaseline: "valid", omitHistorical: true });
  try {
    const plan = f.plan();
    expect(plan.missing).toEqual([]);
    expect(plan.sortPreservations?.[0]).toMatchObject({
      outcome: "saved_equal",
      baseline: { kind: "copy_receipt", toolCallId: "copy", sha256: "0".repeat(64) },
    });
    expect(plan.sortPreservations?.[0]?.baseline.rev).toBeUndefined();
  } finally {
    f.db.close();
  }
});

test("move is not copy provenance and shared-part changes do not assert worksheet changes", () => {
  for (const [options, expected] of [
    [{ operation: "move" }, undefined],
    [{ supportHash: "4".repeat(64) }, "supporting_parts_differ"],
    [{ worksheetHash: "5".repeat(64) }, "worksheet_bytes_differ"],
  ] as const) {
    const f = preservationFixture(options);
    try {
      expect(f.plan().sortPreservations?.[0]?.outcome).toBe(expected);
    } finally {
      f.db.close();
    }
  }
});

test("old preflights require all selected-document targets to be read again at the current revision", () => {
  const f = fixture();
  try {
    f.preflight("old-blocked", 0);
    f.preflight("old-safe", 0, "Safe");
    f.read("selected", 1, "Safe");
    const plan = f.plan();
    expect(plan.sources).not.toContainEqual({
      toolCallId: "old-blocked",
      pointer: "/data/sortPreflight",
    });
    expect(plan.missing.map((gap) => [gap.kind, gap.targetRange])).toEqual(
      expect.arrayContaining([
        ["sort_preflight", "Blocked!A2:C3"],
        ["sort_preflight", "Safe!A2:C3"],
        ["sort_readback", "Blocked!A2:C3"],
      ]),
    );
  } finally {
    f.db.close();
  }
});

test("current visible preflight and complete row evidence are appended without dropping record strings", () => {
  const f = fixture();
  try {
    f.preflight("old", 0);
    f.preflight("current-preflight", 1);
    f.read("selected", 1);
    const plan = f.plan();
    expect(plan.missing).toEqual([]);
    expect(plan.sources).toEqual(
      expect.arrayContaining([
        { toolCallId: "current-preflight", pointer: "/data/sortPreflight" },
        { toolCallId: "selected", pointer: "/data/values" },
      ]),
    );
    expect(plan.sortExecutions[0]?.outcome).toBe("preflight_only");
  } finally {
    f.db.close();
  }
});

test("hidden, other-agent and other-session evidence cannot satisfy current target obligations", () => {
  const f = fixture();
  try {
    f.preflight("old", 0);
    f.preflight("hidden", 1);
    f.db
      .prepare(
        "UPDATE agent_context SET superseded=1 WHERE json_extract(item,'$.toolCallId')='hidden'",
      )
      .run();
    f.preflight("child", 1, "Blocked", "child");
    f.preflight("other-session", 1, "Blocked", "main", "other");
    f.read("selected", 1);
    expect(f.plan().missing.some((gap) => gap.kind === "sort_preflight")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("sort execution requires a successful matching native sort, not changes or a safe preflight", () => {
  const f = fixture();
  try {
    f.preflight("preflight", 1, "Safe");
    f.read("selected", 1, "Safe");
    f.event("tool.intent", {
      stepId: "step",
      toolCallId: "other-sort",
      toolName: "workbook_edit",
      args: {
        path: "out.xlsx",
        ops: [
          { op: "sort", range: "Other!A2:C3", header: false, keys: [{ column: 1, order: "asc" }] },
        ],
      },
      targets: [],
      replay: "unsafe",
    });
    f.receipt("other-sort", "workbook_edit", { ...f.base(1), dryRun: false });
    expect(f.plan().sortExecutions[0]?.outcome).toBe("preflight_only");
    f.receipt("generic-write", "workbook_edit", {
      ...f.base(1),
      dryRun: false,
      changes: { ranges: ["Safe!A2:C3"] },
    });
    expect(f.plan().sortExecutions[0]?.outcome).not.toBe("executed");
    f.event("tool.intent", {
      stepId: "step",
      toolCallId: "sort",
      toolName: "workbook_edit",
      args: {
        path: "out.xlsx",
        ops: [
          { op: "sort", range: "Safe!A2:C3", header: false, keys: [{ column: 1, order: "asc" }] },
        ],
      },
      targets: [],
      replay: "unsafe",
    });
    f.receipt("sort", "workbook_edit", {
      ...f.base(1),
      dryRun: false,
      changes: { ranges: ["Safe!A2:C3"] },
    });
    expect(f.plan().sortExecutions[0]).toMatchObject({
      outcome: "executed",
      toolCallId: "sort",
      targetRange: "Safe!A2:C3",
      hasHeader: false,
    });
  } finally {
    f.db.close();
  }
});

for (const field of ["published", "committedRevs"] as const) {
  test(`script ${field} identifies a touched document but never proves sorting`, () => {
    const f = fixture();
    try {
      f.preflight("preflight", 1, "Safe");
      f.read("selected", 1, "Safe");
      f.receipt("read-only-script", "run_script", {
        published: [],
        committedRevs: [],
        provenance: { code: "await wb.edit({ ops: [{ op: 'sort' }] })", reads: [] },
        value: { published: [{ docId: "book", path: "out.xlsx", rev: 1 }] },
      });
      expect(f.plan().sortExecutions[0]?.outcome).toBe("preflight_only");
      f.receipt("unrelated-script", "run_script", {
        [field]: [{ docId: "other", path: "other.xlsx", rev: 1 }],
        value: null,
      });
      expect(f.plan().sortExecutions[0]?.outcome).toBe("preflight_only");
      f.receipt("written-script", "run_script", {
        [field]: [{ docId: "book", path: "out.xlsx", rev: 1 }],
        provenance: { code: "await wb.edit(...) ", reads: [] },
        value: null,
      });
      expect(f.plan().sortExecutions[0]?.outcome).toBe("unknown");
      expect(f.plan().sortExecutions[0]?.toolCallId).toBeUndefined();
    } finally {
      f.db.close();
    }
  });
}

test("non-ok script commit/publication receipts imply unknown execution but never become evidence", () => {
  for (const status of ["uncertain", "error", "partial"]) {
    const f = fixture();
    try {
      f.preflight("preflight", 1, "Safe");
      f.read("selected", 1, "Safe");
      f.event("tool.result", {
        toolCallId: "failed-publish",
        toolName: "run_script",
        status,
        result: {
          status,
          error: { code: "INTERNAL", message: "checkpoint failed", retryable: false },
          data: {
            committedRevs: [{ docId: "book", path: "out.xlsx", rev: 1 }],
            published: [{ docId: "book", path: "out.xlsx", rev: 1 }],
            rolledBack: [],
            unrecovered: ["out.xlsx"],
            value: 999,
          },
        },
      });
      const plan = f.plan();
      expect(plan.sortExecutions[0]?.outcome, status).toBe("unknown");
      expect(plan.sources.some((source) => source.toolCallId === "failed-publish")).toBe(false);
      expect(plan.readbacks.some((readback) => readback.toolCallId === "failed-publish")).toBe(
        false,
      );
    } finally {
      f.db.close();
    }
  }
});

for (const hasHeader of [true, false]) {
  test(`omitted sort header follows the execution default, target hasHeader=${hasHeader}`, () => {
    const f = fixture();
    try {
      f.receipt("preflight", "workbook_analyze", {
        ...f.base(1),
        mode: "sort_preflight",
        sortPreflight: {
          sheet: "Safe",
          targetRange: "Safe!A2:C3",
          dataRange: hasHeader ? "Safe!A3:C3" : "Safe!A2:C3",
          hasHeader,
          status: "safe",
          execution: "not_executed",
          reason: "host reason",
          merges: [],
        },
      });
      f.read("selected", 1, "Safe");
      const op = { op: "sort", range: "Safe!A2:C3", keys: [{ column: 1, order: "asc" }] };
      expect(ChangeOp.safeParse(op)).toMatchObject({ success: true, data: { header: true } });
      expect(ChangeOp.safeParse({ ...op, keys: [{ column: 1 }] }).success).toBe(false);
      f.event("tool.intent", {
        stepId: "step",
        toolCallId: "default-header-sort",
        toolName: "workbook_edit",
        args: { path: "out.xlsx", ops: [op] },
        targets: [],
        replay: "unsafe",
      });
      f.receipt("default-header-sort", "workbook_edit", { ...f.base(1), dryRun: false });
      expect(f.plan().sortExecutions[0]?.outcome).toBe(hasHeader ? "executed" : "unknown");
    } finally {
      f.db.close();
    }
  });
}

test("selected external-link documents add the whole current host object report; unrelated documents stay out", () => {
  const f = fixture();
  try {
    const details = {
      source: "preserved_package",
      updated: false,
      links: [{ index: 1, linked: true }],
      formulaCaches: [],
      truncated: false,
    };
    f.receipt("old-links", "workbook_read", {
      ...f.base(0),
      mode: "objects",
      preserved: { externalLinkDetails: details },
      checkpointExternalLinks: {
        source: "preserved_package",
        isCurrent: true,
        checkpointRev: 0,
        currentRev: 0,
        packageState: "confirmed_checkpoint",
      },
    });
    f.read("selected", 1);
    expect(f.plan().missing).toContainEqual(
      expect.objectContaining({ kind: "external_links", docId: "book" }),
    );
    f.receipt("links", "workbook_read", {
      ...f.base(1),
      mode: "objects",
      preserved: { externalLinkDetails: details },
      checkpointExternalLinks: {
        source: "preserved_package",
        isCurrent: true,
        checkpointRev: 1,
        currentRev: 1,
        packageState: "confirmed_checkpoint",
      },
    });
    f.read("other", 1, "Other", "main", "s", "other", "other.xlsx");
    f.receipt("unrelated-links", "workbook_read", {
      ...f.base(1, "other", "other.xlsx"),
      mode: "objects",
      preserved: { externalLinkDetails: details },
      checkpointExternalLinks: { source: "preserved_package" },
    });
    expect(f.plan().sources).toContainEqual({
      toolCallId: "links",
      pointer: "/data/preserved/externalLinkDetails",
    });
    expect(f.plan().sources.some((source) => source.toolCallId === "unrelated-links")).toBe(false);
  } finally {
    f.db.close();
  }
});

test("optional full readback leaves room for the required saved-sheet proof within 200 scalars", () => {
  const f = preservationFixture({ copyBaseline: "valid", omitHistorical: true });
  try {
    f.receipt("wide-readback", "workbook_read", {
      ...f.base(1),
      mode: "range",
      sheet: "Blocked",
      range: "Blocked!A1:C26",
      readWindow: {
        returnedRange: "Blocked!A1:C26",
        complete: true,
        offset: 0,
        returnedRows: 26,
        totalRows: 26,
      },
      values: Array.from({ length: 26 }, (_, i) => [i, `record-${i}`, i * 2]),
      formulas: Array.from({ length: 26 }, (_, i) => [null, null, `=A${i + 1}*2`]),
    });
    const plan = f.plan(f.selected("wide-readback"));
    expect(plan.missing).toEqual([]);
    expect(plan.sortPreservations).toHaveLength(1);
    expect(plan.readbacks).toContainEqual(
      expect.objectContaining({ toolCallId: "wide-readback", displayedInFull: false }),
    );
    expect(plan.sources).not.toContainEqual({
      toolCallId: "wide-readback",
      pointer: "/data/values",
    });
  } finally {
    f.db.close();
  }
});

test("large complete visible readback proves coverage without requiring an unselectable full-data root", () => {
  const f = fixture();
  try {
    f.preflight("preflight", 1);
    f.receipt("selected", "workbook_read", {
      ...f.base(1),
      mode: "range",
      sheet: "Blocked",
      range: "Blocked!A1:C100",
      readWindow: {
        returnedRange: "Blocked!A1:C100",
        complete: true,
        offset: 0,
        returnedRows: 100,
        totalRows: 100,
      },
      values: Array.from({ length: 100 }, (_, i) => [i, `record-${i}`, i * 2]),
      formulas: Array.from({ length: 100 }, (_, i) => [null, null, `=A${i + 1}*2`]),
    });
    const plan = f.plan();
    expect(plan.missing).toEqual([]);
    expect(plan.sources).not.toContainEqual({ toolCallId: "selected", pointer: "/data/values" });
    expect(plan.readbacks).toContainEqual(
      expect.objectContaining({
        toolCallId: "selected",
        targetRange: "Blocked!A2:C3",
        returnedRange: "Blocked!A1:C100",
        displayedInFull: false,
        source: expect.objectContaining({
          docId: "book",
          path: "out.xlsx",
          rev: 1,
          sourceFile: { currentSha256: "sha-1" },
        }),
      }),
    );
  } finally {
    f.db.close();
  }
});

test("trusted child facts and explicit resume seed obligations but cannot supply main's evidence", () => {
  const f = fixture();
  try {
    f.event("agent.spawned", { parentId: "main", name: "child", role: "worker" }, "child");
    f.event("turn.started", { turnId: "child-turn" }, "child");
    f.preflight("child-preflight", 1, "Child", "child");
    f.event("turn.completed", { turnId: "child-turn", reason: "done" }, "child");
    f.event(
      "inbox.sent",
      {
        messageId: "report",
        fromAgentId: "child",
        toAgentId: "main",
        kind: "report",
        message: "ignored",
        numericDelivery: { turnId: "child-turn", outcome: "completed" },
      },
      "child",
    );
    f.event("inbox.delivered", { messageId: "report", toAgentId: "main" });
    f.preflight("resume-target", 0, "BeforeResume");
    f.event("turn.interrupted", { turnId: "current" });
    f.event("turn.started", { turnId: "resumed", numericDeliveryRequired: true });
    f.read("selected", 1);
    const plan = planNumericCompleteness(f.db, {
      sessionId: "s",
      agentId: "main",
      turnId: "resumed",
      sources: f.selected("selected"),
      currentDocument: () => ({ path: "out.xlsx", rev: 1 }),
    });
    expect(
      plan.missing.filter((gap) => gap.kind === "sort_preflight").map((gap) => gap.targetRange),
    ).toEqual(expect.arrayContaining(["Child!A2:C3", "BeforeResume!A2:C3"]));
    expect(plan.sources.some((source) => source.toolCallId === "child-preflight")).toBe(false);
  } finally {
    f.db.close();
  }
});
