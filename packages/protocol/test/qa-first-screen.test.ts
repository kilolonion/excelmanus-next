import { describe, expect, it } from "vitest";
import { createOpenApiDocument, httpContracts, QaFirstScreenMetricsBody } from "../src/index.ts";

const body = {
  runId: "11111111-1111-4111-8111-111111111111",
  sessionId: "qa-session",
  observations: [{ name: "fcp", startTime: 10, duration: 0 }],
};

describe("bounded QA first-screen contract", () => {
  it("builds the production OpenAPI document with both QA schemas registered", () => {
    const document = createOpenApiDocument("qa-test");
    expect(document.components.schemas).toHaveProperty("QaFirstScreenMetricsBody");
    expect(document.components.schemas).toHaveProperty("QaFirstScreenMetricsResponse");
    expect(document.paths).toHaveProperty("/qa/first-screen-metrics");
  });
  it("accepts numeric observations and registers the endpoint", () => {
    expect(QaFirstScreenMetricsBody.parse(body)).toEqual(body);
    expect(httpContracts.find((c) => c.path === "/qa/first-screen-metrics")?.body).toBe(
      QaFirstScreenMetricsBody,
    );
  });
  it("rejects unbounded, unknown, or identifying observation fields", () => {
    for (const observation of [
      { name: "fcp", startTime: Number.NaN, duration: 0 },
      { name: "fcp", startTime: 30001, duration: 0 },
      { name: "fcp", startTime: 0, duration: Number.POSITIVE_INFINITY },
      { name: "resource", startTime: 0, duration: 1, route: "/sessions/private" },
      { name: "lcp", startTime: 0, duration: 0, url: "https://secret.invalid" },
    ])
      expect(
        QaFirstScreenMetricsBody.safeParse({ ...body, observations: [observation] }).success,
      ).toBe(false);
    expect(QaFirstScreenMetricsBody.safeParse({ ...body, token: "secret" }).success).toBe(false);
  });
  it("caps resource, longtask and total counts", () => {
    for (const [name, count] of [
      ["resource", 201],
      ["longtask", 51],
      ["fcp", 271],
    ] as const) {
      expect(
        QaFirstScreenMetricsBody.safeParse({
          ...body,
          observations: Array.from({ length: count }, () => ({ name, startTime: 0, duration: 1 })),
        }).success,
      ).toBe(false);
    }
  });
});
