import { FileOperationError } from "@excelmanus/kernel";
import { SaxesParser } from "saxes";
import { escapeXml, xmlAttrs } from "./xml.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Normalize only worksheet schema element names; callers retain the original part for preservation. */
export function normalizeWorksheetXml(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new FileOperationError("INVALID_ARGUMENT", "工作表 XML 不允许 DTD 或实体声明");
  const root =
    /^\uFEFF?\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*(<worksheet(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>)/.exec(
      xml,
    );
  // Without nested namespace declarations or prefixed elements every element inherits the root URI.
  if (
    root?.[1] &&
    xmlAttrs(root[1]).xmlns === NS &&
    !xml.slice(root[0].length).includes("xmlns") &&
    !/<\/?[^<>\s/]+:/.test(xml)
  )
    return xml;

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const scopes: Array<{ original: string; normalized: string }> = [];
  const parser = new SaxesParser({ xmlns: true });
  let openStart = 0;
  parser.on("opentagstart", (tag) => {
    openStart = parser.position - tag.name.length - 2;
  });
  parser.on("opentag", (tag) => {
    if (!scopes.length && (tag.local !== "worksheet" || tag.uri !== NS))
      throw new FileOperationError(
        "INVALID_ARGUMENT",
        "工作表根元素不是受支持的 worksheet 命名空间",
      );
    const parent = scopes.at(-1);
    const declaredDefault = tag.attributes.xmlns?.value;
    const original = declaredDefault ?? parent?.original ?? "";
    let normalized = declaredDefault ?? parent?.normalized ?? "";
    let opening = xml.slice(openStart, parser.position);
    if (tag.uri === NS) {
      if (declaredDefault !== undefined && declaredDefault !== NS)
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "工作表混用默认命名空间，无法安全规范化；原文件保持不变。",
        );
      if (tag.prefix) opening = `<${tag.local}${opening.slice(tag.name.length + 1)}`;
      if (normalized !== NS) {
        const tail = tag.isSelfClosing ? "/>" : ">";
        opening = `${opening.slice(0, -tail.length)} xmlns="${NS}"${tail}`;
        normalized = NS;
      }
    } else {
      // The drawing codec currently reads these worksheet children without retaining prefixes.
      if (scopes.length === 1 && ["drawing", "legacyDrawing"].includes(tag.local))
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "工作表包含外来命名空间的绘图引用，无法安全读取或修改；原文件保持不变。",
        );
      if (!tag.prefix)
        throw new FileOperationError(
          "UNSUPPORTED_FEATURE",
          "工作表包含无前缀的外来命名空间元素，无法安全读取或修改；原文件保持不变。",
        );
      // A newly introduced worksheet default must not change a foreign subtree's namespace context.
      if (normalized !== original) {
        const tail = tag.isSelfClosing ? "/>" : ">";
        opening = `${opening.slice(0, -tail.length)} xmlns="${escapeXml(original)}"${tail}`;
        normalized = original;
      }
    }
    if (opening !== xml.slice(openStart, parser.position))
      edits.push({ start: openStart, end: parser.position, text: opening });
    scopes.push({ original, normalized });
  });
  parser.on("closetag", (tag) => {
    if (!tag.isSelfClosing && tag.uri === NS && tag.prefix) {
      const start = xml.lastIndexOf("</", parser.position - 1);
      edits.push({
        start,
        end: parser.position,
        text: `</${tag.local}${xml.slice(start + tag.name.length + 2, parser.position)}`,
      });
    }
    scopes.pop();
  });
  parser.write(xml).close();
  if (!edits.length) return xml;
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    result += xml.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  return result + xml.slice(offset);
}
