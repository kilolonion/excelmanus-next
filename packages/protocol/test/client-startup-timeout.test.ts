import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/client.ts";

afterEach(() => vi.useRealTimers());

describe("opt-in startup deadlines", () => {
  it("aborts a stalled fetch at its deadline without retrying", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const pending = createApiClient("http://local", null, fetcher).bootstrap({ timeoutMs: 20 });
    const result = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(true);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active during auth response body consumption", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    });
    const pending = createApiClient("http://local", null, fetcher).createBrowserSession({
      timeoutMs: 20,
    });
    const result = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(true);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes navigation cancellation and removes the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const pending = createApiClient("http://local", null, fetcher).getSession("one", {
      signal: controller.signal,
      timeoutMs: 20,
    });
    const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch an already canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createApiClient("http://local", null, fetcher).bootstrap({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves HTTP auth status and cleans up completed request timers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
    await expect(
      createApiClient("http://local", null, fetcher).createBrowserSession({ timeoutMs: 20 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary writes without automatic deadlines or retries", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    await createApiClient("http://local", null, fetcher).deleteSession("one");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("aborts the actual HTTP body stream instead of only timing out the caller", async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let headersSent!: () => void;
  const headers = new Promise<void>((resolve) => {
    headersSent = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"protocolVersion":');
    response.on("close", closed);
    headersSent();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  try {
    const result = expect(
      createApiClient(`http://127.0.0.1:${address.port}`).bootstrap({ timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await headers;
    await result;
    await disconnected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("passes cancellation through every startup read without putting options in the query", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn<typeof fetch>();
  const api = createApiClient("http://local", null, fetcher);
  const options = { signal: controller.signal, timeoutMs: 20 };
  const reads = [
    api.health(options),
    api.listSessions({ limit: 200 }, options),
    api.getSessionLog("one", { limit: 100 }, options),
    api.getSessionHistoryWindow("one", options),
    api.listWorkspaces(options),
    api.listProviders(options),
    api.listProviderConnections(options),
    api.listModelProfiles(options),
    api.getSettings(options),
  ];
  for (const read of reads) await expect(read).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
