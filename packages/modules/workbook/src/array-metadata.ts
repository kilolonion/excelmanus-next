import { bytesOf, elements, replaceElement, setAttribute, textOf, xmlAttrs } from "./xml.ts";

type Parts = Record<string, Uint8Array>;
const PATH = "xl/metadata.xml",
  NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export function dynamicMetadataIndexes(parts: Parts): Set<number> {
  const xml = parts[PATH] ? textOf(parts[PATH]) : "",
    types = elements(elements(xml, "metadataTypes")[0]?.inner ?? "", "metadataType"),
    type = types.findIndex((e) => xmlAttrs(e.open).name === "XLDAPR") + 1;
  const future = elements(xml, "futureMetadata").find((e) => xmlAttrs(e.open).name === "XLDAPR"),
    blocks = elements(future?.inner ?? "", "bk");
  const indexes = new Set<number>();
  elements(elements(xml, "cellMetadata")[0]?.inner ?? "", "bk").forEach((b, i) => {
    if (
      elements(b.inner, "rc").some((e) => {
        const a = xmlAttrs(e.open);
        return (
          Number(a.t) === type &&
          /(?:fDynamic="1"|fDynamic="true")/.test(blocks[Number(a.v)]?.inner ?? "")
        );
      })
    )
      indexes.add(i + 1);
  });
  return indexes;
}
/** Append a dynamic-array metadata record without replacing other cell metadata. */
export function ensureDynamicMetadata(parts: Parts): number {
  const existing = dynamicMetadataIndexes(parts);
  let xml = parts[PATH] ? textOf(parts[PATH]) : `<metadata xmlns="${NS}"></metadata>`;
  const cells = elements(elements(xml, "cellMetadata")[0]?.inner ?? "", "bk");
  const reusable = [...existing].find(
    (i) => elements(cells[i - 1]?.inner ?? "", "rc").length === 1,
  );
  if (reusable) return reusable;
  let mt = elements(xml, "metadataTypes")[0],
    types = elements(mt?.inner ?? "", "metadataType"),
    type = types.findIndex((e) => xmlAttrs(e.open).name === "XLDAPR") + 1;
  if (!type) {
    type = types.length + 1;
    const node =
      '<metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/>';
    const block = `<metadataTypes count="${type}">${mt?.inner ?? ""}${node}</metadataTypes>`;
    xml = mt ? xml.replace(mt.raw, block) : xml.replace(/(<metadata\b[^>]*>)/, `$1${block}`);
  }
  const fm = elements(xml, "futureMetadata").find((e) => xmlAttrs(e.open).name === "XLDAPR"),
    count = elements(fm?.inner ?? "", "bk").length;
  const future =
    '<bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray" fDynamic="1" fCollapsed="0"/></ext></extLst></bk>';
  const fb = `<futureMetadata name="XLDAPR" count="${count + 1}">${fm?.inner ?? ""}${future}</futureMetadata>`;
  if (fm) xml = xml.replace(fm.raw, fb);
  else {
    const cell = elements(xml, "cellMetadata")[0];
    xml = cell
      ? xml.replace(cell.raw, fb + cell.raw)
      : xml.replace("</metadata>", fb + "</metadata>");
  }
  const cm = elements(xml, "cellMetadata")[0],
    index = elements(cm?.inner ?? "", "bk").length + 1;
  xml = replaceElement(
    xml,
    "cellMetadata",
    `<cellMetadata count="${index}">${cm?.inner ?? ""}<bk><rc t="${type}" v="${count}"/></bk></cellMetadata>`,
  );
  parts[PATH] = bytesOf(xml);
  let rel = textOf(parts["xl/_rels/workbook.xml.rels"]!);
  if (!rel.includes('/sheetMetadata"'))
    rel = rel.replace(
      "</Relationships>",
      '<Relationship Id="rId_em_array_metadata" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/></Relationships>',
    );
  parts["xl/_rels/workbook.xml.rels"] = bytesOf(rel);
  let typesXml = textOf(parts["[Content_Types].xml"]!);
  if (!typesXml.includes('PartName="/xl/metadata.xml"'))
    typesXml = typesXml.replace(
      "</Types>",
      '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/></Types>',
    );
  parts["[Content_Types].xml"] = bytesOf(typesXml);
  return index;
}
