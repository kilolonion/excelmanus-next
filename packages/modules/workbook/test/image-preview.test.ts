import { expect, test } from "vitest";
import { imagePreviewBytes } from "../src/objects.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=",
  "base64",
);
const image = {
  id: "i1",
  title: "测试",
  anchor: "D2",
  width: 100,
  height: 100,
  mediaType: "image/png" as const,
};
test("image preview reads embedded originals and newly added images without altering the package", () => {
  expect(
    imagePreviewBytes(
      { ...image, mediaPart: "xl/media/image1.png" },
      { "xl/media/image1.png": png },
    ),
  ).toEqual(png);
  expect(imagePreviewBytes({ ...image, data: png.toString("base64") }, {})).toEqual(png);
  expect(() => imagePreviewBytes({ ...image, mediaPart: "xl/media/missing.png" }, {})).toThrow();
});
