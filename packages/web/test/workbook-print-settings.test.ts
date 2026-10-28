import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

// Render the dialog contents without a browser portal; preview effects do not run in SSR.
vi.mock("@/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => children;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});

import { WorkbookPrintDialog } from "../src/components/excel/WorkbookPrintDialog";

function snapshot(area = "打印!$A$1:$F$24") {
  return {
    sheets: {
      other: {
        id: "other",
        name: "其他",
        custom: {
          excelmanusPrintSettings: { pageSetup: { orientation: "portrait", paperSize: "9" } },
        },
      },
      active: {
        id: "active",
        name: "打印",
        cellData: { 30: { 8: { v: "outside print area" } } },
        custom: {
          excelmanusPrintSettings: {
            pageSetup: { orientation: "landscape", paperSize: "9", fitToHeight: "0" },
            pageSetUpPr: { fitToPage: "1" },
            pageMargins: { left: "0.4", right: "0.4", top: "0.5", bottom: "0.5" },
            rowBreaks: { attributes: {}, breaks: [{ id: "12", man: "1", max: "16383" }] },
            colBreaks: { attributes: {}, breaks: [{ id: "3", man: "1", max: "1048575" }] },
            headerFooter: {
              attributes: {},
              oddHeader: "&LLayout QA&C&F&R&A",
              oddFooter: "&LInternal&CPage &P of &N&R2026",
            },
          },
        },
      },
    },
    resources: [
      {
        name: "SHEET_DEFINED_NAME_PLUGIN",
        data: JSON.stringify({
          area: {
            id: "area",
            name: "_xlnm.Print_Area",
            formulaOrRefString: area,
            localSheetId: "active",
          },
          titles: {
            id: "titles",
            name: "_xlnm.Print_Titles",
            formulaOrRefString: "打印!$1:$2",
            localSheetId: "active",
          },
        }),
      },
    ],
  };
}

function render(value: ReturnType<typeof snapshot>) {
  const api = {
    wb: { save: () => value, getActiveSheet: () => ({ getSheetId: () => "active" }) },
  } as unknown as Parameters<typeof WorkbookPrintDialog>[0]["api"];
  return renderToString(
    createElement(WorkbookPrintDialog, { api, name: "打印.xlsx", onClose() {} }),
  );
}

test("print dialog initializes from the active snapshot's single print area and A4 landscape", async () => {
  const value = snapshot();
  const before = structuredClone(value);
  const html = render(value);
  expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>工作簿打印区域<\/button>/);
  expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>横向 A4<\/button>/);
  expect(html).toContain("A1:F24");
  const { workbookPrintPreview } = await import("../src/lib/workbook/print-settings");
  const mapped = workbookPrintPreview(value, "active");
  expect(mapped.area).toEqual({ startRow: 0, endRow: 23, startColumn: 0, endColumn: 5 });
  expect(mapped.orientation).toBe("landscape");
  expect(mapped.scope).toBe("workbook");
  expect(value).toEqual(before);
});

test("print dialog shows workbook-only settings and explicit projection limits", () => {
  const html = render(snapshot());
  expect(html).toContain("预览自动适宽");
  expect(html).toContain("不会写回工作簿");
  expect(html).toContain("不代表 XLSX 打印保真");
  expect(html).toContain("手动分页、重复标题和页眉页脚（含动态字段）未投影");
  expect(html).toContain("相交合并单元格");
  expect(html).toContain("&amp;LLayout QA&amp;C&amp;F&amp;R&amp;A");
  expect(html).toContain("英寸");
  expect(html).toContain("12");
});

test("complex print areas visibly fall back to the sheet rather than silently exporting a partial area", async () => {
  const value = snapshot("打印!$A$1:$F$24,打印!$H$1:$J$4");
  const html = render(value);
  expect(html).toContain("已回退到当前工作表");
  expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>当前工作表<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>工作簿打印区域<\/button>/);
  const { workbookPrintPreview } = await import("../src/lib/workbook/print-settings");
  const mapped = workbookPrintPreview(value, "active");
  expect(mapped.area).toBeUndefined();
  expect(mapped.scope).toBe("sheet");
  expect(mapped.warnings.length).toBeGreaterThan(0);
});
