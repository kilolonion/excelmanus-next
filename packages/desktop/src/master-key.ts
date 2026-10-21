// 桌面主密钥（10 §4）：safeStorage 加密后存为 master.key.enc（macOS Keychain / Windows DPAPI）。
// 从本机 Web 形态迁移时，已有的明文 master.key 加密转存后删除；safeStorage 不可用
// （如 Linux 无密钥环）时回退为 0600 的 master.key 并报告，不静默降级。

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface MasterKeyResult {
  key: Buffer;
  /** encrypted = master.key.enc；plain = 回退到文件权限保护。 */
  storage: "encrypted" | "plain";
  migrated: boolean;
}

export function loadDesktopMasterKey(dataDir: string, safe: SafeStorageLike): MasterKeyResult {
  mkdirSync(dataDir, { recursive: true });
  const encPath = join(dataDir, "master.key.enc");
  const plainPath = join(dataDir, "master.key");
  const available = safe.isEncryptionAvailable();
  if (existsSync(encPath)) {
    if (!available) throw new Error("系统密钥存储不可用，无法解开 master.key.enc");
    const key = Buffer.from(safe.decryptString(readFileSync(encPath)), "base64");
    if (key.length !== 32) throw new Error("master.key.enc 内容损坏");
    return { key, storage: "encrypted", migrated: false };
  }
  let key: Buffer;
  let migrated = false;
  if (existsSync(plainPath)) {
    key = readFileSync(plainPath);
    if (key.length !== 32) throw new Error(`${plainPath} 不是 32 字节主密钥`);
    migrated = true;
  } else {
    key = randomBytes(32);
  }
  if (!available) {
    if (!existsSync(plainPath)) writeFileSync(plainPath, key, { mode: 0o600 });
    chmodSync(plainPath, 0o600);
    return { key, storage: "plain", migrated: false };
  }
  // 先写临时文件再改名，避免中途崩溃留下半个密钥文件
  const tmp = `${encPath}.tmp`;
  writeFileSync(tmp, safe.encryptString(key.toString("base64")), { mode: 0o600 });
  renameSync(tmp, encPath);
  if (migrated) rmSync(plainPath, { force: true });
  return { key, storage: "encrypted", migrated };
}
