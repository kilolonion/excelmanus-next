// 06 §9 错误码词表门禁：工具相关源码里出现的错误码字面量只能是词表码，
// 或 TOOL_ERROR_CODE_ALIASES 已登记的模块内部别名。运行时兜底会把未知码静默降为 INTERNAL，
// 这条静态检查让新增未登记码在 CI 暴露，而不是悄悄丢失语义。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  TOOL_ERROR_CODE_ALIASES,
  TOOL_ERROR_CODES,
  toToolErrorCode,
} from "../../packages/protocol/src/records.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 产出 ToolResult 的源码（服务端 REST 错误码另有词表，不在此列）。 */
const SCAN_ROOTS = ["packages/kernel/src", "packages/modules", "packages/sandbox/src"];
const SCAN_FILES = ["packages/server/src/script.ts", "packages/server/src/interactions.ts"];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// err("X" / fail("X" / new XxxError("X" / code: "X"
const CODE_LITERAL =
  /(?:\b(?:err|fail)\(\s*|\bnew [A-Za-z]*Error\(\s*|\bcode:\s*|\| )"([A-Z][A-Z_]{3,})"/g;

function unregisteredCodes(source: string): string[] {
  const allowed = new Set<string>([...TOOL_ERROR_CODES, ...Object.keys(TOOL_ERROR_CODE_ALIASES)]);
  const bad: string[] = [];
  for (const m of source.matchAll(CODE_LITERAL)) {
    const code = m[1] as string;
    if (!allowed.has(code)) bad.push(code);
  }
  return bad;
}

describe("工具错误码词表", () => {
  test("工具源码中的错误码字面量都已登记", () => {
    const files = [
      ...SCAN_ROOTS.flatMap((d) => listTs(join(repoRoot, d))),
      ...SCAN_FILES.map((f) => join(repoRoot, f)),
    ];
    const violations: string[] = [];
    for (const f of files) {
      for (const code of unregisteredCodes(readFileSync(f, "utf8"))) {
        violations.push(`${f.slice(repoRoot.length)}: ${code}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("反例：未登记码会被检出；别名映射到词表码", () => {
    expect(unregisteredCodes('return err("READ_FAILED", msg);')).toEqual(["READ_FAILED"]);
    expect(unregisteredCodes('error: { code: "BOGUS_CODE", message: "" }')).toEqual(["BOGUS_CODE"]);
    expect(unregisteredCodes('err("DOC_NOT_FOUND", m); err("NOT_FOUND", m)')).toEqual([]);
    expect(toToolErrorCode("DOC_NOT_FOUND")).toBe("NOT_FOUND");
    expect(toToolErrorCode("BAD_OPERATION")).toBe("INVALID_ARGUMENT");
    expect(toToolErrorCode("READ_FAILED")).toBe("INTERNAL");
  });
});
