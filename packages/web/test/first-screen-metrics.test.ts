import { describe, expect, it, vi } from "vitest";
import { classifyResource, createFirstScreenMetrics } from "../src/lib/first-screen-metrics";

describe("bounded first screen QA metrics", () => {
  it("does not touch browser APIs when disabled", () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("browser access");
        },
      },
    );
    expect(createFirstScreenMetrics(false, null, env as never)).toBeNull();
  });
  it("removes URLs, IDs, filenames and excludes external resources", () => {
    expect(
      classifyResource(
        "https://test/api/v1/sessions/private-id/log?token=secret#x",
        "https://test",
      ),
    ).toBe("history");
    expect(classifyResource("https://test/assets/private-file.js?x=secret", "https://test")).toBe(
      "asset",
    );
    expect(classifyResource("https://third.test/file", "https://test")).toBeNull();
    expect(classifyResource("https://test/private-file.xlsx", "https://test")).toBeNull();
  });
  it("rejects stale content callbacks and duplicates", () => {
    const queue: (() => void)[] = [];
    const send = vi.fn();
    const metrics = createFirstScreenMetrics(true, "ses_test", {
      now: () => 100,
      origin: "https://test",
      runId: () => "a",
      observe: () => ({ disconnect() {}, takeRecords: () => [] }),
      entries: () => [],
      raf: (cb) => {
        queue.push(cb);
        return queue.length;
      },
      cancelRaf: () => {},
      timeout: () => 1,
      clearTimeout: () => {},
      send,
    });
    metrics?.correct("ses_other", () => true);
    expect(queue).toHaveLength(0);
    const cancel = metrics?.correct("ses_test", () => false);
    queue.shift()?.();
    expect(send).not.toHaveBeenCalled();
    cancel?.();
    queue.shift()?.();
    metrics?.correct("ses_test", () => true);
    queue.shift()?.();
    metrics?.correct("ses_test", () => true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain("https:");
  });
  it("bounds resources and long tasks, keeps LCP numeric, and disconnects", () => {
    const handlers = new Map<
      string,
      (entries: { entryType: string; name: string; startTime: number; duration: number }[]) => void
    >();
    const send = vi.fn();
    const disconnect = vi.fn();
    const raf: (() => void)[] = [];
    const metrics = createFirstScreenMetrics(true, "ses_test", {
      now: () => 300,
      origin: "https://test",
      runId: () => "a",
      observe: (type, receive) => {
        handlers.set(type, receive);
        return {
          disconnect,
          takeRecords: () =>
            type === "largest-contentful-paint"
              ? [{ entryType: type, name: "private", startTime: 120, duration: 0 }]
              : [],
        };
      },
      entries: () => [],
      raf: (cb) => {
        raf.push(cb);
        return 1;
      },
      cancelRaf: () => {},
      timeout: () => 1,
      clearTimeout: () => {},
      send,
    });
    handlers.get("resource")?.(
      Array.from({ length: 250 }, (_, i) => ({
        entryType: "resource",
        name: "https://test/assets/private.js?secret=x",
        startTime: i,
        duration: 1,
      })),
    );
    handlers.get("longtask")?.(
      Array.from({ length: 80 }, (_, i) => ({
        entryType: "longtask",
        name: "private",
        startTime: i,
        duration: 50,
      })),
    );
    handlers.get("largest-contentful-paint")?.([
      { entryType: "largest-contentful-paint", name: "private", startTime: 90, duration: 0 },
    ]);
    metrics?.mark("boot-start");
    metrics?.mark("boot-start");
    metrics?.correct("ses_test", () => true);
    raf.shift()?.();
    const entries = send.mock.calls[0][0].observations;
    expect(entries.filter((x: { name: string }) => x.name === "resource")).toHaveLength(200);
    expect(entries.filter((x: { name: string }) => x.name === "longtask")).toHaveLength(50);
    expect(entries.filter((x: { name: string }) => x.name === "boot-start")).toHaveLength(1);
    expect(entries.find((x: { name: string }) => x.name === "lcp").startTime).toBe(120);
    expect(JSON.stringify(entries)).not.toMatch(/private|secret|https/);
    expect(disconnect).toHaveBeenCalledTimes(4);
  });
});
