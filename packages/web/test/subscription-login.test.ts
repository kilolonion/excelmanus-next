import { expect, test } from "vitest";
import {
  clearPendingLogin,
  loginFailure,
  preferredLoginMethod,
  readPendingLogin,
  savePendingLogin,
} from "../src/lib/subscription-login";

test("公网订阅连接使用设备码，本机保留浏览器回调", () => {
  expect(preferredLoginMethod("next.excelmanus.com", false)).toBe("device");
  expect(preferredLoginMethod("192.168.1.5", false)).toBe("device");
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(preferredLoginMethod(host, false)).toBe("browser");
  expect(preferredLoginMethod("app", true)).toBe("browser");
});

test("授权错误保留具体原因，网关错误给出可操作说明", () => {
  expect(loginFailure("HTTP 502", "browser")).toContain("localhost");
  expect(loginFailure("HTTP 502", "device")).toContain("auth.openai.com");
  expect(loginFailure("本机端口 1455 被占用", "browser")).toBe("本机端口 1455 被占用");
});

test("登录编号可在刷新后恢复，过期或取消清除，不保存凭据", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  savePendingLogin(storage, { attemptId: "login_test", method: "device" }, 1000);
  expect(readPendingLogin(storage, 2000)).toEqual({
    attemptId: "login_test",
    method: "device",
    createdAt: 1000,
  });
  expect(readPendingLogin(storage, 1000 + 15 * 60_000)).toBeNull();
  savePendingLogin(storage, { attemptId: "login_next", method: "browser" }, 2000);
  clearPendingLogin(storage);
  expect(readPendingLogin(storage, 2001)).toBeNull();
});
