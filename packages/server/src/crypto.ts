// 主密钥与凭据加解密（10 §4）：master.key 32 字节 0600；
// API Key 用 AES-256-GCM，每条记录独立随机 nonce；读接口只返回掩码。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadMasterKey(dataDir: string): Buffer {
  const p = join(dataDir, "master.key");
  if (existsSync(p)) {
    const key = readFileSync(p);
    if (key.length !== 32) {
      throw new Error(`${p} 不是 32 字节主密钥，可能已损坏`);
    }
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(p, key, { mode: 0o600 });
  chmodSync(p, 0o600);
  return key;
}

/** 输出 = nonce || ciphertext || tag，调用方按列拆开存。 */
export function encryptSecret(
  masterKey: Buffer,
  plaintext: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), nonce };
}

export function decryptSecret(masterKey: Buffer, ciphertext: Buffer, nonce: Buffer): string {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const enc = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** 掩码：只显示末 4 位，短于 8 位全掩。 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}
