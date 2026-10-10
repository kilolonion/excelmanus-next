import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("深层 JSON 失败后释放 QuickJS 引用且下一脚本正常执行", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/cleanup-child.ts", import.meta.url))],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("Assertion failed");
  expect(JSON.parse(result.stdout).next).toMatchObject({ kind: "ok", value: 42 });
}, 25000);
