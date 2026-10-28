import { expect, test } from "vitest";
import { ensureHljs, getHljs, highlightCode } from "../src/lib/hljs-utils";

test("language aliases share grammars without multiplying automatic detection candidates", async () => {
  await ensureHljs();
  const hljs = getHljs();
  expect(hljs).not.toBeNull();
  expect(hljs?.listLanguages()).toHaveLength(12);
  for (const [alias, name] of [
    ["py", "python"],
    ["js", "javascript"],
    ["ts", "typescript"],
    ["sh", "bash"],
    ["zsh", "bash"],
    ["html", "xml"],
    ["yml", "yaml"],
    ["txt", "plaintext"],
  ]) {
    expect(hljs?.getLanguage(alias)).toBe(hljs?.getLanguage(name));
    expect(highlightCode("const a = { value: 3 };", alias)).toBe(
      highlightCode("const a = { value: 3 };", name),
    );
  }
});
