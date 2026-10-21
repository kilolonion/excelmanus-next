const ID_RE = /^[a-z][a-z0-9]{0,15}$/;

/** 生成带前缀的随机 ID（如 ses_AbC123xYz）。 */
export function newId(prefix: string): string {
  if (!ID_RE.test(prefix)) {
    throw new Error(`非法 ID 前缀: ${prefix}`);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const suffix = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return `${prefix}_${suffix}`;
}
