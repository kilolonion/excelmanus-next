import { expect, test } from "vitest";
import { RenderBroker } from "../src/render.ts";

const layout = {
  width: 180,
  height: 50,
  cells: [{ x: 0, y: 0, w: 180, h: 50, text: "核对 合计 46.00", bold: true, fill: "#d9eade" }],
};
test("without a connected UI, the broker produces a real PNG", async () => {
  const broker = new RenderBroker();
  const png = Buffer.from(await broker.request(layout), "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(360);
  expect(png.readUInt32BE(20)).toBe(100);
  expect(png.length).toBeGreaterThan(1000);
});
test("a disconnected UI renderer falls back instead of losing the render request", async () => {
  const broker = new RenderBroker();
  broker.addRenderer("ui", () => {});
  const pending = broker.request(layout);
  broker.removeRenderer("ui");
  expect(Buffer.from(await pending, "base64").readUInt32BE(16)).toBe(360);
});

test("a stalled UI renderer falls back after its timeout", async () => {
  const broker = new RenderBroker();
  broker.addRenderer("stalled", () => {});
  expect(Buffer.from(await broker.request(layout, 2, 1), "base64").readUInt32BE(16)).toBe(360);
});

test("headless PNG paints borders, data bars, icons and embedded images", async () => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const { renderHeadless } = await import("../src/headless-render.ts");
  const stamp = createCanvas(10, 10),
    sc = stamp.getContext("2d");
  sc.fillStyle = "#ff00ff";
  sc.fillRect(0, 0, 10, 10);
  const out = await renderHeadless(
    {
      width: 240,
      height: 140,
      cells: [
        { x: 44, y: 22, w: 80, h: 30, text: "", borders: { b: { style: 13, color: "#ff0000" } } },
        {
          x: 44,
          y: 55,
          w: 80,
          h: 30,
          text: "",
          dataBar: { start: 0, end: 0.75, color: "#00ff00", gradient: false },
        },
        {
          x: 44,
          y: 90,
          w: 80,
          h: 30,
          text: "",
          icon: { type: "3TrafficLights1", index: 0, count: 3 },
        },
      ],
      images: [
        {
          x: 150,
          y: 30,
          w: 30,
          h: 30,
          mediaType: "image/png",
          data: (await stamp.encode("png")).toString("base64"),
        },
      ],
    },
    1,
  );
  const decoded = await loadImage(Buffer.from(out, "base64")),
    canvas = createCanvas(240, 140),
    ctx = canvas.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  expect(pixel(70, 52)).toEqual([255, 0, 0, 255]);
  expect(pixel(60, 65)).toEqual([0, 255, 0, 255]);
  expect(pixel(55, 105)).toEqual([22, 163, 74, 255]);
  expect(pixel(160, 40)).toEqual([255, 0, 255, 255]);
});

test.each(["column", "bar", "line", "area", "scatter", "pie", "doughnut", "combo"] as const)(
  "headless %s chart contains real plotted data",
  async (type) => {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const { renderHeadless } = await import("../src/headless-render.ts");
    const png = await renderHeadless(
      {
        width: 380,
        height: 270,
        cells: [],
        charts: [
          {
            x: 44,
            y: 22,
            w: 320,
            h: 240,
            chart: {
              id: "chart",
              type,
              title: "核对",
              range: type === "combo" ? "A1:C4" : "A1:B4",
              anchor: "A1",
              width: 320,
              height: 240,
            },
            cells: {
              0: { 0: { v: "项目" }, 1: { v: "金额" }, 2: { v: "目标" } },
              1: { 0: { v: 1 }, 1: { v: 10 }, 2: { v: 15 } },
              2: { 0: { v: 2 }, 1: { v: 25 }, 2: { v: 20 } },
              3: { 0: { v: 3 }, 1: { v: 18 }, 2: { v: 22 } },
            },
          },
        ],
      },
      1,
    );
    const canvas = createCanvas(380, 270),
      ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(Buffer.from(png, "base64")), 0, 0);
    const pixels = ctx.getImageData(44, 22, 320, 240).data;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (
        pixels[i]! < 70 &&
        pixels[i + 1]! > 75 &&
        pixels[i + 1]! > pixels[i]! + 30 &&
        pixels[i + 2]! < 150
      )
        green++;
    expect(green).toBeGreaterThan(10);
  },
);

test("rich layouts never silently lose objects through a stale connected renderer", async () => {
  const broker = new RenderBroker();
  let called = false;
  broker.addRenderer("old", () => {
    called = true;
  });
  const png = await broker.request(
    { ...layout, cells: [{ ...layout.cells[0]!, borders: { b: { style: 8, color: "#ff0000" } } }] },
    1,
  );
  expect(called).toBe(false);
  expect(Buffer.from(png, "base64").readUInt32BE(16)).toBe(180);
});

test("number format colors reach actual PNG pixels", async () => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const { importCsv } = await import("../../modules/workbook/src/csv.ts");
  const { buildLayout } = await import("../../modules/workbook/src/render.ts");
  const { snapshot } = importCsv(new TextEncoder().encode("-1250.555\n"), "colors.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!] as Parameters<typeof buildLayout>[1];
  sheet.cellData![0]![0]!.s = { n: { pattern: "#,##0.00;[Red](#,##0.00)" } };
  const { layout: formatted } = buildLayout(snapshot, sheet, "A1:A1");
  const png = await new RenderBroker().request(formatted, 1);
  const canvas = createCanvas(formatted.width, formatted.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(Buffer.from(png, "base64")), 0, 0);
  const pixels = ctx.getImageData(44, 22, formatted.width - 44, formatted.height - 22).data;
  let red = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! > 150 && pixels[i + 1]! < 100 && pixels[i + 2]! < 100) red++;
  }
  expect(red).toBeGreaterThan(0);
});
