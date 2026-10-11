// 内容寻址存储（03 §8、10 §2）：<dataDir>/blobs/<前两位>/<sha256>，按内容去重。
// 用于消息附件；写入先落临时文件再改名，读出前校验哈希格式防止路径穿越。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

export class BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private pathOf(sha256: string): string {
    if (!SHA256.test(sha256)) throw new Error("blob 哈希不合法");
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /** 写入并返回 sha256；已存在则不重复写。 */
  put(bytes: Uint8Array): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = this.pathOf(sha256);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    return sha256;
  }

  has(sha256: string): boolean {
    return SHA256.test(sha256) && existsSync(this.pathOf(sha256));
  }

  /** 读出内容；不存在返回 null。 */
  get(sha256: string): Buffer | null {
    if (!this.has(sha256)) return null;
    return readFileSync(this.pathOf(sha256));
  }
}
