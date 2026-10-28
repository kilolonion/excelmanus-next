import { ensureHljs, highlightCode, highlightCodeLines } from "./hljs-utils";

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ code: string; language: string; output?: "html" }>,
  ) => Promise<void>;
  postMessage: (result: string[] | string | null) => void;
};
scope.onmessage = async ({ data }) => {
  await ensureHljs(data.language);
  scope.postMessage(
    data.output === "html"
      ? highlightCode(data.code, data.language)
      : highlightCodeLines(data.code, data.language),
  );
};
