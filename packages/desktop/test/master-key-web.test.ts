// P1-47：桌面版迁移主密钥后，本机 Web 形态在同一目录不得静默生成新主密钥。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { loadMasterKey } from "../../server/src/crypto.ts";
import { loadDesktopMasterKey } from "../src/master-key.ts";

const dir = mkdtempSync(join(tmpdir(), "excelmanus-fix-models-ext-desktop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("Web → 桌面迁移后再用 Web 打开：拒绝启动而不是换密钥", () => {
  const web = loadMasterKey(dir);
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  };
  const desk = loadDesktopMasterKey(dir, safe);
  expect(desk.migrated).toBe(true);
  expect(desk.key.equals(web)).toBe(true);
  expect(() => loadMasterKey(dir)).toThrow(/master\.key\.enc/);
  // 桌面再次打开仍是同一把密钥
  expect(loadDesktopMasterKey(dir, safe).key.equals(web)).toBe(true);
});
