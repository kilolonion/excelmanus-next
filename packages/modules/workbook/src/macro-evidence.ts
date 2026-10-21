import { createHash } from "node:crypto";
import { extname, posix } from "node:path";
import { parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { MacroEvidence } from "@excelmanus/protocol";
import type { ICellData, IWorkbookData } from "@univerjs/core";
import { unzipSync } from "fflate";
import { SaxesParser, type SaxesTagNS } from "saxes";
import type { DocMutation } from "./engine.ts";
import type { ChangeOp } from "./ops.ts";
import { textOf } from "./xml.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const VBA_REL = "http://schemas.microsoft.com/office/2006/relationships/vbaProject";
const VBA_TYPE = "application/vnd.ms-office.vbaProject";
const MACRO_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attr = (tag: SaxesTagNS, local: string, uri = "") =>
  Object.values(tag.attributes).find((a) => a.local === local && a.uri === uri)?.value;

class InspectionError extends Error {
  readonly reason: MacroEvidence["inspection"]["reasonCode"];
  constructor(reason: MacroEvidence["inspection"]["reasonCode"]) {
    super(reason);
    this.reason = reason;
  }
}
function fail(reason: MacroEvidence["inspection"]["reasonCode"]): never {
  throw new InspectionError(reason);
}

function xml(
  bytes: Uint8Array | undefined,
  root: string,
  namespace: string,
  visit: (tag: SaxesTagNS, stack: SaxesTagNS[]) => void,
) {
  if (!bytes) fail("unsupported_package");
  const stack: SaxesTagNS[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => fail("unsupported_xml"));
  parser.on("opentag", (tag) => {
    if (!stack.length && (tag.local !== root || tag.uri !== namespace)) fail("unsupported_xml");
    visit(tag, stack);
    stack.push(tag);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(textOf(bytes)).close();
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode: string | null;
}
function relationships(bytes: Uint8Array | undefined): Relationship[] {
  const result: Relationship[] = [];
  const ids = new Set<string>();
  xml(bytes, "Relationships", PACKAGE_REL, (tag, stack) => {
    if (stack.length !== 1 || tag.local !== "Relationship" || tag.uri !== PACKAGE_REL) return;
    const id = attr(tag, "Id"),
      type = attr(tag, "Type"),
      target = attr(tag, "Target");
    if (!id || !type || !target || ids.has(id)) fail("ambiguous_graph");
    ids.add(id);
    result.push({ id, type, target, targetMode: attr(tag, "TargetMode") ?? null });
  });
  return result;
}
function targetPart(sourcePart: string, relation: Relationship): string {
  if (
    (relation.targetMode !== null && relation.targetMode !== "Internal") ||
    /[:\\?#%]/.test(relation.target)
  )
    fail("ambiguous_graph");
  const part = posix.normalize(
    relation.target.startsWith("/")
      ? relation.target.slice(1)
      : posix.join(posix.dirname(sourcePart), relation.target),
  );
  if (part === ".." || part.startsWith("../") || part.startsWith("/")) fail("ambiguous_graph");
  return part;
}

/** Detect declarations by decoded namespaced attributes, never comments or target-name substrings. */
function hasMacroPackage(parts: Record<string, Uint8Array>, path: string): boolean {
  if (extname(path).toLowerCase() === ".xlsm") return true;
  if (
    Object.keys(parts).some((name) =>
      /(?:^|\/)vbaProject(?:Signature(?:Agile|V3)?)?\.bin$/i.test(name),
    )
  )
    return true;
  let declared = false;
  try {
    xml(parts["[Content_Types].xml"], "Types", TYPES, (tag, stack) => {
      if (
        stack.length !== 1 ||
        tag.uri !== TYPES ||
        (tag.local !== "Default" && tag.local !== "Override")
      )
        return;
      const type = attr(tag, "ContentType");
      if (type === MACRO_TYPE || type === VBA_TYPE) declared = true;
    });
    if (relationships(parts[WORKBOOK_RELS]).some((relation) => relation.type === VBA_REL))
      declared = true;
  } catch {
    // An undecodable package cannot establish that the macro-preservation guard is inapplicable.
    return true;
  }
  return declared;
}

/** Finite static package facts. VBA bytes are hashed, never decoded or executed. */
export function inspectMacroPackage(
  bytes: Uint8Array,
  path: string,
  checkpoint: MacroEvidence["checkpoint"],
): MacroEvidence | undefined {
  const seen = new Set<string>();
  let duplicate = false;
  const parts = unzipSync(bytes, {
    filter(file) {
      if (seen.has(file.name)) duplicate = true;
      seen.add(file.name);
      return true;
    },
  });
  if (!hasMacroPackage(parts, path)) return;
  const emptyType = { contentType: null, source: null, match: null };
  const evidence: MacroEvidence = {
    version: 1,
    source: "current_disk_bytes",
    package: { path, sha256: hash(bytes), byteLength: bytes.byteLength },
    checkpoint,
    format: { workbookContentType: null, macroEnabled: false },
    project: {
      status: "unsupported",
      part: null,
      byteLength: null,
      sha256: null,
      cfbHeaderPresent: null,
    },
    relationships: [],
    contentTypes: {
      partSha256: hash(parts["[Content_Types].xml"] ?? new Uint8Array()),
      workbook: { ...emptyType },
      vba: { ...emptyType },
    },
    codeNames: { workbook: null, sheets: [] },
    signatureStatus: "unknown",
    inspection: { status: "unsupported", reasonCode: "unsupported_package" },
    cellEditSupport: { status: "blocked", reasonCode: "inspection_unsupported" },
    capabilities: {
      macroExecution: false,
      runtimeValidation: false,
      inspection: "static_package_only",
    },
  };
  try {
    if (duplicate) fail("ambiguous_graph");
    const defaults = new Map<string, string>(),
      overrides = new Map<string, string>();
    xml(parts["[Content_Types].xml"], "Types", TYPES, (tag, stack) => {
      if (stack.length !== 1 || tag.uri !== TYPES) return;
      const map = tag.local === "Default" ? defaults : tag.local === "Override" ? overrides : null;
      if (!map) return;
      const key = attr(tag, tag.local === "Default" ? "Extension" : "PartName");
      const type = attr(tag, "ContentType");
      if (!key || !type || map.has(key)) fail("ambiguous_graph");
      map.set(key, type);
    });
    const contentType = (part: string): MacroEvidence["contentTypes"]["workbook"] => {
      const override = overrides.get(`/${part}`);
      if (override) return { contentType: override, source: "Override", match: `/${part}` };
      const extension = extname(part).slice(1);
      const fallback = defaults.get(extension);
      return fallback
        ? { contentType: fallback, source: "Default", match: extension }
        : { ...emptyType };
    };
    evidence.contentTypes.workbook = contentType(WORKBOOK);
    evidence.format = {
      workbookContentType: evidence.contentTypes.workbook.contentType,
      macroEnabled: evidence.contentTypes.workbook.contentType === MACRO_TYPE,
    };
    const rootRelationships = relationships(parts["_rels/.rels"]);
    const root = rootRelationships.filter((r) => r.type === `${REL}/officeDocument`);
    const rootRelation = root[0];
    if (root.length !== 1 || !rootRelation || targetPart("", rootRelation) !== WORKBOOK)
      fail("ambiguous_graph");
    const relsBytes = parts[WORKBOOK_RELS];
    if (!relsBytes) fail("unsupported_package");
    const rels = relationships(relsBytes);
    const projects = rels.filter((r) => r.type === VBA_REL);
    evidence.relationships = projects.map((r) => ({
      sourcePart: WORKBOOK,
      relsPart: WORKBOOK_RELS,
      relsSha256: hash(relsBytes),
      ...r,
      resolvedPart: null,
    }));
    const signatureDeclared =
      rootRelationships.some(
        (relation) =>
          relation.type === `${PACKAGE_REL}/digital-signature/origin` ||
          relation.type === `${PACKAGE_REL}/digital-signature/signature`,
      ) ||
      [...defaults.values(), ...overrides.values()].some(
        (type) =>
          type === "application/vnd.openxmlformats-package.digital-signature-origin" ||
          type === "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml",
      );
    evidence.signatureStatus =
      signatureDeclared ||
      Object.keys(parts).some(
        (part) =>
          /^_xmlsignatures\//i.test(part) ||
          /(?:^|\/)vbaProjectSignature(?:Agile|V3)?\.bin$/i.test(part),
      )
        ? "present"
        : "absent";
    // The only additional relationship documents inspected are those belonging to the VBA part.
    for (const relation of projects) {
      const part = targetPart(WORKBOOK, relation);
      const relsPart = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
      if (
        parts[relsPart] &&
        relationships(parts[relsPart]).some((r) =>
          /^http:\/\/schemas\.microsoft\.com\/office\/(?:2006|2014|2020)\/relationships\/vbaProjectSignature(?:Agile|V3)?$/.test(
            r.type,
          ),
        )
      )
        evidence.signatureStatus = "present";
    }
    if (projects.length !== 1) {
      evidence.project.status = projects.length ? "unsupported" : "absent";
      fail(projects.length ? "ambiguous_graph" : "missing_project");
    }
    const projectRelation = projects[0],
      evidenceRelation = evidence.relationships[0];
    if (!projectRelation || !evidenceRelation) fail("missing_project");
    const projectPart = targetPart(WORKBOOK, projectRelation);
    evidenceRelation.resolvedPart = projectPart;
    const project = parts[projectPart];
    if (!project) {
      evidence.project.status = "absent";
      fail("missing_project");
    }
    evidence.project = {
      status: "present",
      part: projectPart,
      byteLength: project.byteLength,
      sha256: hash(project),
      cfbHeaderPresent: Buffer.from(project.subarray(0, 8)).equals(
        Buffer.from("d0cf11e0a1b11ae1", "hex"),
      ),
    };
    evidence.contentTypes.vba = contentType(projectPart);
    if (!evidence.format.macroEnabled || evidence.contentTypes.vba.contentType !== VBA_TYPE)
      fail("unsupported_content_type");
    const declaredProjects = Object.keys(parts).filter(
      (part) => contentType(part).contentType === VBA_TYPE,
    );
    if (declaredProjects.length !== 1 || declaredProjects[0] !== projectPart)
      fail("ambiguous_graph");
    let workbookPr = 0,
      sheetLists = 0;
    const sheets: Array<{ name: string; sheetId: string; relationshipId: string }> = [];
    xml(parts[WORKBOOK], "workbook", MAIN, (tag, stack) => {
      if (tag.uri !== MAIN) return;
      if (stack.length === 1 && tag.local === "workbookPr") {
        if (++workbookPr > 1) fail("ambiguous_graph");
        evidence.codeNames.workbook = attr(tag, "codeName") ?? null;
      }
      if (stack.length === 1 && tag.local === "sheets") sheetLists++;
      if (
        stack.length === 2 &&
        stack[1]?.local === "sheets" &&
        stack[1]?.uri === MAIN &&
        tag.local === "sheet"
      ) {
        const name = attr(tag, "name"),
          sheetId = attr(tag, "sheetId"),
          relationshipId = attr(tag, "id", REL);
        if (!name || !sheetId || !relationshipId) fail("ambiguous_graph");
        sheets.push({ name, sheetId, relationshipId });
      }
    });
    if (sheetLists !== 1 || !sheets.length) fail("ambiguous_graph");
    const names = new Set<string>(),
      ids = new Set<string>(),
      sheetParts = new Set<string>();
    for (const sheet of sheets) {
      if (names.has(sheet.name) || ids.has(sheet.sheetId)) fail("ambiguous_graph");
      names.add(sheet.name);
      ids.add(sheet.sheetId);
      const relation = rels.find(
        (r) => r.id === sheet.relationshipId && r.type === `${REL}/worksheet`,
      );
      if (!relation) fail("ambiguous_graph");
      const part = targetPart(WORKBOOK, relation);
      if (sheetParts.has(part)) fail("ambiguous_graph");
      sheetParts.add(part);
      let codeName: string | null = null,
        sheetPr = 0;
      xml(parts[part], "worksheet", MAIN, (tag, stack) => {
        if (stack.length === 1 && tag.local === "sheetPr" && tag.uri === MAIN) {
          if (++sheetPr > 1) fail("ambiguous_graph");
          codeName = attr(tag, "codeName") ?? null;
        }
      });
      evidence.codeNames.sheets.push({ ...sheet, part, codeName });
    }
    evidence.inspection = { status: "complete", reasonCode: "none" };
    evidence.cellEditSupport =
      evidence.signatureStatus === "absent"
        ? { status: "conditional", reasonCode: "literal_cells_only" }
        : { status: "blocked", reasonCode: "signature_present" };
  } catch (error) {
    evidence.inspection = {
      status: "unsupported",
      reasonCode: error instanceof InspectionError ? error.reason : "unsupported_xml",
    };
  }
  return evidence;
}

function unsupported(): never {
  throw new FileOperationError(
    "UNSUPPORTED_FEATURE",
    "此宏工作簿仅支持已确认无签名、关系和类型明确的普通单元格字面值编辑；本批修改未执行。不会执行宏，也不验证宏运行结果。",
  );
}

/** This guard runs before origin flush, engine revisions and backup creation. */
export function assertMacroWriteSupported(
  evidence: MacroEvidence | undefined,
  snapshot: IWorkbookData,
  ops: ChangeOp[] | undefined,
  mutations: DocMutation[] | undefined,
  trustedRevert = false,
): void {
  if (!evidence) return;
  if (evidence.cellEditSupport.status !== "conditional") unsupported();
  if (trustedRevert) return;
  const target = (sheetId: string, r: number, c: number) => {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet || !Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) unsupported();
    const cell = sheet.cellData?.[r]?.[c];
    if (cell?.f || cell?.si) unsupported();
  };
  if (ops !== undefined) {
    if (mutations?.length) unsupported();
    for (const op of ops) {
      if (op.op !== "cells.set") unsupported();
      const range = parseRange(op.range);
      const sheet = range.sheet
        ? Object.values(snapshot.sheets).find(
            (sheet) => sheet.name === range.sheet || sheet.id === range.sheet,
          )
        : snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
      if (!sheet?.id) unsupported();
      const width = Math.max(1, ...op.values.map((row) => row.length));
      for (const [r, row] of op.values.entries())
        for (let c = 0; c < width; c++) {
          const value = row[c];
          if (typeof value === "string" && value.startsWith("=")) unsupported();
          target(sheet.id, range.startRow - 1 + r, range.startCol - 1 + c);
        }
    }
    return;
  }
  for (const mutation of mutations ?? []) {
    if (mutation.id !== "sheet.mutation.set-range-values") unsupported();
    const params = mutation.params as {
      unitId?: unknown;
      subUnitId?: unknown;
      cellValue?: unknown;
    };
    if (
      params.unitId !== snapshot.id ||
      Object.keys(params).some(
        (key) => !["unitId", "subUnitId", "cellValue", "trigger"].includes(key),
      ) ||
      typeof params.subUnitId !== "string" ||
      !params.cellValue ||
      typeof params.cellValue !== "object"
    )
      unsupported();
    for (const [r, row] of Object.entries(params.cellValue as Record<string, unknown>)) {
      if (!row || typeof row !== "object") unsupported();
      for (const [c, raw] of Object.entries(row)) {
        target(params.subUnitId, Number(r), Number(c));
        if (!raw || typeof raw !== "object") unsupported();
        const cell = raw as ICellData;
        if (
          Object.keys(cell).some((key) => !["v", "t", "f", "si"].includes(key)) ||
          cell.f ||
          cell.si ||
          (typeof cell.v === "string" && cell.v.startsWith("=")) ||
          (cell.v !== undefined &&
            cell.v !== null &&
            !["string", "number", "boolean"].includes(typeof cell.v))
        )
          unsupported();
      }
    }
  }
}

/** Compare the exported candidate with real disk facts, never the mutable preservation cache. */
export function assertMacroPreserved(
  before: MacroEvidence | undefined,
  bytes: Uint8Array,
  path: string,
): void {
  if (!before) return;
  const after = inspectMacroPackage(bytes, path, before.checkpoint);
  const invariants = (e: MacroEvidence) => ({
    format: e.format,
    project: e.project,
    relationships: e.relationships,
    contentTypes: e.contentTypes,
    codeNames: e.codeNames,
    signatureStatus: e.signatureStatus,
  });
  if (
    after?.inspection.status !== "complete" ||
    before.inspection.status !== "complete" ||
    JSON.stringify(invariants(before)) !== JSON.stringify(invariants(after))
  )
    throw new FileOperationError(
      "UNSUPPORTED_FEATURE",
      "候选文件的 VBA 字节、关系、类型或 codeName 与当前磁盘宏包不一致，未发布该文件。静态核验不代表宏可运行。",
    );
}
