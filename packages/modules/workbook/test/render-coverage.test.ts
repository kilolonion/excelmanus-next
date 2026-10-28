import type { ToolContext } from "@excelmanus/kernel";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { buildLayout, workbookRenderTool } from "../src/render.ts";
import { CF_RESOURCE } from "../src/rule-codec.ts";
import type { DocumentService } from "../src/service.ts";

function fixture() {
  const sheet = {
    id: "s",
    name: "核对",
    rowCount: 10,
    columnCount: 8,
    cellData: {
      0: { 0: { v: "项目" }, 1: { v: "金额" } },
      1: { 0: { v: "甲" }, 1: { v: 10, s: { bd: { b: { s: 8, cl: { rgb: "#ff0000" } } } } } },
      2: { 0: { v: "乙" }, 1: { v: 20 } },
    },
    custom: {
      excelmanusObjects: {
        charts: [
          {
            id: "c",
            type: "column",
            title: "金额",
            range: "A1:B3",
            anchor: "C2",
            width: 200,
            height: 120,
          },
        ],
        images: [
          {
            id: "i",
            title: "图",
            anchor: "F2",
            width: 30,
            height: 30,
            mediaType: "image/png",
            data: "aGVsbG8=",
          },
        ],
      },
    },
  } as unknown as IWorksheetData;
  const snapshot = {
    id: "book",
    sheetOrder: ["s"],
    sheets: { s: sheet },
    resources: [
      {
        name: CF_RESOURCE,
        data: JSON.stringify({
          s: [
            {
              cfId: "cf",
              ranges: [{ startRow: 1, endRow: 2, startColumn: 1, endColumn: 1 }],
              rule: {
                type: "colorScale",
                config: [
                  { color: "#ff0000", value: { type: "min" } },
                  { color: "#00ff00", value: { type: "max" } },
                ],
              },
            },
          ],
        }),
      },
    ],
  } as unknown as IWorkbookData;
  return { sheet, snapshot };
}

test("browser-view uses frozen packet and rejects a source changed during capture without fallback", async () => {
  const { snapshot } = fixture();
  let hash = "a".repeat(64),
    mutateDuringSnapshot = false,
    path = "fixture.xlsx",
    moveDuringCapture = false;
  const service = {
    editTarget() {
      return path;
    },
    snapshot: async () => {
      if (mutateDuringSnapshot) hash = "c".repeat(64);
      return { meta: { id: "d", path: "fixture.xlsx", rev: 4 }, snapshot };
    },
    sourceStatus: async () => ({ currentSha256: hash }),
    headRev: () => 4,
  } as unknown as DocumentService;
  const context = {
    workspaceId: "w",
    workspaceRoot: "/synthetic",
    signal: AbortSignal.timeout(10000),
    reads: { record() {} },
  } as unknown as ToolContext;
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1180, 16);
  png.writeUInt32BE(757, 20);
  let captured = 0,
    reconstructed = 0,
    mutate = false;
  const tool = workbookRenderTool(
    service,
    async () => {
      reconstructed++;
      return "unused";
    },
    async (packet) => {
      captured++;
      expect(packet).toMatchObject({ docId: "d", sheetId: "s", rev: 4, range: "A1:B2" });
      if (mutate) hash = "b".repeat(64);
      if (moveDuringCapture) path = "moved.xlsx";
      return {
        png: png.toString("base64"),
        receipt: {
          docId: "d",
          sheetId: "s",
          rev: 4,
          requestedRange: "A1:B2",
          visibleRange: "A1:M22",
          fullyVisible: true,
          viewport: { width: 1180, height: 757 },
          dpr: 1,
          zoom: 1,
          scroll: { row: 0, column: 0 },
        },
      };
    },
  );
  const result = await tool.execute({ docId: "d", range: "A1:B2", mode: "browser-view" }, context);
  expect(result).toMatchObject({ status: "ok", data: { image: { mode: "browser-view" } } });
  expect(captured).toBe(1);
  expect(reconstructed).toBe(0);
  mutate = true;
  const stale = await tool.execute({ docId: "d", range: "A1:B2", mode: "browser-view" }, context);
  expect(stale).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
  expect(stale.images).toBeUndefined();
  mutate = false;
  mutateDuringSnapshot = true;
  const raced = await tool.execute({ docId: "d", range: "A1:B2", mode: "browser-view" }, context);
  expect(raced).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
  expect(raced.images).toBeUndefined();
  mutateDuringSnapshot = false;
  moveDuringCapture = true;
  const moved = await tool.execute({ docId: "d", range: "A1:B2", mode: "browser-view" }, context);
  expect(moved).toMatchObject({ status: "error", error: { code: "VERSION_CONFLICT" } });
  expect(moved.images).toBeUndefined();
});
test("default browser-view rejects missing capture capability instead of silently reconstructing", async () => {
  let reconstructed = 0;
  const service = { editTarget() {} } as unknown as DocumentService;
  const context = { workspaceId: "w", workspaceRoot: "/synthetic" } as ToolContext;
  const result = await workbookRenderTool(service, async () => {
    reconstructed++;
    return "unused";
  }).execute({ docId: "d" }, context);
  expect(result).toMatchObject({ status: "error", error: { code: "UNSUPPORTED_FEATURE" } });
  expect(reconstructed).toBe(0);
});

test("layout includes borders, conditional colors, current chart data and embedded images", () => {
  const { sheet, snapshot } = fixture();
  const out = buildLayout(snapshot, sheet, "A1:H8");
  const ten = out.layout.cells.find((c) => c.text === "10");
  expect(ten?.fill).toBe("#ff0000");
  expect(ten?.borders?.b).toEqual({ style: 8, color: "#ff0000" });
  expect(out.layout.charts).toHaveLength(1);
  expect(out.layout.charts?.[0]?.cells[2]?.[1]?.v).toBe(20);
  expect(out.layout.images?.[0]?.data).toBe("aGVsbG8=");
  expect(out.limitations.join(" ")).not.toContain("图表与图片未渲染");
});
test("overlays outside the viewport are omitted, intersecting objects keep clipping coordinates", () => {
  const { sheet, snapshot } = fixture();
  const out = buildLayout(snapshot, sheet, "D2:E6");
  expect(out.layout.charts).toHaveLength(1);
  expect(out.layout.charts?.[0]?.x).toBeLessThan(44);
  expect(out.layout.images).toHaveLength(0);
});

test("conditional highlights, signed bars, hidden values and formula limitations", () => {
  const { sheet, snapshot } = fixture();
  sheet.cellData![1]![1]!.v = -10;
  sheet.cellData![1]![1]!.s = { n: { pattern: "[Blue]0" } };
  const range = { startRow: 1, endRow: 2, startColumn: 1, endColumn: 1 };
  snapshot.resources = [
    {
      name: CF_RESOURCE,
      data: JSON.stringify({
        s: [
          {
            ranges: [range],
            rule: {
              type: "highlightCell",
              subType: "number",
              operator: "lessThan",
              value: 0,
              style: { cl: { rgb: "#ff0000" }, bl: 1 },
            },
          },
          {
            ranges: [range],
            rule: {
              type: "dataBar",
              isShowValue: false,
              config: {
                min: { type: "min" },
                max: { type: "max" },
                positiveColor: "#00ff00",
                nativeColor: "#ff0000",
                isGradient: false,
              },
            },
          },
          {
            ranges: [range],
            rule: {
              type: "highlightCell",
              subType: "formula",
              value: "=SUM(B2)>0",
              style: { bg: { rgb: "#ff00ff" } },
            },
          },
        ],
      }),
    },
  ];
  const out = buildLayout(snapshot, sheet, "A1:B3"),
    cell = out.layout.cells.find((c) => c.dataBar?.color === "#ff0000");
  expect(cell?.text).toBe("");
  expect(cell?.bold).toBe(true);
  expect(cell?.color).toBe("#ff0000");
  expect(cell?.dataBar?.start).toBe(0);
  expect(cell?.dataBar?.end).toBeCloseTo(1 / 3);
  expect(out.limitations.join(" ")).toContain("formula");
});
