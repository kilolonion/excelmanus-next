// 登录 shell PATH 解析（P1-46）：rc 文件输出噪声、超时与 Windows 均不影响启动。
import { describe, expect, test } from "vitest";
import { loginShellPath, mergePath, parseShellPath, resolvedPath } from "../src/shell-path.ts";

describe("登录 shell PATH", () => {
  test("从带噪声的输出中取出 PATH", () => {
    expect(
      parseShellPath("Welcome!\n__EXCELMANUS_PATH__/opt/homebrew/bin:/usr/bin__EXCELMANUS_PATH__"),
    ).toBe("/opt/homebrew/bin:/usr/bin");
    expect(parseShellPath("no marker")).toBeUndefined();
  });

  test("登录 shell 的 PATH 在前，原 PATH 独有目录追加在后", () => {
    expect(resolvedPath("/usr/bin:/bin:/custom", "/opt/homebrew/bin:/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin:/custom",
    );
    expect(resolvedPath("/usr/bin", undefined)).toBe("/usr/bin");
    expect(mergePath("", "/a:/a:/b")).toBe("/a:/b");
  });

  test("调用登录交互 shell；失败返回 undefined；Windows 不调用", () => {
    const calls: string[][] = [];
    const out = loginShellPath("darwin", "/bin/zsh", (file, args) => {
      calls.push([file, ...args]);
      return "__EXCELMANUS_PATH__/x:/y__EXCELMANUS_PATH__";
    });
    expect(out).toBe("/x:/y");
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"]);
    expect(
      loginShellPath("darwin", "/bin/zsh", () => {
        throw new Error("timeout");
      }),
    ).toBeUndefined();
    expect(
      loginShellPath("win32", undefined, () => {
        throw new Error("不应调用");
      }),
    ).toBeUndefined();
  });

  test("真实登录 shell（本机）能解析出包含 /usr/bin 的 PATH", () => {
    if (process.platform === "win32") return;
    const p = loginShellPath();
    if (p !== undefined) expect(p.split(":")).toContain("/usr/bin");
  });
});
