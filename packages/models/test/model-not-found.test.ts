import { APICallError, StreamProviderError } from "ai";
import { expect, test } from "vitest";
import { classifyError } from "../src/index.ts";

test("explicit model_not_found overrides a proxy HTTP 500", () => {
  const error = new APICallError({
    message: "upstream rejected",
    url: "https://fixture.invalid",
    requestBodyValues: {},
    statusCode: 500,
    responseBody: JSON.stringify({ error: { code: "model_not_found", message: "missing model" } }),
  });
  expect(classifyError(error, false)).toMatchObject({
    kind: "model_not_found",
    retryable: false,
    statusCode: 500,
  });
});

test("explicit streamed model_not_found is not retried", () => {
  expect(
    classifyError(
      new StreamProviderError({
        message: "missing model",
        code: "model_not_found",
        statusCode: 500,
        isRetryable: true,
      }),
      true,
    ),
  ).toMatchObject({ kind: "model_not_found", retryable: false });
});

test.each(["incomplete_stream", "internal_server_error"])("%s remains retryable", (code) => {
  const error = new APICallError({
    message: "upstream failed",
    url: "https://fixture.invalid",
    requestBodyValues: {},
    statusCode: 500,
    responseBody: JSON.stringify({ error: { code } }),
  });
  expect(classifyError(error, false)).toMatchObject({ kind: "server_error", retryable: true });
});

test("quoted historical model_not_found does not override current failure", () => {
  const error = new APICallError({
    message: "previous model_not_found",
    url: "https://fixture.invalid",
    requestBodyValues: {},
    statusCode: 503,
    responseBody: JSON.stringify({
      error: { code: "internal_server_error", message: "previous model_not_found" },
    }),
  });
  expect(classifyError(error, false)).toMatchObject({ kind: "server_error", retryable: true });
});
