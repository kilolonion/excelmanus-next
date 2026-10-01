// 界面约定静态检查（ADR 0011）：交互控件只出自 components/ui/，图标只经 Icon.tsx，组件中不写中文文案。

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

const files = walk(SRC).map((path) => ({
  rel: relative(SRC, path).replaceAll("\\", "/"),
  // 去掉注释，避免说明文字被误判
  code: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1"),
}));
const outsideUi = files.filter((f) => !f.rel.startsWith("components/ui/"));

describe("界面约定", () => {
  test("components/ui 以外不使用原生选择类控件与浏览器对话框", () => {
    const banned = [
      /<select[\s>]/,
      /<details[\s>]/,
      /<summary[\s>]/,
      /<datalist[\s>]/,
      /type="(checkbox|radio|range)"/,
      /window\.(confirm|alert|prompt)\(/,
    ];
    const hits = outsideUi.flatMap((f) =>
      banned.filter((re) => re.test(f.code)).map((re) => `${f.rel}: ${re}`),
    );
    expect(hits).toEqual([]);
  });

  test("小写原生元素上不使用 title 悬停提示", () => {
    const re = /<([a-z][a-z0-9]*)\b[^>]*\stitle=/g;
    const hits = outsideUi.flatMap((f) =>
      [...f.code.matchAll(re)].map((m) => `${f.rel}: <${m[1]}`),
    );
    expect(hits).toEqual([]);
  });

  test("lucide-react 只在 Icon.tsx 中引入", () => {
    const hits = files
      .filter((f) => f.rel !== "components/Icon.tsx" && /from "lucide-react"/.test(f.code))
      .map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  test("components 下不写中文文案（集中在 strings.ts）", () => {
    const hits = files
      .filter((f) => f.rel.startsWith("components/") && /[\u4e00-\u9fff]/.test(f.code))
      .map((f) => f.rel);
    expect(hits).toEqual([]);
  });
});
