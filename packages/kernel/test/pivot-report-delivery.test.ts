import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { numericDeliveryState } from "../src/numeric-delivery.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE session_log (session_id TEXT, agent_id TEXT, seq INTEGER, type TEXT, data TEXT)",
  );
  let seq = 0;
  const append = (type: string, data: unknown, agent = "main", session = "s") =>
    db
      .prepare("INSERT INTO session_log VALUES (?,?,?,?,?)")
      .run(session, agent, ++seq, type, JSON.stringify(data));
  append("turn.started", { turnId: "t" });
  const result = (
    data: Record<string, unknown>,
    agent = "main",
    session = "s",
    status = "ok",
    rev = 4,
  ) =>
    append(
      "tool.result",
      {
        toolName: "workbook_read",
        status,
        result: {
          status,
          docRevs: { d: rev },
          data: {
            docId: "d",
            path: "report.xlsx",
            sourceFile: { currentSha256: "saved-sha" },
            ...data,
          },
        },
      },
      agent,
      session,
    );
  return { db, append, result, state: () => numericDeliveryState(db, "s", "main", "t") };
}
const objects = () => ({
  mode: "objects",
  reportFacts: {
    version: 1,
    pivots: [
      {
        part: "xl/pivotTables/pivotTable1.xml",
        name: "MovedPivot",
        linked: true,
        sheet: "报告",
        range: "C8:D9",
        checkpoint: { rev: 4, currentRev: 4, isCurrent: true },
      },
    ],
  },
});
const range = () => ({
  mode: "range",
  sheet: "报告",
  values: [
    ["Total", 10],
    ["Grand Total", 20],
  ],
  readWindow: { returnedRange: "报告!C8:D9", returnedRows: 2, totalRows: 2, complete: true },
});

test("linked saved pivot + same revision/SHA complete returned coverage requires a controlled report in either order", () => {
  for (const reverse of [false, true]) {
    const t = fixture();
    t.result(reverse ? range() : objects());
    expect(t.state().required).toBe(false);
    t.result(reverse ? objects() : range());
    expect(t.state()).toEqual({ required: true, rejected: 0 });
    expect(numericDeliveryState(t.db, "s", "main", "t")).toEqual(t.state());
  }
});

test("ordinary reads, unrelated agents/sessions, partial coverage and stale saved metadata do not broaden the pivot trigger", () => {
  const scenarios: {
    object?: Record<string, unknown>;
    value?: Record<string, unknown>;
    agent?: string;
    session?: string;
    status?: string;
    rev?: number;
  }[] = [
    { object: { mode: "overview" } },
    { object: { mode: "objects", reportFacts: { version: 1, pivots: [] } } },
    {
      object: {
        mode: "objects",
        reportFacts: {
          version: 1,
          pivots: [{ ...objects().reportFacts.pivots[0], linked: false }],
        },
      },
    },
    {
      object: {
        mode: "objects",
        reportFacts: {
          version: 1,
          pivots: [
            {
              ...objects().reportFacts.pivots[0],
              checkpoint: { rev: 3, currentRev: 4, isCurrent: false },
            },
          ],
        },
      },
    },
    { value: { ...range(), path: "other.xlsx" } },
    { value: { ...range(), sourceFile: { currentSha256: "different-sha" } } },
    { value: { ...range(), docId: "other" } },
    { value: { ...range(), readWindow: { returnedRange: "报告!C8:D8" } } },
    { value: { ...range(), readWindow: { returnedRange: "other!C8:D9" } } },
    { value: { ...range(), values: [["Total", 10]] } },
    {
      value: {
        ...range(),
        values: [
          ["Total", null],
          ["Grand Total", "20"],
        ],
      },
    },
    { agent: "child" },
    { session: "other" },
    { status: "error" },
    { rev: 5 },
    { rev: -1 },
  ];
  for (const scenario of scenarios) {
    const t = fixture();
    t.result(scenario.object ?? objects());
    t.result(
      scenario.value ?? range(),
      scenario.agent,
      scenario.session,
      scenario.status,
      scenario.rev,
    );
    expect(t.state().required, JSON.stringify(scenario)).toBe(false);
  }
});

test("a returned subpage may fully cover the pivot without claiming the full request was read; new turns do not borrow old reads", () => {
  const t = fixture();
  t.result(objects());
  t.result({
    ...range(),
    readWindow: {
      returnedRange: "报告!C8:D9",
      offset: 7,
      totalRows: 30,
      returnedRows: 2,
      complete: false,
    },
  });
  expect(t.state().required).toBe(true);
  t.append("turn.completed", { turnId: "t" });
  t.append("turn.started", { turnId: "next" });
  t.result(range());
  expect(numericDeliveryState(t.db, "s", "main", "next").required).toBe(false);
  t.append("turn.started", { turnId: "resume", numericDeliveryRequired: true });
  expect(numericDeliveryState(t.db, "s", "main", "resume").required).toBe(true);
});
