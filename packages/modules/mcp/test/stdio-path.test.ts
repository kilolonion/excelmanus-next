// stdio MCP 的 PATH 合成（P1-46，12 §4.1）：GUI 进程的最小 PATH 补上常见用户级命令目录。
import { describe, expect, test } from "vitest";
import { stdioPath } from "../src/index.ts";

describe("stdioPath", () => {
  test("macOS Finder 启动的最小 PATH 补上 Homebrew 与用户目录，保持原顺序在前、不重复", () => {
    const p = stdioPath("/usr/bin:/bin:/usr/sbin:/sbin", "darwin", "/Users/u").split(":");
    expect(p.slice(0, 4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(p).toContain("/opt/homebrew/bin");
    expect(p).toContain("/usr/local/bin");
    expect(p).toContain("/Users/u/.local/bin");
    expect(new Set(p).size).toBe(p.length);
  });

  test("Windows 原样保留", () => {
    expect(stdioPath("C:\\Windows;C:\\node", "win32", "C:\\Users\\u")).toBe("C:\\Windows;C:\\node");
  });

  test("PATH 缺失时仍给出可用目录", () => {
    expect(stdioPath(undefined, "linux", undefined).split(":")).toContain("/usr/bin");
  });
});
