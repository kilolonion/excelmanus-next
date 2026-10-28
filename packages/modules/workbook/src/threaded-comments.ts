// MS-XLSX threaded comments. Patch only changed nodes; retain identities, mentions and extensions.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ThreadComment } from "@excelmanus/protocol";
import type { IWorkbookData } from "@univerjs/core";
import { XMLParser } from "fast-xml-parser";
import { objectsOf } from "./objects.ts";
import {
  assertXmlDocument,
  bytesOf,
  elements,
  escapeXml,
  setAttribute,
  textOf,
  xmlAttrs,
} from "./xml.ts";

type Parts = Record<string, Uint8Array>;
type Mapping = Record<string, { path: string }>;
const NS = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments";
const REL = "http://schemas.microsoft.com/office/2017/10/relationships/";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});
const read = (p: Parts, k: string) => (p[k] ? textOf(p[k]!) : "");
const relPath = (p: string) => `${posix.dirname(p)}/_rels/${posix.basename(p)}.rels`;
const localElements = (xml: string, name: string) => {
  const names = new Set(
    [...xml.matchAll(/<([\w.-]+:)?([\w.-]+)(?=[\s/>])/g)]
      .filter((m) => m[2] === name)
      .map((m) => `${m[1] ?? ""}${name}`),
  );
  return [...names].flatMap((n) => elements(xml, n)).sort((a, b) => a.start - b.start);
};
function relationTarget(parts: Parts, source: string, type: string): string | undefined {
  for (const node of localElements(read(parts, relPath(source)), "Relationship")) {
    const a = xmlAttrs(node.open);
    if (a.Type !== REL + type || a.TargetMode === "External") continue;
    if (!a.Target || /[:\\?#]/.test(a.Target)) continue;
    const path = posix.normalize(
      a.Target.startsWith("/") ? a.Target.slice(1) : posix.join(posix.dirname(source), a.Target),
    );
    if (path.startsWith("xl/")) return path;
  }
}
function appendRoot(xml: string, root: string, fragment: string): string {
  const e = localElements(xml, root)[0];
  if (!e) throw Error(`批注 XML 缺少 ${root}`);
  if (e.open.endsWith("/>"))
    return xml.replace(
      e.raw,
      e.open.slice(0, -2) + ">" + fragment + `</${/^<([^\s/>]+)/.exec(e.open)![1]}>`,
    );
  const childExt = localElements(e.inner, "extLst").find(
    (ext) =>
      ![...localElements(e.inner, "threadedComment"), ...localElements(e.inner, "person")].some(
        (c) => c.start < ext.start && c.end > ext.end,
      ),
  );
  const at = childExt
    ? e.start + e.open.length + childExt.start
    : e.end - `</${/^<([^\s/>]+)/.exec(e.open)![1]}>`.length;
  return xml.slice(0, at) + fragment + xml.slice(at);
}
const prefixOf = (xml: string, root: string) =>
  /^<([\w.-]+:)/.exec(localElements(xml, root)[0]?.open ?? "")?.[1] ?? "";
function ensureRelation(parts: Parts, source: string, type: string, target: string) {
  if (relationTarget(parts, source, type)) return;
  const path = relPath(source);
  let xml = read(parts, path) || `<Relationships xmlns="${PKG}"></Relationships>`;
  const prefix = prefixOf(xml, "Relationships");
  xml = appendRoot(
    xml,
    "Relationships",
    `<${prefix}Relationship Id="rId_em_${createHash("sha256").update(target).digest("hex").slice(0, 12)}" Type="${REL + type}" Target="${escapeXml(posix.relative(posix.dirname(source), target))}"/>`,
  );
  parts[path] = bytesOf(xml);
}
function ensureType(parts: Parts, path: string, type: string) {
  let xml = read(parts, "[Content_Types].xml");
  if (localElements(xml, "Override").some((e) => xmlAttrs(e.open).PartName === "/" + path)) return;
  const pre = prefixOf(xml, "Types");
  xml = appendRoot(
    xml,
    "Types",
    `<${pre}Override PartName="/${escapeXml(path)}" ContentType="${type}"/>`,
  );
  parts["[Content_Types].xml"] = bytesOf(xml);
}
export function importThreadedComments(
  parts: Parts,
  mapping: Mapping,
  sheets: IWorkbookData["sheets"],
): void {
  const personPart = relationTarget(parts, "xl/workbook.xml", "person");
  const persons = new Map(
    localElements(personPart ? read(parts, personPart) : "", "person").map((e) => {
      const a = xmlAttrs(e.open);
      return [a.id, a.displayName ?? ""];
    }),
  );
  for (const [sid, entry] of Object.entries(mapping)) {
    const sheet = sheets[sid];
    if (!sheet) continue;
    const part = relationTarget(parts, entry.path, "threadedComment");
    if (!part) continue;
    const xml = read(parts, part);
    assertXmlDocument(xml);
    const nodes = localElements(xml, "threadedComment");
    const refs = new Map(
      nodes.map((e) => {
        const a = xmlAttrs(e.open);
        return [a.id, a.ref];
      }),
    );
    const comments = nodes.flatMap((e) => {
      const a = xmlAttrs(e.open),
        body = parser.parse(e.raw)?.threadedComment;
      const parsed = ThreadComment.safeParse({
        id: a.id,
        personId: a.personId,
        parentId: a.parentId,
        ref: a.ref ?? refs.get(a.parentId),
        text: typeof body?.text === "string" ? body.text : String(body?.text?.["#text"] ?? ""),
        author: persons.get(a.personId) ?? "未知作者",
        dateTime: a.dT,
        done: a.done === "1" || a.done === "true",
      });
      return parsed.success ? [parsed.data] : [];
    });
    if (comments.length)
      sheet.custom = {
        ...sheet.custom,
        excelmanusObjects: { ...objectsOf(sheet), threadedComments: comments },
      };
  }
}
export function exportThreadedComments(
  parts: Parts,
  mapping: Mapping,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
): void {
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const current = objectsOf(sheet).threadedComments ?? [],
      previous = objectsOf(baseline.sheets[sid]).threadedComments ?? [];
    if (JSON.stringify(current) === JSON.stringify(previous)) continue;
    const source = mapping[sid]?.path;
    if (!source) continue;
    const suffix = createHash("sha256").update(sid).digest("hex").slice(0, 12);
    const part =
      relationTarget(parts, source, "threadedComment") ??
      `xl/threadedComments/threadedComment-em-${suffix}.xml`;
    let body = read(parts, part) || `<ThreadedComments xmlns="${NS}"></ThreadedComments>`;
    const prefix = prefixOf(body, "ThreadedComments");
    for (const old of previous)
      if (!current.some((c) => c.id === old.id)) {
        const e = localElements(body, "threadedComment").find(
          (e) => xmlAttrs(e.open).id === old.id,
        );
        if (e) body = body.replace(e.raw, "");
      }
    const personsPart =
      relationTarget(parts, "xl/workbook.xml", "person") ?? "xl/persons/person-em.xml";
    let persons = read(parts, personsPart) || `<personList xmlns="${NS}"></personList>`;
    const personPrefix = prefixOf(persons, "personList");
    let changedPersons = false;
    for (const c of current) {
      const old = previous.find((v) => v.id === c.id);
      if (JSON.stringify(old) === JSON.stringify(c)) continue;
      const e = localElements(body, "threadedComment").find((e) => xmlAttrs(e.open).id === c.id);
      if (e) {
        const tag = setAttribute(setAttribute(e.open, "done", c.done ? "1" : "0"), "ref", c.ref);
        body = body.replace(e.raw, tag + e.raw.slice(e.open.length));
      } else {
        const text = `<${prefix}text xml:space="preserve">${escapeXml(c.text)}</${prefix}text>`;
        body = appendRoot(
          body,
          "ThreadedComments",
          `<${prefix}threadedComment ref="${c.ref}" id="${escapeXml(c.id)}" personId="${escapeXml(c.personId)}"${c.parentId ? ` parentId="${escapeXml(c.parentId)}"` : ""}${c.dateTime ? ` dT="${escapeXml(c.dateTime)}"` : ""} done="${c.done ? 1 : 0}">${text}</${prefix}threadedComment>`,
        );
      }
      if (!localElements(persons, "person").some((e) => xmlAttrs(e.open).id === c.personId)) {
        persons = appendRoot(
          persons,
          "personList",
          `<${personPrefix}person id="${escapeXml(c.personId)}" displayName="${escapeXml(c.author)}" userId="${escapeXml(c.author)}" providerId="None"/>`,
        );
        changedPersons = true;
      }
    }
    assertXmlDocument(body);
    parts[part] = bytesOf(body);
    ensureRelation(parts, source, "threadedComment", part);
    ensureType(parts, part, "application/vnd.ms-excel.threadedcomments+xml");
    if (changedPersons) {
      assertXmlDocument(persons);
      parts[personsPart] = bytesOf(persons);
      ensureRelation(parts, "xl/workbook.xml", "person", personsPart);
      ensureType(parts, personsPart, "application/vnd.ms-excel.person+xml");
    }
  }
}
