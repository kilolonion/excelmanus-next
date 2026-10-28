import type { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { AccountService } from "../src/accounts.ts";

test("设备码轮询遵守发行方间隔，同一尝试不并发交换令牌", async () => {
  let release!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ device_auth_id: "id", user_code: "test", interval: "5" }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
  const svc = new AccountService({
    db: {} as DatabaseSync,
    masterKey: Buffer.alloc(32),
    fetchImpl: fetcher,
    onLoggedIn: () => [],
  });
  const a = await svc.start("device");
  const p = svc.poll(a.attemptId);
  const q = svc.poll(a.attemptId);
  expect(fetcher).toHaveBeenCalledTimes(2);
  release(new Response("", { status: 403 }));
  await Promise.all([p, q]);
  await svc.poll(a.attemptId);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
