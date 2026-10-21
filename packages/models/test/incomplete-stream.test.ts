import type { ResolvedModel, StepEvent } from "@excelmanus/protocol";
import { describe, expect, test } from "vitest";
import { createGateway } from "../src/index.ts";

const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "qa", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

async function run(body: string): Promise<StepEvent[]> {
  const model: ResolvedModel = {
    profileId: "qa",
    provider: "custom-openai-compatible",
    model: "qa-model",
    apiKey: "fixture-key",
    baseUrl: "https://fixture.invalid/v1",
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  };
  const events: StepEvent[] = [];
  for await (const event of createGateway().step({
    model,
    history: [{ kind: "user", text: "OK" }],
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events;
}

describe("incomplete compatible SSE", () => {
  test.each([
    ["skeleton then EOF", chunk({ role: "assistant" })],
    ["skeleton then DONE", `${chunk({ role: "assistant" })}data: [DONE]\n\n`],
    ["text then EOF", chunk({ content: "partial" })],
    ["empty finish reason", `${chunk({ content: "partial" }, "")}data: [DONE]\n\n`],
  ])("%s is retryable, never a successful finish", async (_name, body) => {
    const events = await run(body);
    expect(events.filter((e) => e.kind === "finish")).toEqual([]);
    expect(events.filter((e) => e.kind === "error")).toEqual([
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({
          kind: "stream_interrupted",
          retryable: true,
          detail: "incomplete_stream",
        }),
      }),
    ]);
    if (body.includes("partial"))
      expect(events).toContainEqual({ kind: "text.delta", text: "partial" });
  });

  test.each(["stop", "length", "content_filter"])(
    "valid %s remains a normal terminal event",
    async (reason) => {
      const events = await run(`${chunk({ content: "OK" }, reason)}data: [DONE]\n\n`);
      expect(events.some((e) => e.kind === "error")).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "finish",
          reason: reason === "content_filter" ? "content-filter" : reason,
        }),
      );
    },
  );

  test("an explicit provider error is not overwritten by a missing finish", async () => {
    const events = await run(
      'data: {"error":{"message":"upstream overloaded","type":"server_error","code":"internal_server_error"}}\n\ndata: [DONE]\n\n',
    );
    expect(events.filter((e) => e.kind === "finish")).toEqual([]);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({ kind: "server_error", retryable: true }),
      }),
    );
  });

  test("CPA missing-finish SSE error uses the same incomplete-stream retry classification", async () => {
    const events = await run(
      'data: {"error":{"message":"upstream stream closed before any chunk carried finish_reason","type":"server_error","code":"internal_server_error"}}\n\ndata: [DONE]\n\n',
    );
    expect(events.filter((e) => e.kind === "error")).toEqual([
      expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({
          kind: "stream_interrupted",
          retryable: true,
          detail: "incomplete_stream",
        }),
      }),
    ]);
    expect(events.some((e) => e.kind === "finish")).toBe(false);
  });
});
