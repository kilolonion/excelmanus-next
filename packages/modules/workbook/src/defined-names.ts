import { FileOperationError } from "@excelmanus/kernel";
import type { IWorkbookData } from "@univerjs/core";
import {
  editXml,
  patchXmlAttributes,
  spreadsheetChildren,
  spreadsheetXml,
  type XmlEdit,
} from "./print-codec.ts";
import { bytesOf, escapeXml, textOf } from "./xml.ts";
export const NAME_RESOURCE = "SHEET_DEFINED_NAME_PLUGIN";
export type DefinedName = {
  id: string;
  name: string;
  formulaOrRefString: string;
  localSheetId?: string;
  comment?: string;
  hidden?: boolean;
};
export function namesOf(s: Pick<IWorkbookData, "resources">): Record<string, DefinedName> {
  const r = s.resources?.find((r) => r.name === NAME_RESOURCE)?.data;
  return r ? JSON.parse(r) : {};
}
export function setNames(s: IWorkbookData, names: Record<string, DefinedName>) {
  s.resources = [
    ...(s.resources ?? []).filter((r) => r.name !== NAME_RESOURCE),
    { name: NAME_RESOURCE, data: JSON.stringify(names) },
  ];
}
export function importNames(parts: Record<string, Uint8Array>, order: string[]) {
  const root = spreadsheetXml(textOf(parts["xl/workbook.xml"]!));
  const block = spreadsheetChildren(root, "definedNames")[0];
  const names: Record<string, DefinedName> = {};
  for (const [i, e] of (block ? spreadsheetChildren(block, "definedName") : []).entries()) {
    const a = e.attributes,
      id = `name_${i}`;
    names[id] = {
      id,
      name: a.name!,
      formulaOrRefString: e.text,
      ...(a.localSheetId !== undefined ? { localSheetId: order[Number(a.localSheetId)] } : {}),
      ...(a.comment !== undefined ? { comment: a.comment } : {}),
      ...(a.hidden !== undefined ? { hidden: a.hidden === "1" || a.hidden === "true" } : {}),
    };
  }
  return { name: NAME_RESOURCE, data: JSON.stringify(names) };
}
export function exportNames(
  parts: Record<string, Uint8Array>,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
) {
  const next = namesOf(snapshot),
    before = namesOf(baseline);
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  const wb = textOf(parts["xl/workbook.xml"]!);
  const root = spreadsheetXml(wb);
  const block = spreadsheetChildren(root, "definedNames")[0];
  const original = block ? spreadsheetChildren(block, "definedName") : [];
  const scope = (n: DefinedName) =>
    n.localSheetId === "AllDefaultWorkbook" ? undefined : n.localSheetId;
  const used = new Set<string>();
  const edits: XmlEdit[] = [];
  const matched = new Set<number>();
  const append: string[] = [];
  for (const n of Object.values(next)) {
    const old = before[n.id],
      sid = scope(n),
      key = `${sid ?? ""}:${n.name.toLowerCase()}`;
    if (used.has(key))
      throw new FileOperationError("INVALID_ARGUMENT", "同一作用域内定义名不能重复");
    used.add(key);
    const raw = old
      ? original.find((e) => {
          const a = e.attributes;
          return (
            a.name === old.name &&
            (a.localSheetId === undefined
              ? undefined
              : snapshot.sheetOrder[Number(a.localSheetId)]) === scope(old)
          );
        })
      : undefined;
    if (raw) matched.add(raw.start);
    if (old && JSON.stringify(old) === JSON.stringify(n) && raw) continue;
    if (
      !/^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u.test(n.name) ||
      n.name.length > 255 ||
      /^(?:[A-Z]{1,3}[1-9]\d*|R\d+C\d+|R|C)$/i.test(n.name) ||
      !n.formulaOrRefString.trim()
    )
      throw new FileOperationError("INVALID_ARGUMENT", "定义名或引用公式无效");
    if (sid && !snapshot.sheets[sid])
      throw new FileOperationError("INVALID_ARGUMENT", "名称作用域工作表不存在");
    const attrs: Record<string, string> = { ...raw?.attributes, name: n.name };
    if (sid) attrs.localSheetId = String(snapshot.sheetOrder.indexOf(sid));
    else delete attrs.localSheetId;
    if (n.comment !== undefined) attrs.comment = n.comment;
    else delete attrs.comment;
    if (n.hidden !== undefined) attrs.hidden = n.hidden ? "1" : "0";
    else delete attrs.hidden;
    const parentName = (block ?? root).name;
    const name =
      raw?.name ??
      (parentName.includes(":") ? `${parentName.split(":")[0]}:definedName` : "definedName");
    const open = raw
      ? patchXmlAttributes(wb.slice(raw.start, raw.openEnd), attrs, raw.attributes).replace(
          /\/>$/,
          ">",
        )
      : `<${name}${Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
          .join("")}>`;
    const text = `${open}${escapeXml(n.formulaOrRefString.replace(/^=/, ""))}</${name}>`;
    if (raw) edits.push({ start: raw.start, end: raw.end, text });
    else append.push(text);
  }
  for (const node of original)
    if (!matched.has(node.start)) edits.push({ start: node.start, end: node.end, text: "" });
  if (append.length) {
    if (block) {
      if (block.openEnd === block.end)
        edits.push({
          start: block.start,
          end: block.end,
          text: `${wb.slice(block.start, block.openEnd).replace(/\/>$/, ">")}${append.join("")}</${block.name}>`,
        });
      else edits.push({ start: block.closeStart, end: block.closeStart, text: append.join("") });
    } else {
      const name = root.name.includes(":")
        ? `${root.name.split(":")[0]}:definedNames`
        : "definedNames";
      const successors = [
        "calcPr",
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
      ].flatMap((local) => spreadsheetChildren(root, local).map((node) => node.start));
      const at = Math.min(root.closeStart, ...successors);
      edits.push({ start: at, end: at, text: `<${name}>${append.join("")}</${name}>` });
    }
  }
  parts["xl/workbook.xml"] = bytesOf(editXml(wb, edits));
}
