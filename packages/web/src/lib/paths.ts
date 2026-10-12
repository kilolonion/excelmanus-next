// 工作区相对路径（POSIX，不带 ./ 前缀）的规范化与显示。

/** Markdown 链接 href 会被 URI 编码（非 ASCII），按原样解码一次。 */
export function decodeUriEscapedPath(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function normalizePath(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalizePath(a) === normalizePath(b);
}

export function fileName(path: string): string {
  const p = normalizePath(path);
  return p.split("/").pop() || p;
}

export function dirName(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  const d = normalizePath(dir);
  return d ? `${d}/${name}` : name;
}

/** 去掉扩展名的文件名（标题显示用）。 */
export function baseName(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
