// 许可证门禁的反例测试：向 evaluateLicenses 投喂合成的
// `pnpm licenses list --json` 报告，验证白名单与黑名单行为。

import { describe, expect, test } from "vitest";

import { evaluateLicenses, licenseCommand } from "../../scripts/check-licenses.ts";

const grouped = (license: string, names: string[]) => ({
  [license]: names.map((name) => ({ name, license })),
});

describe("许可证白名单", () => {
  test("宽松许可证全部放行", () => {
    const report = {
      MIT: [{ name: "a", license: "MIT" }],
      "Apache-2.0": [{ name: "b", license: "Apache-2.0" }],
      "BSD-2-Clause": [{ name: "c", license: "BSD-2-Clause" }],
      "BSD-3-Clause": [{ name: "d", license: "BSD-3-Clause" }],
      ISC: [{ name: "e", license: "ISC" }],
      "0BSD": [{ name: "f", license: "0BSD" }],
      "BlueOak-1.0.0": [{ name: "g", license: "BlueOak-1.0.0" }],
      "CC0-1.0": [{ name: "h", license: "CC0-1.0" }],
      Unlicense: [{ name: "i", license: "Unlicense" }],
    };
    expect(evaluateLicenses(report)).toEqual([]);
  });

  test("拒绝 GPL 包并打印包名与许可证", () => {
    const violations = evaluateLicenses(grouped("GPL-3.0-only", ["some-copyleft-lib"]));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("some-copyleft-lib");
    expect(violations[0]).toContain("GPL-3.0-only");
  });

  test("拒绝 MPL-2.0（不在白名单）与缺失许可证", () => {
    const violations = evaluateLicenses({
      "MPL-2.0": [{ name: "mpl-lib", license: "MPL-2.0" }],
      "SEE LICENSE IN LICENSE": [{ name: "mystery-lib" }],
    });
    expect(violations).toHaveLength(2);
    expect(violations.join("\n")).toContain("mpl-lib");
    expect(violations.join("\n")).toContain("mystery-lib");
  });

  test("SPDX 表达式：OR 任一白名单分支放行，AND 必须全部白名单", () => {
    expect(evaluateLicenses(grouped("(MIT OR GPL-3.0-only)", ["dual-licensed"]))).toEqual([]);
    expect(evaluateLicenses(grouped("(Apache-2.0 AND MIT)", ["and-ok"]))).toEqual([]);
    expect(evaluateLicenses(grouped("(MIT AND GPL-3.0-only)", ["and-bad"]))).toHaveLength(1);
  });

  test("DOMPurify 双许可选择 Apache-2.0；MPL 单许可和 AND 仍拒绝", () => {
    expect(evaluateLicenses(grouped("(MPL-2.0 OR Apache-2.0)", ["dompurify"]))).toEqual([]);
    expect(evaluateLicenses(grouped("MPL-2.0", ["lightningcss"]))).toHaveLength(1);
    expect(evaluateLicenses(grouped("(MPL-2.0 AND Apache-2.0)", ["and-mpl"]))).toHaveLength(1);
  });

  test("别名与 Zlib：MIT/X11 视同 MIT；(MIT AND Zlib) 放行；X11 单独仍失败", () => {
    expect(evaluateLicenses(grouped("MIT/X11", ["legacy-x11-lib"]))).toEqual([]);
    expect(evaluateLicenses(grouped("(MIT AND Zlib)", ["pako-like"]))).toEqual([]);
    const violations = evaluateLicenses(grouped("X11", ["x11-only-lib"]));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("x11-only-lib");
  });
});

describe("版本精确例外", () => {
  test("buffers@0.1.1 无许可证放行；buffers@0.1.2 与其他缺证包仍失败", () => {
    // pnpm 对无声明包报 license:"Unknown" 或完全缺字段，两种形态都覆盖
    expect(
      evaluateLicenses({
        Unknown: [{ name: "buffers", license: "Unknown", versions: ["0.1.1"] }],
      }),
    ).toEqual([]);
    expect(evaluateLicenses({ "": [{ name: "buffers", versions: ["0.1.1"] }] })).toEqual([]);
    const badVersion = evaluateLicenses({
      Unknown: [{ name: "buffers", license: "Unknown", versions: ["0.1.2"] }],
    });
    expect(badVersion).toHaveLength(1);
    expect(badVersion[0]).toContain("buffers");
    expect(evaluateLicenses({ "": [{ name: "no-license-lib" }] })).toHaveLength(1);
  });

  test("例外不豁免硬性黑名单", () => {
    const violations = evaluateLicenses(
      { MIT: [{ name: "hyperformula", license: "MIT", versions: ["1.0.0"] }] },
      new Map([["hyperformula@1.0.0", "x"]]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("hyperformula");
  });
});

describe("构建期许可例外（lightningcss）", () => {
  const mpl = (name: string, versions: string[], license = "MPL-2.0") => ({
    [license]: [{ name, license, versions }],
  });

  test("lightningcss@1.32.0 与平台包放行", () => {
    expect(evaluateLicenses(mpl("lightningcss", ["1.32.0"]))).toEqual([]);
    expect(evaluateLicenses(mpl("lightningcss-darwin-arm64", ["1.32.0"]))).toEqual([]);
    expect(evaluateLicenses(mpl("lightningcss-linux-x64-gnu", ["1.32.0"]))).toEqual([]);
  });

  test("版本不精确匹配或部分版本未覆盖仍失败", () => {
    expect(evaluateLicenses(mpl("lightningcss", ["1.31.0"]))).toHaveLength(1);
    expect(evaluateLicenses(mpl("lightningcss", ["1.32.0", "1.33.0"]))).toHaveLength(1);
  });

  test("许可字符串不一致仍失败", () => {
    expect(evaluateLicenses(mpl("lightningcss", ["1.32.0"], "GPL-3.0-only"))).toHaveLength(1);
  });

  test("未列入的 MPL 包仍失败", () => {
    expect(evaluateLicenses(mpl("mpl-lib", ["1.0.0"]))).toHaveLength(1);
  });

  test("构建期清单不豁免硬性黑名单", () => {
    const violations = evaluateLicenses(
      { MIT: [{ name: "hyperformula", license: "MIT", versions: ["1.0.0"] }] },
      new Map(),
      new Map([["hyperformula@1.0.0", { license: "MIT", reason: "x" }]]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("hyperformula");
  });

  test("例外包出现在生产依赖中失败；不出现则不新增违规", () => {
    const full = mpl("lightningcss", ["1.32.0"]);
    const withProd = evaluateLicenses(full, undefined, undefined, full);
    expect(withProd).toHaveLength(1);
    expect(withProd[0]).toContain("生产依赖");
    const clean = evaluateLicenses(full, undefined, undefined, {
      MIT: [{ name: "react", license: "MIT", versions: ["19.3.0"] }],
    });
    expect(clean).toEqual([]);
  });
});

describe("硬性黑名单", () => {
  test("@univerjs-pro/* 即使声明宽松许可证也拒绝", () => {
    const violations = evaluateLicenses(grouped("MIT", ["@univerjs-pro/sheets"]));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@univerjs-pro/sheets");
  });

  test("hyperformula 出现即失败", () => {
    const violations = evaluateLicenses(grouped("Apache-2.0", ["hyperformula"]));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("hyperformula");
  });
});

describe("报告形态兼容", () => {
  test("兼容数组形态报告", () => {
    const violations = evaluateLicenses([
      { name: "ok", license: "MIT" },
      { name: "bad", license: "GPL-2.0" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("bad");
  });
});

test("license scan reuses the invoking pnpm, not an older executable on PATH", () => {
  expect(licenseCommand("/tools/pnpm/bin/pnpm.cjs", false)).toEqual({
    command: process.execPath,
    args: ["/tools/pnpm/bin/pnpm.cjs", "licenses", "list", "--json"],
  });
  expect(licenseCommand(undefined, true)).toEqual({
    command: "pnpm",
    args: ["licenses", "list", "--json", "--prod"],
  });
  expect(licenseCommand("/tools/npm/bin/npm-cli.js", false).command).toBe("pnpm");
});
