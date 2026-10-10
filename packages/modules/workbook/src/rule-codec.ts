// Conditional formats and data validation use the engine's native resources.
// Unknown original rules remain untouched; unsupported new engine rules fail closed.
import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { IWorkbookData } from "@univerjs/core";
import { XMLParser } from "fast-xml-parser";
import { bytesOf, elements, escapeXml, textOf, xmlAttrs } from "./xml.ts";

export const CF_RESOURCE = "SHEET_CONDITIONAL_FORMATTING_PLUGIN";
export const DV_RESOURCE = "SHEET_DATA_VALIDATION_PLUGIN";
type Rule = Record<string, any>;
type Range = { startRow: number; endRow: number; startColumn: number; endColumn: number };
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
});
const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
function unsupported(m: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", m);
}
export function rulesResource(
  snapshot: Pick<IWorkbookData, "resources">,
  name: string,
): Record<string, Rule[]> {
  const data = snapshot.resources?.find((r) => r.name === name)?.data;
  if (typeof data !== "string") return {};
  try {
    return JSON.parse(data) as Record<string, Rule[]>;
  } catch {
    return {};
  }
}
export function setRulesResource(
  snapshot: IWorkbookData,
  name: string,
  value: Record<string, Rule[]>,
): void {
  snapshot.resources = [
    ...(snapshot.resources ?? []).filter((r) => r.name !== name),
    { name, data: JSON.stringify(value) },
  ];
}
const rangeText = (ranges: Range[]) =>
  ranges
    .map(
      (r) =>
        `${indexToCol(r.startColumn + 1)}${r.startRow + 1}:${indexToCol(r.endColumn + 1)}${r.endRow + 1}`,
    )
    .join(" ");
const rangesOf = (sqref: string): Range[] =>
  sqref
    .trim()
    .split(/\s+/)
    .map((part) => {
      const r = parseRange(part.replaceAll("$", ""));
      return {
        startRow: r.startRow - 1,
        endRow: r.endRow - 1,
        startColumn: r.startCol - 1,
        endColumn: r.endCol - 1,
      };
    });
const operators = new Set([
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
]);
const dvTypes = new Set(["whole", "decimal", "list", "date", "time", "textLength", "custom"]);
function dxfStyle(raw: string): Rule | undefined {
  const parsed = parser.parse(raw).dxf as Rule | undefined;
  if (!parsed) return undefined;
  // Only import a style we can represent losslessly. Unsupported DXFs remain preserved.
  if (Object.keys(parsed).some((k) => !["font", "fill"].includes(k))) return undefined;
  const style: Rule = {};
  const fill = parsed.fill?.patternFill;
  if (fill?.["@_patternType"] === "solid" && fill.fgColor?.["@_rgb"])
    style.bg = { rgb: `#${String(fill.fgColor["@_rgb"]).slice(-6)}` };
  const font = parsed.font;
  if (font && Object.keys(font).some((k) => !["b", "color"].includes(k))) return undefined;
  if (font?.color && !font.color["@_rgb"]) return undefined;
  if (parsed.fill && (!fill || fill["@_patternType"] !== "solid" || !fill.fgColor?.["@_rgb"]))
    return undefined;
  if (font?.b !== undefined) style.bl = font.b?.["@_val"] === "0" ? 0 : 1;
  if (font?.color?.["@_rgb"]) style.cl = { rgb: `#${String(font.color["@_rgb"]).slice(-6)}` };
  return style;
}
export function importRules(
  parts: Record<string, Uint8Array>,
  mapping: Record<string, { path: string }>,
  stylesPart: string,
): IWorkbookData["resources"] {
  const cf: Record<string, Rule[]> = {},
    dv: Record<string, Rule[]> = {};
  const styles = parts[stylesPart] ? textOf(parts[stylesPart]) : "";
  const dxfs = elements(elements(styles, "dxfs")[0]?.inner ?? "", "dxf");
  for (const [sid, entry] of Object.entries(mapping)) {
    const body = textOf(parts[entry.path]!);
    for (const block of elements(body, "conditionalFormatting")) {
      const sqref = xmlAttrs(block.open).sqref;
      if (!sqref) continue;
      for (const raw of elements(block.inner, "cfRule")) {
        try {
          const attrs = xmlAttrs(raw.open),
            parsed = parser.parse(raw.raw).cfRule;
          const style = dxfStyle(dxfs[Number(attrs.dxfId)]?.raw ?? "<dxf/>");
          if (!style) continue;
          let rule: Rule;
          const formulas = arr(parsed.formula).map(String);
          if (attrs.type === "expression")
            rule = {
              type: "highlightCell",
              subType: "formula",
              value: `=${formulas[0] ?? ""}`,
              style,
            };
          else if (
            attrs.type === "cellIs" &&
            operators.has(attrs.operator ?? "") &&
            formulas.length &&
            formulas.every((v) => v.trim() !== "" && Number.isFinite(Number(v)))
          )
            rule = {
              type: "highlightCell",
              subType: "number",
              operator: attrs.operator,
              value: formulas.length === 1 ? Number(formulas[0]) : formulas.map(Number),
              style,
            };
          else if (attrs.type === "duplicateValues" || attrs.type === "uniqueValues")
            rule = { type: "highlightCell", subType: attrs.type, style };
          else continue;
          cf[sid] ??= [];
          cf[sid].push({
            cfId: xmlAttrs(block.open)["em:id"] ?? `ooxml_cf_${attrs.priority}`,
            ranges: rangesOf(sqref),
            stopIfTrue: attrs.stopIfTrue === "1",
            rule,
          });
        } catch {
          /* Unrepresentable original rule is preserved. */
        }
      }
    }
    let index = 0;
    for (const raw of elements(
      elements(body, "dataValidations")[0]?.inner ?? "",
      "dataValidation",
    )) {
      const id = `ooxml_dv_${index++}`;
      try {
        const attrs = xmlAttrs(raw.open),
          parsed = parser.parse(raw.raw).dataValidation;
        if (!dvTypes.has(attrs.type ?? "") || !attrs.sqref) continue;
        const formula1 = String(parsed.formula1 ?? "");
        dv[sid] ??= [];
        dv[sid].push({
          uid: attrs["em:id"] ?? id,
          type: attrs.type,
          ranges: rangesOf(attrs.sqref),
          operator: attrs.operator ?? "between",
          formula1:
            attrs.type === "list" && /^".*"$/.test(formula1)
              ? formula1.slice(1, -1).replaceAll('""', '"')
              : formula1,
          formula2: String(parsed.formula2 ?? ""),
          allowBlank: attrs.allowBlank === "1",
          showErrorMessage: attrs.showErrorMessage === "1",
          showInputMessage: attrs.showInputMessage === "1",
          showDropDown: attrs.showDropDown !== "1",
          error: attrs.error ?? "",
          errorTitle: attrs.errorTitle ?? "",
          errorStyle: attrs.errorStyle ?? "stop",
          prompt: attrs.prompt ?? "",
          promptTitle: attrs.promptTitle ?? "",
        });
      } catch {
        /* Unrepresentable original rule is preserved. */
      }
    }
  }
  return [
    { name: CF_RESOURCE, data: JSON.stringify(cf) },
    { name: DV_RESOURCE, data: JSON.stringify(dv) },
  ];
}
function appendDxf(parts: Record<string, Uint8Array>, path: string, style: Rule): number {
  let xml = textOf(parts[path]!);
  const old = elements(xml, "dxfs")[0];
  const current = elements(old?.inner ?? "", "dxf");
  const color = (v: unknown) => {
    if (typeof v !== "string" || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v))
      unsupported("条件格式颜色必须是 RGB/ARGB 十六进制");
    return v.replace(/^#/, "").length === 6 ? `FF${v.replace(/^#/, "")}` : v.replace(/^#/, "");
  };
  if (Object.keys(style).some((k) => !["bg", "cl", "bl"].includes(k)))
    unsupported("该条件格式样式尚不能保真导出");
  const raw = `<dxf>${style.bl !== undefined || style.cl ? `<font>${style.bl !== undefined ? `<b val="${style.bl ? 1 : 0}"/>` : ""}${style.cl ? `<color rgb="${color(style.cl.rgb)}"/>` : ""}</font>` : ""}${style.bg ? `<fill><patternFill patternType="solid"><fgColor rgb="${color(style.bg.rgb)}"/><bgColor indexed="64"/></patternFill></fill>` : ""}</dxf>`;
  const same = current.findIndex((d) => d.raw === raw);
  if (same >= 0) return same;
  const replacement = `<dxfs count="${current.length + 1}">${old?.inner ?? ""}${raw}</dxfs>`;
  if (old) xml = xml.replace(old.raw, replacement);
  else if (xml.includes("<tableStyles"))
    xml = xml.replace("<tableStyles", `${replacement}<tableStyles`);
  else xml = xml.replace("</styleSheet>", replacement + "</styleSheet>");
  parts[path] = bytesOf(xml);
  return current.length;
}
function appendSheetRule(xml: string, fragment: string): string {
  // OOXML worksheet schema order: conditionalFormatting, dataValidations, hyperlinks, drawings.
  const match =
    /<(?:dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|drawing|legacyDrawing|tableParts|extLst)\b/.exec(
      xml,
    );
  return match?.index !== undefined
    ? xml.slice(0, match.index) + fragment + xml.slice(match.index)
    : xml.replace("</worksheet>", fragment + "</worksheet>");
}
export function exportRules(
  parts: Record<string, Uint8Array>,
  mapping: Record<string, { path: string }>,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
  stylesPart: string,
): void {
  for (const name of [CF_RESOURCE, DV_RESOURCE]) {
    const before = rulesResource(baseline, name),
      after = rulesResource(snapshot, name);
    for (const sid of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const previous = before[sid] ?? [],
        next = after[sid] ?? [];
      if (JSON.stringify(previous) === JSON.stringify(next) || !snapshot.sheets[sid]) continue;
      const path = mapping[sid]?.path;
      if (!path) continue;
      let body = textOf(parts[path]!);
      if (name === CF_RESOURCE) {
        const priorities = new Set(previous.map((r) => String(r.cfId).replace("ooxml_cf_", "")));
        // All engine-created previous rules were serialized by us; their last priorities
        // are reconstructed by import, but while live use the before resource order.
        const blocks = elements(body, "conditionalFormatting");
        const unmanaged = blocks.map((block) => {
          const rules = elements(block.inner, "cfRule").filter(
            (r) =>
              !priorities.has(xmlAttrs(r.open).priority ?? "") &&
              !previous.some((item) => item.cfId === xmlAttrs(block.open)["em:id"]),
          );
          return rules.length
            ? block.open + rules.map((r) => r.raw).join("") + "</conditionalFormatting>"
            : "";
        });
        // On a live checkpoint the XML already includes generated rules; remove the
        // marker attached by this codec, without touching foreign unknown rules.
        body = body.replace(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g, () => "");
        const preserved = unmanaged.join("");
        body = appendSheetRule(body, preserved);
        let priority = Math.max(
          0,
          ...elements(preserved, "cfRule").map((r) => Number(xmlAttrs(r.open).priority) || 0),
        );
        let fragments = "";
        for (const item of next) {
          const rule = item.rule as Rule;
          if (!rule || rule.type !== "highlightCell") unsupported("该条件格式类型尚不能保真导出");
          const dxf = appendDxf(parts, stylesPart, rule.style ?? {});
          let type: string,
            operator = "",
            formulas: string[] = [];
          if (rule.subType === "formula") {
            type = "expression";
            formulas = [String(rule.value ?? "").replace(/^=/, "")];
          } else if (rule.subType === "number" && operators.has(rule.operator)) {
            type = "cellIs";
            operator = ` operator="${rule.operator}"`;
            formulas = arr(rule.value).map(String);
          } else if (rule.subType === "duplicateValues" || rule.subType === "uniqueValues")
            type = rule.subType;
          else if (rule.subType === "text" && rule.operator === "containsBlanks") {
            type = "expression";
            const r = item.ranges[0] as Range;
            formulas = [`LEN(TRIM(${indexToCol(r.startColumn + 1)}${r.startRow + 1}))=0`];
          } else unsupported("该条件格式规则尚不能保真导出");
          fragments += `<conditionalFormatting sqref="${escapeXml(rangeText(item.ranges))}" xmlns:em="urn:excelmanus:rules" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="em" em:managed="1" em:id="${escapeXml(item.cfId)}"><cfRule type="${type}" dxfId="${dxf}" priority="${++priority}"${operator}${item.stopIfTrue ? ' stopIfTrue="1"' : ""}>${formulas.map((f) => `<formula>${escapeXml(f)}</formula>`).join("")}</cfRule></conditionalFormatting>`;
        }
        body = appendSheetRule(body, fragments);
      } else {
        const container = elements(body, "dataValidations")[0];
        const old = elements(container?.inner ?? "", "dataValidation");
        const managed = new Set(previous.map((r) => String(r.uid)));
        const remaining = old
          .filter(
            (r, i) =>
              !managed.has(`ooxml_dv_${i}`) && !managed.has(xmlAttrs(r.open)["em:id"] ?? ""),
          )
          .map((r) => r.raw);
        for (const rule of next) {
          if (!dvTypes.has(rule.type)) unsupported("该数据验证类型尚不能保真导出");
          const attrs = [`type="${rule.type}"`, `sqref="${escapeXml(rangeText(rule.ranges))}"`];
          if (rule.operator && operators.has(rule.operator))
            attrs.push(`operator="${rule.operator}"`);
          for (const key of ["allowBlank", "showErrorMessage", "showInputMessage"] as const)
            if (rule[key] !== undefined) attrs.push(`${key}="${rule[key] ? 1 : 0}"`);
          if (rule.showDropDown !== undefined)
            attrs.push(`showDropDown="${rule.showDropDown ? 0 : 1}"`);
          for (const key of ["error", "errorTitle", "errorStyle", "prompt", "promptTitle"] as const)
            if (rule[key]) attrs.push(`${key}="${escapeXml(rule[key])}"`);
          let f1 = String(rule.formula1 ?? "");
          if (rule.type === "list" && !f1.startsWith("=")) f1 = `"${f1.replaceAll('"', '""')}"`;
          remaining.push(
            `<dataValidation ${attrs.join(" ")} xmlns:em="urn:excelmanus:rules" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="em" em:managed="1" em:id="${escapeXml(rule.uid)}"><formula1>${escapeXml(f1.replace(/^=/, ""))}</formula1>${rule.formula2 ? `<formula2>${escapeXml(String(rule.formula2).replace(/^=/, ""))}</formula2>` : ""}</dataValidation>`,
          );
        }
        if (container) body = body.replace(container.raw, "");
        const fragment = remaining.length
          ? `<dataValidations count="${remaining.length}">${remaining.join("")}</dataValidations>`
          : "";
        // Put after all conditional formatting and before other worksheet tail elements.
        body = appendSheetRule(body, fragment);
      }
      parts[path] = bytesOf(body);
    }
  }
}
