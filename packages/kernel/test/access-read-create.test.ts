import { expect, test } from "vitest";
import { accessScopeAllows, deriveUserAccessScope } from "../src/access-scope.ts";

const prompt = (source = "qa-source.xlsx", output = "qa-output.xlsx") =>
  `只读取本题 ${source}，并新建 ${output}，不修改源文件，不访问其他文件。保存后核验并报告。`;

test("explicit read-source/create-output task derives only the named pair", () => {
  const scope = deriveUserAccessScope(prompt());
  expect(scope).toEqual({
    kind: "files",
    readPaths: ["qa-source.xlsx", "qa-output.xlsx"],
    writePaths: ["qa-output.xlsx"],
  });
  expect(accessScopeAllows(scope, "qa-source.xlsx", "write")).toBe(false);
  expect(accessScopeAllows(scope, "qa-output.xlsx", "read")).toBe(true);
  expect(accessScopeAllows(scope, "qa-output.xlsx", "write")).toBe(true);
  expect(accessScopeAllows(scope, ".", "enumerate")).toBe(false);
  expect(accessScopeAllows(scope, "other.xlsx", "read")).toBe(false);
});

test("read/create clause never widens malformed, quoted, or conflicting limits", () => {
  for (const text of [
    prompt("../source.xlsx"),
    prompt("source.xlsx", "./source.xlsx"),
    prompt("a*.xlsx"),
    prompt("a.xlsx或b.xlsx"),
    prompt("a.xlsx和b.xlsx"),
    prompt("folder with space/source.xlsx"),
    `引用：“${prompt()}”请解释。`,
    `\`\`\`\n${prompt()}\n\`\`\``,
    `${prompt()}另读取 third.xlsx。`,
    `${prompt()}另存为 third.xlsx。`,
    `${prompt()}并新建 third.xlsx。`,
    `${prompt()}仅访问目录 outside。`,
    "只读取本题 source.xlsx，并新建 output.xlsx，不访问其他文件。再修改源文件。",
  ])
    expect(deriveUserAccessScope(text).kind, text).toBe("unresolved");
});

test("read/create preserves relative Chinese paths and refuses contradictory output prohibitions", () => {
  expect(deriveUserAccessScope(prompt("订单/源表.xlsx", "订单/结果.xlsx"))).toEqual({
    kind: "files",
    readPaths: ["订单/源表.xlsx", "订单/结果.xlsx"],
    writePaths: ["订单/结果.xlsx"],
  });
  for (const suffix of [
    "禁止修改输出文件。",
    "不得写入 qa-output.xlsx。",
    "不要创建目标文件。",
    "不允许保存结果文件。",
    "禁止任何写操作。",
    "禁止读取 qa-output.xlsx。",
  ])
    expect(deriveUserAccessScope(prompt() + suffix).kind, suffix).toBe("unresolved");
});

test("original explicit save-as pair remains supported", () => {
  expect(
    deriveUserAccessScope(
      "请将 source.xlsx 另存为 output.xlsx，只处理这两个文件，不修改原件或访问其他文件。",
    ),
  ).toEqual({
    kind: "files",
    readPaths: ["source.xlsx", "output.xlsx"],
    writePaths: ["output.xlsx"],
  });
});

test("finite read/create synonyms preserve the same read-only source and writable output", () => {
  for (const create of ["新建", "并新建"]) {
    for (const preserve of ["不改", "不修改"]) {
      for (const separator of ["，", ",", "、"]) {
        const text = `只读取本题 qa-source.xlsx${separator}${create} qa-output.xlsx${separator}${preserve}源文件${separator}不访问其他文件。`;
        const scope = deriveUserAccessScope(text);
        expect(scope, text).toEqual({
          kind: "files",
          readPaths: ["qa-source.xlsx", "qa-output.xlsx"],
          writePaths: ["qa-output.xlsx"],
        });
        expect(accessScopeAllows(scope, "qa-source.xlsx", "write")).toBe(false);
        expect(accessScopeAllows(scope, "qa-output.xlsx", "read")).toBe(true);
        expect(accessScopeAllows(scope, "qa-output.xlsx", "write")).toBe(true);
        expect(accessScopeAllows(scope, ".", "enumerate")).toBe(false);
        expect(accessScopeAllows(scope, "third.xlsx", "read")).toBe(false);
      }
    }
  }
  expect(
    deriveUserAccessScope(
      "只读取本题 source.xlsx，新建 output.xlsx，不改源文件、不访问其他文件。",
    ),
  ).toEqual({
    kind: "files",
    readPaths: ["source.xlsx", "output.xlsx"],
    writePaths: ["output.xlsx"],
  });
});

test("read/create synonyms still reject ambiguous paths and additional relations or limits", () => {
  const prefix = "只读取本题 source.xlsx，新建 output.xlsx，不改源文件、不访问其他文件。";
  for (const text of [
    prefix + "新建 third.xlsx。",
    prefix + "新建 output.xlsx。",
    prefix + "并新建 third.xlsx。",
    prefix + "禁止修改输出文件。",
    prefix + "不得写入 output.xlsx。",
    prefix + "仅访问目录 outside。",
    prefix.replace("source.xlsx", "source.xlsx、other.xlsx"),
    prefix.replace("output.xlsx", "output.xlsx、other.xlsx"),
    prefix.replace("source.xlsx", "../source.xlsx"),
    prefix.replace("output.xlsx", "source.xlsx"),
    `引用：“${prefix}”请解释。`,
  ]) {
    expect(deriveUserAccessScope(text).kind, text).toBe("unresolved");
  }
});

test("new worksheet and chart instructions remain business operations, not extra files", () => {
  for (const tail of [
    "在输出文件中新建工作表‘汇总’。",
    "新建一个名为账龄汇总的工作表。",
    "在 qa-output.xlsx 中新建图表。",
    "新建工作表后保存文件。",
    "新建工作表，保存到 qa-output.xlsx。",
  ]) {
    expect(deriveUserAccessScope(prompt() + tail).kind, tail).toBe("files");
  }
  for (const tail of [
    "新建 qa-output.xlsx。",
    "新建 another.xlsx。",
    "新建另一个文件。",
    "新建一个工作簿。",
    "新建新的文件。",
  ]) {
    expect(deriveUserAccessScope(prompt() + tail).kind, tail).toBe("unresolved");
  }
});
