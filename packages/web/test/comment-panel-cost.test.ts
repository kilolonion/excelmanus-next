import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  revision: 1,
  listener: null as null | ((c: { id: string }) => void),
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value;
    const value = fn();
    h.slots[i] = { value, deps };
    return value;
  };
  return {
    ...r,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useState: (initial: unknown) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (next: any) => {
          h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
        },
      ];
    },
    useEffect: (fn: () => void, deps: unknown[]) => {
      memo(() => {
        h.effects.push(fn);
      }, deps);
    },
  };
});
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (select: any) => select({ doc: { rev: h.revision } }),
}));

import { OBJECT_LAYER_MUTATION } from "@excelmanus/protocol";
import { ThreadedCommentsPanel } from "../src/components/excel/ThreadedCommentsPanel";

function nodes(node: any, type?: string): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, type));
  return [...(!type || node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
function render(api: any) {
  h.index = 0;
  const tree = ThreadedCommentsPanel({ api, onClose() {} });
  for (const fn of h.effects.splice(0)) fn();
  return tree;
}
function fixture() {
  const comment = {
    id: "{11111111-1111-4111-8111-111111111111}",
    personId: "{22222222-2222-4222-8222-222222222222}",
    ref: "A1",
    text: "original",
    author: "QA",
    done: false,
  };
  const data = {
    name: "Data",
    custom: { excelmanusObjects: { charts: [], images: [], threadedComments: [comment] } },
  };
  const snapshot = vi.fn(() => data);
  const save = vi.fn(() => ({ sheets: { s: structuredClone(data) } }));
  const executeCommand = vi.fn(async () => true);
  const api = {
    disposed: false,
    univerAPI: { executeCommand },
    wb: {
      getId: () => "unit",
      getSheetBySheetId: () => ({ getSheet: () => ({ getSnapshot: snapshot }) }),
      save,
      getSheets: () => [{ getSheetId: () => "s", getSheet: () => ({ getSnapshot: snapshot }) }],
      onCommandExecuted: (fn: any) => {
        h.listener = fn;
        return { dispose() {} };
      },
    },
  };
  return { api, snapshot, comment, data, save, executeCommand };
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.effects = [];
  h.revision = 1;
  h.listener = null;
});
test("typing a comment does not reread workbook objects or rebuild existing thread rows", () => {
  const { api, snapshot } = fixture();
  const first = render(api);
  const section = nodes(first, "section")[0];
  const reply = nodes(first).find((n) => n.props?.children === "回复");
  reply.props.onClick();
  const form = render(api);
  const input = nodes(form).find((n) => n.props?.["aria-label"] === "线程批注内容");
  for (let i = 0; i < 20; i++) {
    input.props.onChange({ target: { value: `draft ${i}` } });
    const next = render(api);
    expect(nodes(next, "section")[0]).toBe(section);
  }
  expect(snapshot).toHaveBeenCalledTimes(1);
});
test("revision and object mutations refresh comments; disposed instances remain hidden", () => {
  const { api, snapshot, comment, data } = fixture();
  render(api);
  comment.text = "remote";
  data.name = "Renamed";
  h.revision++;
  expect(JSON.stringify(render(api))).toContain("remote");
  expect(snapshot).toHaveBeenCalledTimes(2);
  comment.text = "local";
  h.listener!({ id: OBJECT_LAYER_MUTATION });
  expect(JSON.stringify(render(api))).toContain("local");
  expect(snapshot).toHaveBeenCalledTimes(3);
  api.disposed = true;
  expect(render(api)).toBeNull();
  expect(snapshot).toHaveBeenCalledTimes(3);
});

test("sheet metadata mutations refresh names and resolved filtering does not reload objects", () => {
  const { api, data, snapshot, comment } = fixture();
  data.custom.excelmanusObjects.threadedComments.push({
    ...comment,
    id: "{33333333-3333-4333-8333-333333333333}",
    text: "resolved",
    done: true,
  });
  const first = render(api);
  expect(nodes(first, "section")).toHaveLength(1);
  nodes(first)
    .find((n) => n.props?.children === "显示已解决")
    .props.onClick();
  expect(nodes(render(api), "section")).toHaveLength(2);
  expect(snapshot).toHaveBeenCalledTimes(1);
  data.name = "Latest name";
  h.listener!({ id: "sheet.mutation.set-worksheet-name" });
  expect(JSON.stringify(render(api))).toContain("Latest name");
  expect(snapshot).toHaveBeenCalledTimes(2);
});

test("resolving a thread reads fresh sheet metadata without saving the entire workbook", async () => {
  const f = fixture();
  const first = render(f.api);
  f.comment.text = "updated before commit";
  nodes(first)
    .find((n) => n.props?.["aria-label"] === "解决批注")
    .props.onClick();
  await vi.waitFor(() => expect(f.executeCommand).toHaveBeenCalledOnce());
  expect(f.save).not.toHaveBeenCalled();
  const [id, params] = f.executeCommand.mock.calls[0] as unknown as [
    string,
    { subUnitId: string; objects: { threadedComments: Array<{ text: string; done: boolean }> } },
  ];
  expect(id).toBe(OBJECT_LAYER_MUTATION);
  expect(params.subUnitId).toBe("s");
  expect(params.objects.threadedComments[0]).toMatchObject({
    text: "updated before commit",
    done: true,
  });
  expect(f.comment.done).toBe(false);
  params.objects.threadedComments[0].text = "detached payload";
  expect(f.comment.text).toBe("updated before commit");
});

test("reply submission keeps existing comments and does not mutate live metadata before the command", async () => {
  const f = fixture();
  nodes(render(f.api))
    .find((n) => n.props?.children === "回复")
    .props.onClick();
  nodes(render(f.api))
    .find((n) => n.props?.["aria-label"] === "线程批注内容")
    .props.onChange({ target: { value: "new reply" } });
  nodes(render(f.api), "form")[0].props.onSubmit({ preventDefault() {} });
  await vi.waitFor(() => expect(f.executeCommand).toHaveBeenCalledOnce());
  expect(f.save).not.toHaveBeenCalled();
  const params = (
    f.executeCommand.mock.calls[0] as unknown as [
      string,
      { objects: { threadedComments: Array<{ text: string; parentId?: string }> } },
    ]
  )[1];
  expect(params.objects.threadedComments).toHaveLength(2);
  expect(params.objects.threadedComments[1]).toMatchObject({
    text: "new reply",
    parentId: f.comment.id,
  });
  expect(f.data.custom.excelmanusObjects.threadedComments).toEqual([f.comment]);
});

test("a thread list shares one date formatter instead of constructing locale formatting per comment", () => {
  const f = fixture();
  Object.assign(f.comment, { dateTime: "2026-10-18T00:00:00Z" });
  for (let i = 0; i < 100; i++)
    f.data.custom.excelmanusObjects.threadedComments.push({
      ...f.comment,
      id: `{${String(i).padStart(8, "0")}-3333-4333-8333-333333333333}`,
    });
  const oldFormat = vi.spyOn(Date.prototype, "toLocaleString");
  const formatter = vi.spyOn(Intl, "DateTimeFormat");
  try {
    render(f.api);
    expect(oldFormat).not.toHaveBeenCalled();
    expect(formatter).toHaveBeenCalledTimes(1);
  } finally {
    oldFormat.mockRestore();
    formatter.mockRestore();
  }
});

test("cell-only revisions keep existing comment sections and skip repeated row preparation", () => {
  const f = fixture();
  const first = nodes(render(f.api), "section")[0];
  for (let i = 0; i < 30; i++) {
    h.revision++;
    expect(nodes(render(f.api), "section")[0]).toBe(first);
  }
  // Keep reading current metadata so in-place comment changes are still detected.
  expect(f.snapshot).toHaveBeenCalledTimes(31);
  f.comment.author = "Updated author";
  h.revision++;
  const changed = render(f.api);
  expect(nodes(changed, "section")[0]).not.toBe(first);
  expect(JSON.stringify(changed)).toContain("Updated author");
});
test("unchanged object notifications reuse rows while invalid metadata still hides comments", () => {
  const f = fixture();
  const first = nodes(render(f.api), "section")[0];
  h.listener!({ id: OBJECT_LAYER_MUTATION });
  expect(nodes(render(f.api), "section")[0]).toBe(first);
  f.data.custom.excelmanusObjects.charts = [{}] as never[];
  h.listener!({ id: OBJECT_LAYER_MUTATION });
  expect(nodes(render(f.api), "section")).toHaveLength(0);
  f.data.custom.excelmanusObjects.charts = [];
  h.listener!({ id: OBJECT_LAYER_MUTATION });
  expect(nodes(render(f.api), "section")).toHaveLength(1);
});
