import type { ModelProfile } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ActivityGroup } from "../src/components/chat/ActivityGroup";
import { AssistantMessage } from "../src/components/chat/AssistantMessage";
import { MemoizedMarkdown } from "../src/components/chat/assistant-blocks/MemoizedMarkdown";
import { ThinkingBlock } from "../src/components/chat/ThinkingBlock";
import { ToolCallCard } from "../src/components/chat/ToolCallCard";
import { WorkbookContextChip } from "../src/components/excel/WorkbookConversation";
import { toPickerModel } from "../src/hooks/use-model-selection";
import { initialSessionState } from "../src/lib/session/reducer";
import type { TurnSegment } from "../src/lib/session/types";
import { useChatStore } from "../src/stores/chat-store";
import { useWorkbookStore } from "../src/stores/workbook-store";

test("model picker names the actual model and retains its profile as secondary information", () => {
  const item = toPickerModel(
    {
      id: "cpa",
      name: "Cpa",
      model: "cline-pass/deepseek-v4.1-flash",
      provider: "custom-openai-compatible",
      isDefault: true,
    } as ModelProfile,
    new Map(),
  );
  expect(item.label).toBe("cline-pass/deepseek-v4.1-flash");
  expect(item).toMatchObject({ id: "cpa", profileName: "Cpa" });
});

test("thinking uses the same flat step row as tools", () => {
  const html = renderToStaticMarkup(
    createElement(ThinkingBlock, { content: "检查列宽", duration: 2 }),
  );
  expect(html).toContain("em-step-row");
  expect(html).not.toContain("rounded-2xl border");
  expect(html).toContain("展开思考");
});

test("a collapsed tool hides its structured result preview", () => {
  const session = initialSessionState();
  session.tools.t = {
    id: "t",
    name: "run_script",
    agentId: "main",
    seq: 1,
    args: {},
    targets: [],
    phase: "done",
    status: "ok",
    result: { status: "ok", data: { stdout: "UNIQUE_TOOL_OUTPUT" } },
  };
  const initial = useChatStore.getInitialState();
  const previous = initial.session;
  initial.session = session;
  try {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolId: "t" }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("UNIQUE_TOOL_OUTPUT");
    const group = renderToStaticMarkup(
      createElement(ActivityGroup, { toolIds: ["t"], defaultCollapsed: false }),
    );
    expect(group).toContain("em-steps mt-0.5 ml-5");
  } finally {
    initial.session = previous;
  }
});

test("workbook selection uses the compact v1 reference row and keeps Next controls", () => {
  const initial = useWorkbookStore.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, {
    activePath: "receipt.xlsx",
    panelOpen: true,
    selection: { docId: "d", rev: 1, range: "Sheet1!A1:G18" },
  });
  try {
    const html = renderToStaticMarkup(createElement(WorkbookContextChip));
    expect(html).not.toContain("em-composer-tab");
    expect(html).toContain("Sheet1!A1:G18");
    expect(html).toContain("钉住此区域");
    expect(html).toContain("不附带此区域");
  } finally {
    Object.assign(initial, saved);
  }
});

test("streaming prose precedes the subsequent pending tool and renders Markdown", () => {
  const initial = useChatStore.getInitialState();
  const previous = initial.session;
  const segment: TurnSegment = {
    kind: "turn",
    id: "t:0",
    turnId: "t",
    segment: 0,
    seq: 1,
    at: "2026-10-12T00:00:00Z",
    agentId: "main",
    status: "running",
    blocks: [],
    steps: 1,
  };
  const session = initialSessionState();
  session.openSegments.main = { turnId: "t", segment: 0, segmentId: "t:0" };
  session.live.main = {
    stepId: "s",
    text: "STREAM_BEFORE_TOOL",
    reasoning: "",
    reasoningStartedAt: null,
    toolArgs: { c: { name: "workbook_edit", text: "{}" } },
    activity: [],
    contextUsage: null,
  };
  initial.session = session;
  try {
    const html = renderToStaticMarkup(createElement(AssistantMessage, { segment, isLatest: true }));
    expect(html.indexOf("STREAM_BEFORE_TOOL")).toBeLessThan(html.indexOf("正在准备"));
    const markdown = renderToStaticMarkup(
      createElement(MemoizedMarkdown, {
        content: "| 项 | 值 |\n|---|---|\n| 合计 | 5190 |",
        isStreamingText: true,
      }),
    );
    expect(markdown).toContain("<table");
  } finally {
    initial.session = previous;
  }
});

test("range confirmation offers to open its workbook instead of a disabled dead end", async () => {
  const { QuestionInline } = await import("../src/components/chat/AskUserCard");
  const previous = useWorkbookStore.getState().doc;
  useWorkbookStore.setState({ doc: null });
  try {
    const html = renderToStaticMarkup(
      createElement(QuestionInline, {
        question: {
          id: "range-reload",
          type: "range_confirm",
          status: "pending",
          agentId: "main",
          seq: 1,
          spec: { path: "probe.xlsx", suggestedRange: "Sheet1!A1:B3" },
        },
      }),
    );
    expect(html).toContain("打开表格后确认");
    expect(html).not.toContain('disabled=""');
  } finally {
    useWorkbookStore.setState({ doc: previous });
  }
});
