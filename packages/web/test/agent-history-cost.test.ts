import { expect, test } from "vitest";
import {
  initialSessionState,
  pendingDispatches,
  visibleTimeline,
} from "../src/lib/session/reducer";
import type { TimelineItem, UserItem } from "../src/lib/session/types";

const user = (seq: number, agentId = "main"): UserItem => ({
  kind: "user",
  id: String(seq),
  seq,
  agentId,
  at: "2026-01-01T00:00:00Z",
  text: String(seq),
  mode: "queue",
  status: "queued",
  clientMessageId: String(seq),
  attachments: [],
  context: [],
});
test("other agents' history and rewind changes do not rebuild the current filtered timeline", () => {
  const s = initialSessionState();
  let reads = 0;
  s.timelines.main = Array.from({ length: 1000 }, (_, i) => {
    const item = user(i + 1);
    Object.defineProperty(item, "seq", {
      get() {
        reads++;
        return i + 1;
      },
    });
    return item;
  });
  s.rewinds.main = [{ fromSeq: 1, seq: 500 }];
  const visible = visibleTimeline(s, "main");
  reads = 0;
  const next = {
    ...s,
    timelines: { ...s.timelines, child: [user(1001, "child")] },
    rewinds: { ...s.rewinds, child: [{ fromSeq: 900, seq: 1000 }] },
  };
  expect(visibleTimeline(next, "main")).toBe(visible);
  expect(reads).toBe(0);
  expect(visibleTimeline(next, "missing")).toBe(
    visibleTimeline({ ...next, timelines: { ...next.timelines } }, "missing"),
  );
});
test("rewind endpoints are indexed once rather than reread for every history item", () => {
  const s = initialSessionState();
  let endpoints = 0;
  s.rewinds.main = Array.from({ length: 100 }, (_, i) => ({
    get fromSeq() {
      endpoints++;
      return i * 10;
    },
    get seq() {
      endpoints++;
      return i * 10 + 2;
    },
  }));
  s.timelines.main = Array.from({ length: 2000 }, (_, i) => user(i));
  const actual = visibleTimeline(s, "main");
  expect(actual).toHaveLength(1800);
  expect(endpoints).toBeLessThan(1500);
  endpoints = 0;
  const next = { ...s, timelines: { main: [...s.timelines.main, user(2001)] } };
  expect(visibleTimeline(next, "main")).toHaveLength(1801);
  expect(endpoints).toBe(0);
});
test("all agents share one queue grouping pass and empty selections remain stable", () => {
  const s = initialSessionState();
  let reads = 0;
  s.dispatches = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => {
      const item = user(i, `a${i % 20}`);
      Object.defineProperty(item, "agentId", {
        get() {
          reads++;
          return `a${i % 20}`;
        },
      });
      return [String(i), item];
    }),
  );
  for (let i = 0; i < 20; i++) expect(pendingDispatches(s, `a${i}`)).toHaveLength(25);
  expect(reads).toBe(500);
  const empty = pendingDispatches(s, "empty");
  expect(
    pendingDispatches(
      { ...s, dispatches: { ...s.dispatches, extra: user(700, "child") } },
      "empty",
    ),
  ).toBe(empty);
});
test("overlapping rewind intervals preserve half-open boundaries, notices and partial turns", () => {
  const s = initialSessionState();
  const notice = { kind: "rewind", seq: 4 } as TimelineItem;
  const turn = {
    kind: "turn",
    seq: 10,
    blocks: [
      { type: "text", seq: 3, text: "hidden" },
      { type: "text", seq: 10, text: "visible" },
    ],
  } as TimelineItem;
  s.timelines.main = [user(1), user(2), notice, user(7), user(10), turn, user(20)];
  s.rewinds.main = [
    { fromSeq: 5, seq: 8 },
    { fromSeq: 2, seq: 6 },
    { fromSeq: 8, seq: 10 },
  ];
  const out = visibleTimeline(s, "main");
  expect(out.map((i) => i.seq)).toEqual([1, 4, 10, 10, 20]);
  expect(out[1]).toBe(notice);
  expect((out[3] as any).blocks.map((b: any) => b.text)).toEqual(["visible"]);
  expect((turn as any).blocks).toHaveLength(2);
  const changed = { ...s, rewinds: { main: [...s.rewinds.main, { fromSeq: 10, seq: 21 }] } };
  expect(visibleTimeline(changed, "main").map((i) => i.seq)).toEqual([1, 4]);
});
