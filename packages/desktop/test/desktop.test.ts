// 桌面纯逻辑：app:// 路径不越界、主密钥 safeStorage 加密存储与明文迁移（10 §4、13 §1.1）。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadDesktopMasterKey, type SafeStorageLike } from "../src/master-key.ts";
import { contentSecurityPolicy, resolveAppFile } from "../src/protocol.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "em-desktop-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 可逆但非明文的替身：只替代操作系统密钥存储
const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});

describe("app:// 协议", () => {
  test("静态文件、SPA 回退、拒绝穿越与越界符号链接", () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>");
    writeFileSync(join(root, "assets", "a.js"), "x");
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(root, "assets", "link.txt"));
    expect(resolveAppFile(root, "app://excelmanus/assets/a.js")?.mime).toContain("javascript");
    expect(resolveAppFile(root, "app://excelmanus/sessions/1")?.file).toMatch(/index\.html$/);
    expect(
      resolveAppFile(root, "app://excelmanus/..%2F..%2Fetc%2Fpasswd")?.file ?? "index",
    ).toMatch(/index/);
    expect(resolveAppFile(root, "app://excelmanus/assets/link.txt")).toBeUndefined();
    expect(resolveAppFile(root, "app://other/assets/a.js")).toBeUndefined();
    expect(contentSecurityPolicy(1234)).toContain(
      "connect-src 'self' http://127.0.0.1:1234 ws://127.0.0.1:1234",
    );
  });
});

describe("主密钥", () => {
  test("首次生成加密存储，再次读取一致，且磁盘上不是明文", () => {
    const d = tmp();
    const a = loadDesktopMasterKey(d, fakeSafe());
    expect(a.storage).toBe("encrypted");
    expect(existsSync(join(d, "master.key"))).toBe(false);
    expect(readFileSync(join(d, "master.key.enc")).includes(a.key.toString("base64"))).toBe(false);
    expect(loadDesktopMasterKey(d, fakeSafe()).key.equals(a.key)).toBe(true);
  });
  test("本机 Web 的明文 master.key 迁移为加密并删除明文", () => {
    const d = tmp();
    const key = Buffer.alloc(32, 7);
    writeFileSync(join(d, "master.key"), key);
    const r = loadDesktopMasterKey(d, fakeSafe());
    expect(r.migrated).toBe(true);
    expect(r.key.equals(key)).toBe(true);
    expect(existsSync(join(d, "master.key"))).toBe(false);
  });
  test("系统密钥存储不可用时回退为文件权限保护并如实报告", () => {
    const d = tmp();
    const r = loadDesktopMasterKey(d, fakeSafe(false));
    expect(r.storage).toBe("plain");
    expect(readFileSync(join(d, "master.key")).equals(r.key)).toBe(true);
  });
});
