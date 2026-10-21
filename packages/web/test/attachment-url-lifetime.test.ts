import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ api: () => ({ getAttachment: h.download }) }));

beforeEach(() => {
  vi.resetModules();
  h.download.mockReset().mockResolvedValue(new Blob(["image"]));
  let serial = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++serial}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

test("concurrent thumbnails and recent remounts reuse a download and URL", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  const first = acquire("same"),
    second = acquire("same");
  expect(second.url).toBe(first.url);
  const url = await first.url;
  first.release();
  first.release();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  second.release();
  const reopened = acquire("same");
  expect(await reopened.url).toBe(url);
  expect(h.download).toHaveBeenCalledTimes(1);
  reopened.release();
});

test("idle thumbnail count is bounded without revoking a mounted image", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  const active = acquire("active");
  const activeUrl = await active.url;
  for (let i = 0; i < 40; i++) {
    const item = acquire(`idle-${i}`);
    await item.url;
    item.release();
  }
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(8);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(activeUrl);
  const recent = acquire("idle-39");
  await recent.url;
  expect(h.download).toHaveBeenCalledTimes(41);
  const evicted = acquire("idle-0");
  await evicted.url;
  expect(h.download).toHaveBeenCalledTimes(42);
  recent.release();
  evicted.release();
  active.release();
});

test("idle byte budget releases large images only after the last thumbnail unmounts", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  h.download.mockResolvedValue(new Blob([new Uint8Array(17 * 1024 * 1024)]));
  const first = acquire("large-1");
  const firstUrl = await first.url;
  first.release();
  const second = acquire("large-2");
  const secondUrl = await second.url;
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  second.release();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(secondUrl);
});

test("late downloads join the idle budget after all consumers have gone", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  let resolve!: (blob: Blob) => void;
  h.download.mockReturnValue(
    new Promise<Blob>((r) => {
      resolve = r;
    }),
  );
  const pending = acquire("late");
  pending.release();
  resolve(new Blob([new Uint8Array(33 * 1024 * 1024)]));
  const url = await pending.url;
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  expect(h.download).toHaveBeenCalledTimes(1);
});

test("a failed download can retry and releasing the old lease cannot remove the new one", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  h.download.mockRejectedValueOnce(new Error("unavailable"));
  const failed = acquire("retry");
  await expect(failed.url).rejects.toThrow("unavailable");
  const retry = acquire("retry");
  failed.release();
  await retry.url;
  expect(acquire("retry").url).toBe(retry.url);
  expect(h.download).toHaveBeenCalledTimes(2);
  retry.release();
});

test("URL preparation failure does not poison a later retry", async () => {
  const { acquireAttachmentUrl: acquire } = await import("../src/lib/attachment-urls");
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw new Error("URL unavailable");
  });
  const failed = acquire("url-failed");
  await expect(failed.url).rejects.toThrow("URL unavailable");
  failed.release();
  const retry = acquire("url-failed");
  await expect(retry.url).resolves.toMatch(/^blob:/);
  expect(h.download).toHaveBeenCalledTimes(2);
  retry.release();
});
