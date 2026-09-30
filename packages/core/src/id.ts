import { randomBytes } from "node:crypto";

const ID_RE = /^[a-z][a-z0-9]{0,15}$/;

/** 生成带前缀的随机 ID（如 ses_AbC123xYz）。 */
export function newId(prefix: string): string {
  if (!ID_RE.test(prefix)) {
    throw new Error(`非法 ID 前缀: ${prefix}`);
  }
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
