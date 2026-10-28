import { FileOperationError } from "@excelmanus/kernel";
import { SaxesParser, type SaxesTagNS } from "saxes";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CALC_FOLLOWERS = new Set([
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
  "extLst",
]);

export interface WorkbookSheetEntry {
  name?: string;
  sheetId?: string;
  state?: string;
  rid?: string;
}

/** Only the workbook manifest is read here. The original XML remains the preservation base. */
export function readWorkbookManifest(xml: string): {
  sheets: WorkbookSheetEntry[];
  legacyWriter: { sheets: boolean; calcPr: boolean };
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new FileOperationError("INVALID_ARGUMENT", "工作簿 XML 不允许 DTD 或实体声明");
  const sheets: WorkbookSheetEntry[] = [];
  const stack: SaxesTagNS[] = [];
  const legacyWriter = { sheets: true, calcPr: true };
  let sheetLists = 0;
  let calcNodes = 0;
  const attr = (tag: SaxesTagNS, local: string, uri = "") =>
    Object.values(tag.attributes).find((a) => a.local === local && a.uri === uri)?.value;
  const main = (tag: SaxesTagNS | undefined, local: string) =>
    tag?.local === local && tag.uri === MAIN;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    const depth = stack.length;
    if (depth === 0) {
      if (!main(tag, "workbook"))
        throw new FileOperationError(
          "INVALID_ARGUMENT",
          "工作簿根元素不是受支持的 workbook 命名空间",
        );
      const legacyRoot = tag.name === "workbook" && tag.attributes.xmlns?.value === MAIN;
      legacyWriter.sheets = legacyRoot;
      legacyWriter.calcPr = legacyRoot;
    }
    const sheetList = depth === 1 && main(tag, "sheets");
    const sheet = depth === 2 && main(stack[1], "sheets") && main(tag, "sheet");
    if (sheetList) {
      sheetLists++;
      if (tag.name !== "sheets") legacyWriter.sheets = false;
    }
    if (sheet) {
      sheets.push({
        name: attr(tag, "name"),
        sheetId: attr(tag, "sheetId"),
        state: attr(tag, "state"),
        rid: attr(tag, "id", REL),
      });
      if (tag.name !== "sheet" || tag.attributes["r:id"]?.uri !== REL) legacyWriter.sheets = false;
    }
    // The existing writer searches lexical names, so a foreign/nested match is unsafe to patch.
    if ((tag.name === "sheets" && !sheetList) || (tag.name === "sheet" && !sheet))
      legacyWriter.sheets = false;
    if (depth === 1 && main(tag, "calcPr")) {
      calcNodes++;
      if (tag.name !== "calcPr") legacyWriter.calcPr = false;
    } else if (tag.name === "calcPr") legacyWriter.calcPr = false;
    if (depth === 1 && tag.uri === MAIN && CALC_FOLLOWERS.has(tag.local) && tag.prefix)
      legacyWriter.calcPr = false;
    stack.push(tag);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError("INVALID_ARGUMENT", "工作簿 manifest XML 无法解析");
  }
  if (sheetLists !== 1)
    throw new FileOperationError("INVALID_ARGUMENT", "工作簿缺少唯一的标准 sheets 清单");
  if (calcNodes > 1) legacyWriter.calcPr = false;
  return { sheets, legacyWriter };
}

/** A readable QName is not permission to send it through the older lexical workbook writer. */
export function assertLegacyWorkbookWriteSupported(
  xml: string,
  writes: { sheets?: boolean; calcPr?: boolean },
): void {
  if (!writes.sheets && !writes.calcPr) return;
  const { legacyWriter } = readWorkbookManifest(xml);
  if ((writes.sheets && !legacyWriter.sheets) || (writes.calcPr && !legacyWriter.calcPr))
    throw new FileOperationError(
      "UNSUPPORTED_FEATURE",
      "此工作簿的命名空间写法支持读取与普通数值编辑，但暂不支持本次工作表清单或公式重算标记修改；本批修改未执行。",
    );
}
