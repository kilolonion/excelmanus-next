import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import StreamingTextPreview, {
  extractJsonStringValue,
} from "../src/components/chat/StreamingTextPreview";

afterEach(() => vi.restoreAllMocks());
test("large escaped stream values use native decoding rather than character concatenation", () => {
  const code = 'const value = "quoted";\n'.repeat(10000);
  const raw = JSON.stringify({ path: "file.ts", code });
  const parse = vi.spyOn(JSON, "parse");
  expect(extractJsonStringValue(raw, "code")).toBe(code);
  expect(parse).toHaveBeenCalledOnce();
});
test("plain content returns the complete text without JSON decoding", () => {
  const content = "中文 plain text ".repeat(10000);
  const raw = JSON.stringify({ content });
  const parse = vi.spyOn(JSON, "parse");
  expect(extractJsonStringValue(raw, "content")).toBe(content);
  expect(parse).not.toHaveBeenCalled();
});
test("partial standard escapes preserve the preview at every truncation point", () => {
  const raw = '{"content":"a\\n\\t\\r\\"\\\\\\/b"}';
  const expected = [
    "",
    "a",
    "a\\",
    "a\n",
    "a\n\\",
    "a\n\t",
    "a\n\t\\",
    "a\n\t\r",
    "a\n\t\r\\",
    'a\n\t\r"',
    'a\n\t\r"\\',
    'a\n\t\r"\\',
    'a\n\t\r"\\\\',
    'a\n\t\r"\\/',
    'a\n\t\r"\\/b',
  ];
  const start = raw.indexOf(':"') + 2;
  expected.forEach((value, i) => {
    expect(extractJsonStringValue(raw.slice(0, start + i), "content")).toBe(value);
  });
  expect(extractJsonStringValue(raw, "content")).toBe(expected.at(-1));
});
test("unknown escapes and raw control characters retain the existing loose preview", () => {
  for (const value of [String.raw`a\u4e2db`, String.raw`a\bb\fc\q`, "a\nb\t", "末尾\\"]) {
    expect(extractJsonStringValue('{"content":"' + value, "content")).toBe(value);
  }
});
test("path, oldText, newText and code remain independent and stop at their closing quote", () => {
  const raw = JSON.stringify({
    path: "dir/a.ts",
    oldText: "old\nline",
    newText: 'new "value"',
    code: "run()",
  });
  expect(extractJsonStringValue(raw, "path")).toBe("dir/a.ts");
  expect(extractJsonStringValue(raw, "oldText")).toBe("old\nline");
  expect(extractJsonStringValue(raw, "newText")).toBe('new "value"');
  expect(extractJsonStringValue(raw, "code")).toBe("run()");
  expect(extractJsonStringValue(raw, "missing")).toBeNull();
  for (const colon of [":", ": ", " : "])
    expect(extractJsonStringValue(`{"content"${colon}"x"}`, "content")).toBe("x");
});

test("script previews do not search the full arguments for an unused file path", () => {
  const indexOf = vi.spyOn(String.prototype, "indexOf");
  const html = renderToString(
    createElement(StreamingTextPreview, {
      toolName: "run_script",
      rawArgs: JSON.stringify({ code: "console.log(123);" }),
    }),
  );
  expect(html).toContain("console.log(123);");
  expect(indexOf.mock.calls.filter(([needle]) => needle.includes('"path"'))).toHaveLength(0);
});
