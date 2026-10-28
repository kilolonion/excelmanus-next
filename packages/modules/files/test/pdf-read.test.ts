import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { samplePdf } from "./fixtures/pdf.ts";
import { readPdf } from "../src/pdf.ts";

test("PDF text is paged with explicit continuation and invalid pages are rejected", async () => {
  const first = await readPdf(samplePdf(), { page: 1 });
  expect(first.status).toBe("ok");
  expect(first.data).toMatchObject({
    kind: "pdf",
    totalPages: 2,
    nextPage: 2,
    content: expect.stringContaining("total 46.00"),
  });
  expect(first.images).toBeUndefined();
  const second = await readPdf(samplePdf(), { page: 2 });
  expect(second.data).toMatchObject({ nextPage: null, content: expect.stringContaining("Page 2") });
  expect((await readPdf(samplePdf(), { page: 3 })).status).toBe("error");
});
test("image-only PDF pages return actual raster images, not empty text success", async () => {
  const canvas = createCanvas(260, 80),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 260, 80);
  ctx.fillStyle = "black";
  ctx.font = "24px sans-serif";
  ctx.fillText("Scan total 46.00", 10, 45);
  const result = await readPdf(samplePdf(await canvas.encode("jpeg")), { page: 1 });
  expect(result.data).toMatchObject({ renderedPages: [1] });
  expect(result.images?.[0]?.mediaType).toBe("image/png");
  expect(Buffer.from(result.images![0]!.data, "base64").subarray(0, 4)).toEqual(
    Buffer.from([137, 80, 78, 71]),
  );
});

test("PDF visual rendering can be requested for text pages without dropping extracted text", async () => {
  const result = await readPdf(samplePdf(), { page: 2, render: true });
  expect(result.data).toMatchObject({
    nextPage: null,
    renderedPages: [2],
    content: expect.stringContaining("Page 2"),
  });
  expect(result.images).toHaveLength(1);
});
