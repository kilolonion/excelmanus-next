import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@excelmanus/protocol";

export interface PdfReadOptions {
  page?: number;
  pageCount?: number;
  charOffset?: number;
  render?: boolean;
}
const MAX_CHARS = 16_000;

/** Embedded text first; scanned pages become visual input rather than an empty successful read. */
export async function readPdf(
  bytes: Uint8Array,
  options: PdfReadOptions = {},
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (code: string, message: string): ToolResult => ({
    status: "error",
    error: { code, message, retryable: false },
  });
  if (bytes.length > 50 * 1024 * 1024)
    return fail("LIMIT_EXCEEDED", "PDF 超过 50 MB，请拆分后读取");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const resources = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const loading = getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: join(resources, "cmaps") + sep,
    cMapPacked: true,
    standardFontDataUrl: join(resources, "standard_fonts") + sep,
    wasmUrl: join(resources, "wasm") + sep,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const abort = () => {
    void loading.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const doc = await loading.promise;
    const first = options.page ?? 1,
      count = options.pageCount ?? 1;
    if (
      !Number.isInteger(first) ||
      first < 1 ||
      first > doc.numPages ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 3
    )
      return fail(
        "INVALID_ARGUMENT",
        `PDF 共 ${doc.numPages} 页；page 从 1 开始，pageCount 为 1–3`,
      );
    const chunks: string[] = [],
      renderedPages: number[] = [];
    const pages: { page: number; textChars: number; textComplete: boolean; rendered: boolean }[] =
      [];
    const images: NonNullable<ToolResult["images"]> = [];
    let budget = MAX_CHARS,
      nextPage: number | null = null,
      nextCharOffset = 0;
    for (let n = first; n <= Math.min(doc.numPages, first + count - 1); n++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      try {
        const text = (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim();
        const offset = n === first ? (options.charOffset ?? 0) : 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
          return fail(
            "INVALID_ARGUMENT",
            `第 ${n} 页文本长度为 ${text.length}，charOffset 超出范围`,
          );
        const content = text.slice(offset, offset + budget);
        budget -= content.length;
        chunks.push(`[第 ${n} 页]\n${content || "（无可提取文本，见本页图像）"}`);
        const render = options.render === true || text.length === 0;
        if (render) {
          const { createCanvas } = await import("@napi-rs/canvas");
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, 1800 / Math.max(base.width, base.height));
          const viewport = page.getViewport({ scale });
          if (
            !Number.isFinite(viewport.width) ||
            !Number.isFinite(viewport.height) ||
            viewport.width < 1 ||
            viewport.height < 1
          )
            return fail("INVALID_ARGUMENT", `第 ${n} 页尺寸无效`);
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          // PDF.js supports Node canvas; its public TypeScript declaration only names the DOM context.
          const canvasContext = canvas.getContext("2d") as unknown as NonNullable<
            Parameters<typeof page.render>[0]["canvasContext"]
          >;
          await page.render({ canvas: null, canvasContext, viewport }).promise;
          images.push({
            mediaType: "image/png",
            data: (await canvas.encode("png")).toString("base64"),
          });
          renderedPages.push(n);
        }
        const complete = offset + content.length >= text.length;
        pages.push({ page: n, textChars: text.length, textComplete: complete, rendered: render });
        nextPage = complete ? (n < doc.numPages ? n + 1 : null) : n;
        nextCharOffset = complete ? 0 : offset + content.length;
        if (!complete || budget === 0) break;
      } finally {
        page.cleanup();
      }
    }
    return {
      status: "ok",
      data: {
        kind: "pdf",
        totalPages: doc.numPages,
        page: first,
        returnedPages: pages.length,
        pages,
        content: chunks.join("\n\n"),
        nextPage,
        nextCharOffset,
        truncated: nextPage !== null,
        renderedPages,
        sizeBytes: bytes.length,
        message:
          "文本来自 PDF 内嵌文字；无文字页自动提供图像，需要视觉模型识别。图像按 renderedPages 顺序排列，最长边不超过 1800 像素。继续读取用 nextPage，页内续读同时带 nextCharOffset。",
      },
      ...(images.length ? { images } : {}),
    };
  } catch (error) {
    if (signal?.aborted) return fail("CANCELLED", "PDF 读取已取消");
    const name = error instanceof Error ? error.name : "";
    return fail(
      name === "PasswordException" ? "UNSUPPORTED_FEATURE" : "INVALID_ARGUMENT",
      name === "PasswordException"
        ? "PDF 已加密，请提供解密后的副本"
        : `无法读取 PDF：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    await loading.destroy().catch(() => {});
  }
}
