import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({
  api: () => {
    throw new Error("capture must not request API");
  },
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/lib/backend/sync", () => ({
  SyncClient: class {
    start() {}
    subscribe() {}
    send() {
      return true;
    }
  },
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: { getState: () => ({ workspaceId: "workspace" }) },
}));

import { WorkbookObject } from "../src/components/excel/WorkbookObject";
import { sendSync, startChannel } from "../src/lib/backend/channel";

afterEach(() => vi.unstubAllGlobals());

test("capture page rejects channel startup and outbound document mutations", () => {
  vi.stubGlobal("window", { location: { search: "?capture=1" } });
  expect(() => startChannel({ onIncompatible() {} })).toThrow("只读截图");
  expect(() => sendSync({ type: "ping" })).toThrow("只读截图");
});

test("normal editor and capture-like query values keep their channel behavior", () => {
  for (const search of ["", "?capture=0", "?renderer=1", "?returnTo=%3Fcapture%3D1"]) {
    vi.stubGlobal("window", { location: { search } });
    expect(() => startChannel({ onIncompatible() {} })).not.toThrow();
    expect(sendSync({ type: "ping" })).toBe(true);
  }
});

test("capture object never exposes destructive image controls", () => {
  const html = renderToString(
    createElement(WorkbookObject, {
      popup: {
        extraProps: {
          captureReadonly: true,
          docId: "doc",
          sheetId: "sheet",
          image: { id: "image", title: "截图", width: 20, height: 20 },
          onDelete: async () => {},
        },
      },
    }),
  );
  expect(html).not.toContain("删除图片");
});

// These functions are also used by the browser entry, rather than a second test renderer.
import {
  assertCaptureCommand,
  captureCoverage,
  prepareCapturePacket,
} from "../src/components/excel/WorkbookCaptureView";
import { captureImageSource } from "../src/components/excel/WorkbookObject";

const packet = () => ({
  workspaceId: "workspace",
  docId: "doc",
  sheetId: "s",
  rev: 4,
  range: "A1:C4",
  bounds: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 },
  viewport: { width: 1000, height: 700 },
  dpr: 1,
  snapshot: {
    id: "unit",
    sheetOrder: ["s"],
    sheets: { s: { id: "s", name: "Sheet1", cellData: { 0: { 0: { v: 7 } } } } },
  },
});

test("capture packet detaches caller data and rejects range or sheet mismatches", () => {
  const input = packet();
  const prepared = prepareCapturePacket(input);
  input.snapshot.sheets.s.cellData[0][0].v = 99;
  expect(prepared.snapshot.sheets.s.cellData).toEqual({ 0: { 0: { v: 7 } } });
  expect(() => prepareCapturePacket({ ...packet(), sheetId: "missing" })).toThrow();
  expect(() => prepareCapturePacket({ ...packet(), range: "B1:C4" })).toThrow();
});

test("capture refuses authored mutations while preserving view and derived calculation", () => {
  for (const id of [
    "sheet.mutation.set-range-values",
    "excelmanus.mutation.set-sheet-objects",
    "formula.mutation.set-defined-name",
    "sheet.mutation.set-style",
  ]) {
    expect(() => assertCaptureCommand({ id, type: 2 })).toThrow("只读截图");
  }
  expect(() => assertCaptureCommand({ id: "sheet.operation.set-scroll", type: 1 })).not.toThrow();
  expect(() =>
    assertCaptureCommand({ id: "formula.mutation.set-formula-calculation-result", type: 2 }),
  ).not.toThrow();
  expect(() =>
    assertCaptureCommand(
      { id: "sheet.mutation.set-range-values", type: 2 },
      { applyFormulaCalculationResult: true },
    ),
  ).not.toThrow();
});

test("coverage does not call a partially clipped last cell fully visible", () => {
  const bounds = packet().bounds;
  expect(
    captureCoverage(
      bounds,
      bounds,
      { left: 40, top: 20, right: 300, bottom: 150 },
      { left: 40, top: 20, right: 310, bottom: 160 },
    ),
  ).toBe(true);
  expect(
    captureCoverage(
      bounds,
      bounds,
      { left: 40, top: 20, right: 300, bottom: 165 },
      { left: 40, top: 20, right: 310, bottom: 160 },
    ),
  ).toBe(false);
  expect(
    captureCoverage(
      bounds,
      { ...bounds, endRow: 2 },
      { left: 40, top: 20, right: 300, bottom: 150 },
      { left: 40, top: 20, right: 310, bottom: 160 },
    ),
  ).toBe(false);
});

test("capture images only use embedded bytes and fail rather than fetch missing images", () => {
  expect(captureImageSource({ data: "aGVsbG8=", mediaType: "image/png" })).toBe(
    "data:image/png;base64,aGVsbG8=",
  );
  expect(() => captureImageSource({ mediaType: "image/png" })).toThrow("冻结图片");
  expect(() =>
    captureImageSource({ data: "https://example.com/image.png", mediaType: "image/png" }),
  ).toThrow("冻结图片");
});

test("frozen panes remain an explicitly partial capture even when main-viewport cells fit", () => {
  const bounds = packet().bounds;
  const rect = { left: 40, top: 20, right: 300, bottom: 150 };
  expect(captureCoverage(bounds, bounds, rect, rect, { xSplit: 0, ySplit: 1 })).toBe(false);
  expect(captureCoverage(bounds, bounds, rect, rect, { xSplit: 1, ySplit: 0 })).toBe(false);
  expect(captureCoverage(bounds, bounds, rect, rect, { xSplit: 0, ySplit: 0 })).toBe(true);
});

import { ICommandService, Univer } from "@univerjs/core";

test("real Univer command dispatch cannot execute a guarded authored write", () => {
  const univer = new Univer();
  const commands = univer.__getInjector().get(ICommandService);
  let writes = 0;
  commands.registerCommand({
    id: "sheet.mutation.set-range-values",
    type: 2,
    handler: () => {
      writes += 1;
      return true;
    },
  });
  const guard = commands.beforeCommandExecuted(assertCaptureCommand);
  try {
    expect(() => commands.syncExecuteCommand("sheet.mutation.set-range-values", {})).toThrow(
      "只读截图",
    );
    expect(writes).toBe(0);
    expect(
      commands.syncExecuteCommand(
        "sheet.mutation.set-range-values",
        {},
        { applyFormulaCalculationResult: true },
      ),
    ).toBe(true);
    expect(writes).toBe(1);
  } finally {
    guard.dispose();
    univer.dispose();
  }
});

import { captureObjectsReady } from "../src/components/excel/WorkbookCaptureView";

test("offscreen failed objects do not block the viewport while intersecting objects must render", () => {
  const clip = { left: 40, top: 20, right: 800, bottom: 600 };
  const visible = { rect: { left: 50, top: 30, right: 150, bottom: 90 }, ready: true };
  const offscreen = {
    rect: { left: 900, top: 30, right: 1000, bottom: 90 },
    ready: false,
    error: "offscreen image failed",
  };
  expect(captureObjectsReady([visible, offscreen], clip)).toBe(true);
  expect(captureObjectsReady([{ ...visible, ready: false }], clip)).toBe(false);
  expect(() =>
    captureObjectsReady([{ ...offscreen, rect: { ...offscreen.rect, left: 790 } }], clip),
  ).toThrow("offscreen image failed");
  expect(
    captureObjectsReady([{ ...offscreen, rect: { ...offscreen.rect, left: 800 } }], clip),
  ).toBe(true);
});
