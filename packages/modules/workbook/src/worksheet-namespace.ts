import { FileOperationError } from "@excelmanus/kernel";
import { SaxesParser } from "saxes";
import { escapeXml, xmlAttrs } from "./xml.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Read/edit view; opaque worksheet extensions are restored only after all worksheet codecs finish. */
export function worksheetXmlView(xml: string): { xml: string; restore: (next: string) => string } {
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
    !xml.includes("extLst") &&
    !/<\/?[^<>\s/]+:/.test(xml)
  )
    return { xml, restore: (next) => next };

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const scopes: Array<{ original: string; normalized: string; local: string; uri: string }> = [];
  const extensions: Array<{ marker: string; raw: string }> = [];
  let markerPrefix = "excelmanus-opaque-extension";
  while (xml.includes(markerPrefix)) markerPrefix += "_";
  let opaque: { start: number; depth: number } | undefined;
  const parser = new SaxesParser({ xmlns: true });
  let openStart = 0;
  parser.on("opentagstart", (tag) => {
    openStart = parser.position - tag.name.length - 2;
  });
  parser.on("opentag", (tag) => {
    if (opaque) {
      opaque.depth++;
      return;
    }
    if (!scopes.length && (tag.local !== "worksheet" || tag.uri !== NS))
      throw new FileOperationError(
        "INVALID_ARGUMENT",
        "工作表根元素不是受支持的 worksheet 命名空间",
      );
    const parent = scopes.at(-1);
    const declaredDefault = tag.attributes.xmlns?.value;
    const original = declaredDefault ?? parent?.original ?? "";
    let normalized = declaredDefault ?? parent?.normalized ?? "";
    // Only the real worksheet/extLst/ext boundary is opaque. Preserve the whole ext slice,
    // and use the existing normalization path if its inherited default namespace would change.
    if (
      scopes.length === 2 &&
      parent?.local === "extLst" &&
      parent.uri === NS &&
      tag.local === "ext" &&
      tag.uri === NS &&
      original === normalized
    ) {
      opaque = { start: openStart, depth: 1 };
      return;
    }
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
    scopes.push({ original, normalized, local: tag.local, uri: tag.uri });
  });
  parser.on("closetag", (tag) => {
    if (opaque) {
      if (--opaque.depth === 0) {
        const marker = `<!--${markerPrefix}:${extensions.length}-->`;
        extensions.push({ marker, raw: xml.slice(opaque.start, parser.position) });
        edits.push({ start: opaque.start, end: parser.position, text: marker });
        opaque = undefined;
      }
      return;
    }
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
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    result += xml.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  return {
    xml: result + xml.slice(offset),
    restore: (next) => {
      for (const { marker, raw } of extensions) {
        if (!next.includes(marker))
          throw new FileOperationError(
            "UNSUPPORTED_FEATURE",
            "工作表扩展无法原样保留；原文件保持不变。",
          );
        next = next.replace(marker, () => raw);
      }
      return next;
    },
  };
}

/** Normalize worksheet schema names without exposing opaque extensions to lexical selectors. */
export function normalizeWorksheetXml(xml: string): string {
  return worksheetXmlView(xml).xml;
}
