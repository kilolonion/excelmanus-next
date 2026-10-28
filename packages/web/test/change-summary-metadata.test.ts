import { ServerMessage } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TurnChangesCard } from "../src/components/chat/assistant-blocks/block-cards";
import { initialSessionState, reduceSession, visibleTimeline } from "../src/lib/session/reducer";
import type { DocChange, TurnSegment } from "../src/lib/session/types";

const notice = "已存工作表名称元数据不足，缺失名称以 sheetId 表示";
const doc = {
  docId: "doc1",
  path: "销售.xlsx",
  fromRev: 1,
  toRev: 2,
  revs: [2],
  cellsBySheet: { "sheet-id": 4 },
  ranges: ["sheet-id!A1:B2"],
  structural: [],
  added: [],
};

function replay(extra: Record<string, unknown>): DocChange {
  const session = reduceSession(
    initialSessionState(),
    ServerMessage.parse({
      type: "rec",
      topic: "session:x",
      seq: 1,
      record: {
        seq: 1,
        sessionId: "x",
        agentId: "main",
        type: "change.summary",
        data: { changes: { docs: [{ ...doc, ...extra }] } },
        createdAt: "2026-10-21T00:00:00Z",
      },
    }),
  );
  const turn = visibleTimeline(session, "main").find(
    (item): item is TurnSegment => item.kind === "turn",
  );
  const block = turn?.blocks.find((item) => item.type === "changes");
  if (block?.type !== "changes" || !block.changes[0])
    throw new Error("Change summary replay did not create a change card");
  return block.changes[0];
}

function render(change: DocChange): string {
  return renderToStaticMarkup(createElement(TurnChangesCard, { changes: [change] }));
}

test("metadata-limited replay retains its flag without inventing structural changes", () => {
  const change = replay({ metadataLimited: true });
  expect(change).toEqual({ ...doc, metadataLimited: true });
});

test("metadata-limited change summary displays the fixed sheetId explanation", () => {
  const change = { ...doc, metadataLimited: true };
  const html = render(change);
  expect(html).toContain(`4 格 · 1 处区域 · ${notice}`);
  expect(html.split(notice)).toHaveLength(2);
});

test.each([{}, { metadataLimited: false }, { metadataLimited: "true" }])(
  "legacy and non-true metadata flags preserve the original card: %j",
  (extra) => {
    const change = replay(extra);
    expect(change).toEqual({
      ...doc,
      ...(typeof extra.metadataLimited === "boolean"
        ? { metadataLimited: extra.metadataLimited }
        : {}),
    });
    expect(render(change)).toContain("4 格 · 1 处区域");
    expect(render(change)).not.toContain(notice);
  },
);
