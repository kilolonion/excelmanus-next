import { parseRange } from "@excelmanus/core";
import { printNamesOf, printSettingsOf } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import type { PrintRange } from "./print";

export type PrintScope = "workbook" | "sheet" | "selection";

/** Only map the supported browser projection, without changing workbook metadata. */
export function workbookPrintPreview(
  snapshot: Pick<IWorkbookData, "resources"> & { sheets: Record<string, Partial<IWorksheetData>> },
  sheetId: string,
) {
  const settings = printSettingsOf(snapshot.sheets[sheetId]);
  const names = printNamesOf(snapshot, sheetId);
  const warnings: string[] = [];
  let area: PrintRange | undefined;
  if (names.printArea) {
    try {
      const parsed = parseRange(names.printArea);
      area = {
        startRow: parsed.startRow - 1,
        endRow: parsed.endRow - 1,
        startColumn: parsed.startCol - 1,
        endColumn: parsed.endCol - 1,
      };
    } catch {
      warnings.push("工作簿打印区域超出有效单元格范围，无法用于浏览器预览。");
    }
  }
  if (!area)
    warnings.push(
      names.definedNames.some((name) => name.name.toLowerCase() === "_xlnm.print_area")
        ? "工作簿打印区域不是可用的单矩形区域，初始范围已回退到当前工作表。可另选当前选区。"
        : "工作簿未设置打印区域，初始范围已回退到当前工作表。",
    );
  if (names.unsupported.length || settings.unsupported?.length)
    warnings.push("部分工作簿打印设置无法解释，以下仅显示可读取的配置；这些设置未投影到预览。");
  const page = settings.pageSetup ?? {};
  const orientation =
    page.paperSize === "9" && page.orientation === "landscape" ? "landscape" : "portrait";
  if (page.paperSize !== "9")
    warnings.push(
      page.paperSize
        ? `源纸张代码为 ${page.paperSize}；浏览器预览仅支持 A4，初始使用纵向 A4。`
        : "源纸张未明确设为 A4；浏览器预览初始使用纵向 A4。",
    );
  else if (page.orientation !== "portrait" && page.orientation !== "landscape")
    warnings.push("源方向未明确设为横向或纵向；浏览器预览初始使用纵向 A4。");

  const unset = "未设置";
  const summary: Array<{ label: string; value: string }> = [
    {
      label: "打印区域",
      value:
        names.definedNames
          .filter((name) => name.name.toLowerCase() === "_xlnm.print_area")
          .map((name) => name.formulaOrRefString)
          .join("；") || unset,
    },
    {
      label: "纸张 / 方向",
      value: `${page.paperSize === "9" ? "A4" : page.paperSize ? `纸张代码 ${page.paperSize}` : unset} / ${page.orientation === "landscape" ? "横向" : page.orientation === "portrait" ? "纵向" : (page.orientation ?? unset)}`,
    },
    {
      label: "重复标题",
      value: `行 ${names.repeatRows ?? unset}；列 ${names.repeatColumns ?? unset}`,
    },
    {
      label: "分页位置（行 / 列之后）",
      value: [settings.rowBreaks, settings.colBreaks]
        .map(
          (group) =>
            group?.breaks
              .map(
                (item) =>
                  `${item.id}（${item.man === "1" || item.man === "true" ? "手动" : "非手动"}）`,
              )
              .join("、") || unset,
        )
        .join(" / "),
    },
    {
      label: "源缩放（未投影）",
      value: `fitToPage=${settings.pageSetUpPr?.fitToPage ?? unset}；fitToWidth=${page.fitToWidth ?? unset}；fitToHeight=${page.fitToHeight ?? unset}；scale=${page.scale ?? unset}`,
    },
    {
      label: "源页边距（英寸，未投影）",
      value: (
        [
          ["left", "左"],
          ["right", "右"],
          ["top", "上"],
          ["bottom", "下"],
          ["header", "页眉"],
          ["footer", "页脚"],
        ] as const
      )
        .map(([key, label]) => `${label} ${settings.pageMargins?.[key] ?? unset}`)
        .join("；"),
    },
  ];
  for (const [key, label] of [
    ["oddHeader", "奇数页页眉"],
    ["oddFooter", "奇数页页脚"],
    ["evenHeader", "偶数页页眉"],
    ["evenFooter", "偶数页页脚"],
    ["firstHeader", "首页页眉"],
    ["firstFooter", "首页页脚"],
  ] as const) {
    const value = settings.headerFooter?.[key];
    if (value !== undefined) summary.push({ label, value });
  }
  return {
    area,
    areaLabel: names.printArea,
    scope: (area ? "workbook" : "sheet") as PrintScope,
    orientation: orientation as "portrait" | "landscape",
    warnings,
    summary,
  };
}
