import { ServerMessage, type ToolResult } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AskUserCard, QuestionInline } from "../src/components/chat/AskUserCard";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

function replayQuestion(answer: unknown, result?: ToolResult) {
  let session = initialSessionState();
  let seq = 0;
  const apply = (type: string, data: Record<string, unknown>) => {
    seq += 1;
    session = reduceSession(
      session,
      ServerMessage.parse({
        type: "rec",
        topic: "session:x",
        seq,
        record: {
          seq,
          sessionId: "x",
          agentId: "main",
          type,
          data,
          createdAt: "2026-10-20T18:19:47Z",
        },
      }),
    );
  };
  const spec = {
    question: "是否开始只读核验？",
    options: [{ value: "yes", label: "是，开始只读核验" }],
  };
  apply("turn.started", { turnId: "t" });
  apply("tool.intent", {
    toolCallId: "ask",
    toolName: "ask_user",
    args: { type: "choice", spec },
  });
  apply("question.asked", {
    questionId: "q",
    questionType: "choice",
    spec: { ...spec, _runtime: { toolCallId: "ask" } },
  });
  apply("question.answered", { questionId: "q", answer });
  if (result) {
    apply("tool.result", {
      toolCallId: "ask",
      toolName: "ask_user",
      status: result.status,
      result,
    });
    apply(result.status === "ok" ? "turn.completed" : "turn.interrupted", { turnId: "t" });
  }
  const tool = session.tools.ask;
  const question = session.questions.q;
  if (!tool || !question) throw new Error("Question replay did not create its tool and question");
  return { tool, question };
}

test.each([
  ["CANCELLED", "代理已停止"],
  ["TIMEOUT", "等待用户回答超时"],
] as const)("a %s question displays its tool outcome, not a successful answer", (code, message) => {
  // The runtime closes pending questions with answer:null before the failed tool result.
  const props = replayQuestion(null, {
    status: "error",
    error: { code, message, retryable: false },
  });
  expect(props.question).toMatchObject({ status: "answered", answer: null });
  expect(props.tool).toMatchObject({ phase: "done", status: "error" });
  const html = renderToStaticMarkup(createElement(AskUserCard, props));
  expect(html).toContain(message);
  expect(html).not.toContain("已回答");
  expect(html).not.toContain("等待回答");
  expect(html).not.toContain("lucide-circle-check");
  expect(html).not.toContain("<button");
});

test("a null closure is not presented as a user answer before the tool result arrives", () => {
  const props = replayQuestion(null);
  const inline = renderToStaticMarkup(createElement(QuestionInline, props));
  const card = renderToStaticMarkup(createElement(AskUserCard, props));
  expect(inline).not.toContain("已回答");
  expect(inline).not.toContain("lucide-user");
  expect(inline).not.toContain("<button");
  expect(card).not.toContain("lucide-circle-check");
});

test("a real answer retains its selected label and successful answer marker", () => {
  const props = replayQuestion("yes", {
    status: "ok",
    data: { questionId: "q", status: "answered", answer: "yes" },
  });
  const inline = renderToStaticMarkup(createElement(QuestionInline, props));
  const card = renderToStaticMarkup(createElement(AskUserCard, props));
  expect(inline).toContain("是，开始只读核验");
  expect(inline).toContain("lucide-user");
  expect(card).toContain("lucide-circle-check");
  expect(card).not.toContain("等待回答");
  expect(card).not.toContain("提问未能送达");
});
