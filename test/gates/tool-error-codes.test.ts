// 06 §9 错误码词表门禁：工具相关源码里出现的错误码字面量只能是词表码，
// 或 TOOL_ERROR_CODE_ALIASES 已登记的模块内部别名。运行时兜底会把未知码静默降为 INTERNAL，
// 这条静态检查让新增未登记码在 CI 暴露，而不是悄悄丢失语义。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

interface UnknownCode {
  code: string;
  literalStart: number;
  property: boolean;
}

function unknownCodeLiterals(source: string): UnknownCode[] {
  const allowed = new Set<string>([...TOOL_ERROR_CODES, ...Object.keys(TOOL_ERROR_CODE_ALIASES)]);
  return [...source.matchAll(CODE_LITERAL)]
    .filter((match) => !allowed.has(match[1] as string))
    .map((match) => ({
      code: match[1] as string,
      literalStart: match.index + match[0].indexOf('"'),
      property: match[0].startsWith("code:"),
    }));
}

function unregisteredCodes(source: string, findings: ReadonlySet<number> = new Set()): string[] {
  return unknownCodeLiterals(source)
    .filter((match) => !match.property || !findings.has(match.literalStart))
    .map((match) => match.code);
}

/** 只证明两个真实接口的直接诊断载荷，不按文件或业务 code 豁免。 */
function findingLiteralPositions(
  candidates: readonly { file: string; source: string }[],
): Map<string, Set<number>> {
  const proven = new Map<string, Set<number>>();
  if (!candidates.length) return proven;
  try {
    const config = ts.readConfigFile(join(repoRoot, "tsconfig.base.json"), ts.sys.readFile);
    if (config.error) return proven;
    const declarations = [
      ["packages/protocol/src/source-checks.ts", "SourceCheckFinding"],
      ["packages/modules/workbook/src/source-alignment.ts", "Failure"],
    ] as const;
    const roots = [...new Set([
      ...candidates.map(({ file }) => file),
      ...declarations.map(([file]) => join(repoRoot, file)),
    ])];
    const parsed = ts.parseJsonConfigFileContent(
      { ...config.config, files: roots, include: [] },
      ts.sys,
      repoRoot,
    );
    if (parsed.errors.length) return proven;
    // 原生只读 Program；不定制 CompilerHost、不 emit、不改解析或执行语义。
    const program = ts.createProgram(roots, { ...parsed.options, noEmit: true });
    const checker = program.getTypeChecker();
    const trusted = new Set<ts.Symbol>();
    for (const [file, name] of declarations) {
      const source = program.getSourceFile(join(repoRoot, file));
      const declaration = source?.statements.find(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      const symbol = declaration && checker.getSymbolAtLocation(declaration.name);
      if (!symbol || symbol.declarations?.length !== 1 || symbol.declarations[0] !== declaration)
        return proven;
      trusted.add(symbol);
    }
    for (const candidate of candidates) {
      const source = program.getSourceFile(candidate.file);
      if (!source || source.text !== candidate.source) continue;
      const positions = new Set<number>();
      const wanted = new Set(
        unknownCodeLiterals(candidate.source)
          .filter((match) => match.property)
          .map((match) => match.literalStart),
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && wanted.has(node.getStart(source))) {
          const property = node.parent;
          if (
            ts.isPropertyAssignment(property) &&
            property.initializer === node &&
            ts.isIdentifier(property.name) &&
            property.name.text === "code" &&
            ts.isObjectLiteralExpression(property.parent)
          ) {
            const object = property.parent;
            let assertedOrError = false;
            for (let parent: ts.Node | undefined = object.parent; parent; parent = parent.parent) {
              if (
                ts.isAsExpression(parent) ||
                ts.isTypeAssertionExpression(parent) ||
                (ts.isPropertyAssignment(parent) &&
                  ((ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
                    parent.name.text === "error"))
              ) {
                assertedOrError = true;
                break;
              }
            }
            const type = checker.getContextualType(object);
            if (
              !assertedOrError &&
              type &&
              type.flags === ts.TypeFlags.Object &&
              !type.aliasSymbol &&
              trusted.has(type.getSymbol()!)
            ) positions.add(node.getStart(source));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      proven.set(candidate.file, positions);
    }
  } catch {
    // 无法证明上下文身份时，保留全部违规，不把编译上下文故障当豁免。
    return new Map();
  }
  return proven;
}

describe("工具错误码词表", () => {
  test("工具源码中的错误码字面量都已登记", () => {
    const files = [
      ...SCAN_ROOTS.flatMap((d) => listTs(join(repoRoot, d))),
      ...SCAN_FILES.map((f) => join(repoRoot, f)),
    ];
    const candidates = files
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => unknownCodeLiterals(source).length > 0);
    const findings = findingLiteralPositions(candidates);
    const violations: string[] = [];
    for (const { file, source } of candidates) {
      for (const code of unregisteredCodes(source, findings.get(file))) {
        violations.push(`${file.slice(repoRoot.length)}: ${code}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("仅真实诊断接口的直接上下文可豁免，错误载荷及伪造类型仍被检出", () => {
    const dir = mkdtempSync(join(tmpdir(), "xman-error-code-types-"));
    const file = join(dir, "contexts.ts");
    const source = [
      `import type { SourceCheckFinding as RealFinding } from ${JSON.stringify(join(repoRoot, "packages/protocol/src/source-checks.ts"))};`,
      `import type { ToolResult } from ${JSON.stringify(join(repoRoot, "packages/protocol/src/records.ts"))};`,
      `import { verifySourceAlignment } from ${JSON.stringify(join(repoRoot, "packages/modules/workbook/src/source-alignment.ts"))};`,
      'declare function add(finding: RealFinding): void;',
      'add({ code: "FINDING_CODE", message: "" });',
      'type SameFinding = RealFinding;',
      'const same: SameFinding = { code: "SAME_TYPE_CODE", message: "" };',
      'declare const alignment: ReturnType<typeof verifySourceAlignment>;',
      'alignment.failures.push({ targetCell: "A1", ruleIndex: 0, code: "ALIGNMENT_CODE" });',
      'const result: ToolResult = { status: "error", error: { code: "RESULT_ERROR_CODE", message: "", retryable: false } };',
      'declare function err(code: string): void;',
      'declare function fail(code: string): void;',
      'err("ERR_CALL_CODE"); fail("FAIL_CALL_CODE"); new Error("NEW_ERROR_CODE");',
      'interface SourceCheckFinding { code: string; message: string }',
      'const fake: SourceCheckFinding = { code: "FAKE_TYPE_CODE", message: "" };',
      'type StructuralAlias = { code: string; message: string };',
      'const alias: StructuralAlias = { code: "ALIAS_TYPE_CODE", message: "" };',
      'declare function union(value: RealFinding | { code: string; extra?: number }): void;',
      'union({ code: "UNION_TYPE_CODE", message: "" });',
      'declare function intersection(value: RealFinding & { extra?: number }): void;',
      'intersection({ code: "INTERSECTION_TYPE_CODE", message: "" });',
      'add({ code: "CAST_TYPE_CODE", message: "" } as RealFinding);',
      'add(<RealFinding>{ code: "ANGLE_CAST_CODE", message: "" });',
      'add({ code: "FINDING_OUTER", message: "", actual: { error: { code: "NESTED_ERROR_CODE" } } });',
      'const nested: { error: RealFinding } = { error: { code: "TYPED_ERROR_CODE", message: "" } };',
      'const untyped = { code: "NO_CONTEXT_CODE" };',
      'declare function unknown(value: unknown): void;',
      'unknown({ code: "UNKNOWN_CONTEXT_CODE" });',
      'type LiteralUnion = "ok" | "UNION_LITERAL_CODE";',
    ].join("\n");
    try {
      writeFileSync(file, source);
      const absent = join(dir, "missing.ts");
      const mismatched = join(dir, "mismatched.ts");
      writeFileSync(mismatched, source);
      const findings = findingLiteralPositions([
        { file, source },
        { file: absent, source },
        { file: mismatched, source: `${source}\n` },
      ]);
      expect(unregisteredCodes(source, findings.get(file))).toEqual([
        "RESULT_ERROR_CODE", "ERR_CALL_CODE", "FAIL_CALL_CODE", "NEW_ERROR_CODE",
        "FAKE_TYPE_CODE", "ALIAS_TYPE_CODE", "UNION_TYPE_CODE", "INTERSECTION_TYPE_CODE",
        "CAST_TYPE_CODE", "ANGLE_CAST_CODE", "NESTED_ERROR_CODE", "TYPED_ERROR_CODE",
        "NO_CONTEXT_CODE", "UNKNOWN_CONTEXT_CODE", "UNION_LITERAL_CODE",
      ]);
      // 文件不存在或程序里的实际字节不匹配时，不得借其它文件的类型证明豁免。
      expect(findings.get(absent)).toBeUndefined();
      expect(findings.get(mismatched)).toBeUndefined();
      expect(unregisteredCodes(source)).toContain("FINDING_CODE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("反例：未登记码会被检出；别名映射到词表码", () => {
    expect(unregisteredCodes('return err("READ_FAILED", msg);')).toEqual(["READ_FAILED"]);
    expect(unregisteredCodes('error: { code: "BOGUS_CODE", message: "" }')).toEqual(["BOGUS_CODE"]);
    expect(unregisteredCodes('err("DOC_NOT_FOUND", m); err("NOT_FOUND", m)')).toEqual([]);
    expect(toToolErrorCode("DOC_NOT_FOUND")).toBe("NOT_FOUND");
    expect(toToolErrorCode("BAD_OPERATION")).toBe("INVALID_ARGUMENT");
    expect(toToolErrorCode("READ_FAILED")).toBe("INTERNAL");
    // 真实图片失败不能套用 finding 豁免；登记别名后仍归入既有 INTERNAL。
    expect(TOOL_ERROR_CODE_ALIASES.INVALID_IMAGE).toBe("INTERNAL");
    expect(toToolErrorCode("INVALID_IMAGE")).toBe("INTERNAL");
  });
});
