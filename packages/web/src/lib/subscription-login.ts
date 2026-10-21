/** localhost 回调只有浏览器与服务在同一台机器时可用。 */
export function preferredLoginMethod(hostname: string, desktop: boolean): "browser" | "device" {
  return desktop || ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)
    ? "browser"
    : "device";
}

export function loginFailure(message: string, method: "browser" | "device"): string {
  if (/HTTP 502|fetch failed|Failed to fetch|NetworkError/i.test(message))
    return method === "browser"
      ? "浏览器授权服务连接失败（502 或网络异常）。请确认服务器的 1455 端口可用；远程访问建议改用设备码，localhost 回调不会自动返回服务器。"
      : "获取或查询设备码失败（502 或网络异常）。请稍后重试，并确认服务器能访问 auth.openai.com。";
  return message;
}

const PENDING_LOGIN = "excelmanus.subscription-login";
type LoginStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PendingLogin = { attemptId: string; method: "browser" | "device"; createdAt: number };
export function loginStorage(): LoginStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function savePendingLogin(
  storage: LoginStorage | undefined,
  attempt: Pick<PendingLogin, "attemptId" | "method">,
  now = Date.now(),
) {
  try {
    storage?.setItem(
      PENDING_LOGIN,
      JSON.stringify({ attemptId: attempt.attemptId, method: attempt.method, createdAt: now }),
    );
  } catch {
    /* 私密模式仍可在当前面板完成 */
  }
}
export function clearPendingLogin(storage: LoginStorage | undefined) {
  try {
    storage?.removeItem(PENDING_LOGIN);
  } catch {
    /* 存储不可用 */
  }
}
export function readPendingLogin(
  storage: LoginStorage | undefined,
  now = Date.now(),
): PendingLogin | null {
  try {
    const saved = JSON.parse(storage?.getItem(PENDING_LOGIN) ?? "null") as PendingLogin | null;
    if (
      saved &&
      typeof saved.attemptId === "string" &&
      ["browser", "device"].includes(saved.method) &&
      Number.isFinite(saved.createdAt) &&
      now - saved.createdAt >= 0 &&
      now - saved.createdAt < 15 * 60_000
    )
      return saved;
  } catch {
    /* 损坏的记录不恢复 */
  }
  clearPendingLogin(storage);
  return null;
}
