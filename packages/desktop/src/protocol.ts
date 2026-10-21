// app://excelmanus/ 前端来源（13 §1.1）：把请求路径映射到打包的前端静态文件，拒绝穿越；
// 非静态文件路径回退 index.html（SPA）。

import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

export const APP_ORIGIN = "app://excelmanus";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".wasm": "application/wasm",
};

/** 返回要读取的文件与 MIME；越界返回 undefined。 */
export function resolveAppFile(
  webRoot: string,
  url: string,
): { file: string; mime: string } | undefined {
  const u = new URL(url);
  if (`${u.protocol}//${u.host}` !== APP_ORIGIN) return undefined;
  const root = realpathSync(webRoot);
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  const target = resolve(root, `.${p}`);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel.startsWith("..")) return undefined;
  let file = join(root, "index.html");
  if (existsSync(target) && statSync(target).isFile()) {
    const real = realpathSync(target);
    const realRel = relative(root, real);
    if (isAbsolute(realRel) || realRel.startsWith("..")) return undefined;
    file = real;
  }
  return { file, mime: MIME[extname(file)] ?? "application/octet-stream" };
}

/** 前端页面的 CSP：只允许自身来源与本机后端（端口运行时确定）。 */
export function contentSecurityPolicy(backendPort: number): string {
  const api = `http://127.0.0.1:${backendPort} ws://127.0.0.1:${backendPort}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${api}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
