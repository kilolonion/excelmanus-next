import type { RenderLayout } from "@excelmanus/protocol";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { renderHeadless } from "../src/headless-render.ts";
import { RenderBroker } from "../src/render.ts";

const layout = {
  width: 360,
  height: 130,
  cells: [],
  shapes: [
    {
      x: 50,
      y: 30,
      w: 80,
      h: 80,
      shape: {
        id: "rect",
        title: "矩形",
        text: "OK",
        type: "rect",
        anchor: "A1",
        width: 80,
        height: 80,
        fill: "#FF0000",
        stroke: "#000000",
        textColor: "#FFFFFF",
      },
    },
    {
      x: 150,
      y: 30,
      w: 80,
      h: 80,
      shape: {
        id: "ellipse",
        title: "椭圆",
        text: "",
        type: "ellipse",
        anchor: "B1",
        width: 80,
        height: 80,
        fill: "#00FF00",
        stroke: "#000000",
      },
    },
    {
      x: 250,
      y: 30,
      w: 80,
      h: 80,
      shape: {
        id: "arrow",
        title: "右箭头",
        text: "",
        type: "rightArrow",
        anchor: "C1",
        width: 80,
        height: 80,
        fill: "#0000FF",
        stroke: "#000000",
      },
    },
  ],
} as unknown as RenderLayout;

test("PNG pixels include the three flat shape geometries, border and text", async () => {
  const canvas = createCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(Buffer.from(await renderHeadless(layout, 1), "base64")), 0, 0);
  const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  expect(pixel(60, 40)).toEqual([255, 0, 0, 255]);
  expect(pixel(190, 70)).toEqual([0, 255, 0, 255]);
  expect(pixel(152, 32)).toEqual([255, 255, 255, 255]);
  expect(pixel(270, 70)).toEqual([0, 0, 255, 255]);
  expect(pixel(252, 32)).toEqual([255, 255, 255, 255]);
  const border = ctx.getImageData(49, 40, 3, 20).data;
  expect(Array.from(border).some((v, i) => i % 4 === 0 && v < 130)).toBe(true);
  const text = ctx.getImageData(65, 55, 50, 30).data;
  let white = 0;
  for (let i = 0; i < text.length; i += 4)
    if ((text[i] ?? 0) > 220 && (text[i + 1] ?? 0) > 220 && (text[i + 2] ?? 0) > 220) white++;
  expect(white).toBeGreaterThan(10);
});

test("shape-only layouts bypass a stale UI that cannot paint new object types", async () => {
  const broker = new RenderBroker();
  let called = false;
  broker.addRenderer("stale", (message) => {
    called = true;
    if (message.type === "render.request")
      broker.handleResult("stale", { requestId: message.requestId, png: "old-ui" });
  });
  const png = await broker.request(layout, 1);
  expect(called).toBe(false);
  expect(Buffer.from(png, "base64").subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
});
