/**
 * Shared highlight.js utilities: lazy-loading + rainbow brackets.
 * Used by CodeBlock and CodePreviewModal.
 */

let _hljs: typeof import("highlight.js").default | null = null;
let _hljsLoading: Promise<void> | null = null;

const plainLanguages = new Set(["plaintext", "text", "txt"]);
const isPlainLanguage = (language?: string) => plainLanguages.has(language?.toLowerCase() ?? "");

export function ensureHljs(language?: string): Promise<void> {
  if (isPlainLanguage(language)) return Promise.resolve();
  if (_hljs) return Promise.resolve();
  if (_hljsLoading) return _hljsLoading;
  _hljsLoading = import("highlight.js/lib/core")
    .then(async (mod) => {
      const hljs = mod.default;
      // 注册常用语言
      const langs = await Promise.all([
        import("highlight.js/lib/languages/python"),
        import("highlight.js/lib/languages/javascript"),
        import("highlight.js/lib/languages/typescript"),
        import("highlight.js/lib/languages/json"),
        import("highlight.js/lib/languages/bash"),
        import("highlight.js/lib/languages/sql"),
        import("highlight.js/lib/languages/xml"),
        import("highlight.js/lib/languages/css"),
        import("highlight.js/lib/languages/markdown"),
        import("highlight.js/lib/languages/yaml"),
        import("highlight.js/lib/languages/shell"),
        import("highlight.js/lib/languages/plaintext"),
      ]);
      const names = [
        "python",
        "javascript",
        "typescript",
        "json",
        "bash",
        "sql",
        "xml",
        "css",
        "markdown",
        "yaml",
        "shell",
        "plaintext",
      ];
      langs.forEach((l, i) => {
        hljs.registerLanguage(names[i], l.default);
      });
      // Aliases resolve to the same grammar; registering them as languages duplicates auto-detection.
      hljs.registerAliases("py", { languageName: "python" });
      hljs.registerAliases("js", { languageName: "javascript" });
      hljs.registerAliases("ts", { languageName: "typescript" });
      hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
      hljs.registerAliases("html", { languageName: "xml" });
      hljs.registerAliases("yml", { languageName: "yaml" });
      hljs.registerAliases("txt", { languageName: "plaintext" });
      _hljs = hljs;
    })
    .catch(() => {
      // Highlighting is optional; keep plain text usable and allow a later retry.
      _hljsLoading = null;
    });
  return _hljsLoading;
}

export function getHljs() {
  return _hljs;
}

// ------------------------------------------------------------------
// 彩虹括号：后处理 hljs HTML 为括号上色，按括号类型分三色族、按嵌套深度循环
// ------------------------------------------------------------------

const CURLY_COLORS = ["#e5a100", "#d7ba7d", "#c08b30", "#ffd700"]; // {} gold
const ROUND_COLORS = ["#569cd6", "#4fc1ff", "#0078d4", "#9cdcfe"]; // () blue
const SQUARE_COLORS = ["#c586c0", "#da70d6", "#d16969", "#ce9178"]; // [] pink

const OPEN_COLORS: Record<string, string[]> = {
  "{": CURLY_COLORS,
  "(": ROUND_COLORS,
  "[": SQUARE_COLORS,
};
const CLOSE_COLORS: Record<string, string[]> = {
  "}": CURLY_COLORS,
  ")": ROUND_COLORS,
  "]": SQUARE_COLORS,
};
const CLOSE_TO_OPEN: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

export function colorizeBracketsHtml(html: string): string {
  const depths: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
  let stringSpanDepth = 0;
  const spanStack: boolean[] = []; // true 表示该 span 为字符串 span
  const parts: string[] = [];
  const boundary = /[<{}()[\]&]/g;
  let i = 0;

  while (i < html.length) {
    const ch = html[i];

    // 追踪 HTML 标签以检测 hljs-string 片段
    if (ch === "<") {
      const closeTag = html.startsWith("</span", i);
      if (closeTag) {
        const end = html.indexOf(">", i);
        parts.push(html.slice(i, end + 1));
        i = end + 1;
        const wasString = spanStack.pop();
        if (wasString) stringSpanDepth--;
        continue;
      }
      const spanMatch = html.startsWith("<span", i);
      if (spanMatch) {
        const end = html.indexOf(">", i);
        const tag = html.slice(i, end + 1);
        const isString = tag.includes("hljs-string") || tag.includes("hljs-regexp");
        spanStack.push(isString);
        if (isString) stringSpanDepth++;
        parts.push(tag);
        i = end + 1;
        continue;
      }
      // Other tags and their attributes are opaque to bracket coloring.
      const end = html.indexOf(">", i);
      if (end === -1) {
        parts.push(html.slice(i));
        break;
      }
      parts.push(html.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    // Strings and regexp literals only need tag boundaries; ordinary code runs
    // only need bracket/entity/tag boundaries. Copy each run instead of each character.
    if (stringSpanDepth > 0) {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      parts.push(html.slice(i, end));
      i = end;
      continue;
    }
    boundary.lastIndex = i;
    const next = boundary.exec(html)?.index ?? html.length;
    if (next > i) {
      parts.push(html.slice(i, next));
      i = next;
      continue;
    }

    // 处理括号的 HTML 实体
    let bracket: string | null = null;
    let consumed = 1;
    if (ch === "{" || ch === "}" || ch === "(" || ch === ")" || ch === "[" || ch === "]") {
      bracket = ch;
    } else if (html.startsWith("&lbrace;", i)) {
      bracket = "{";
      consumed = 8;
    } else if (html.startsWith("&rbrace;", i)) {
      bracket = "}";
      consumed = 8;
    }

    if (bracket && bracket in OPEN_COLORS) {
      const colors = OPEN_COLORS[bracket];
      const depth = depths[bracket];
      const color = colors[depth % colors.length];
      parts.push(
        `<span style="color:${color};font-weight:bold">${html.slice(i, i + consumed)}</span>`,
      );
      depths[bracket]++;
      i += consumed;
    } else if (bracket && bracket in CLOSE_COLORS) {
      const openCh = CLOSE_TO_OPEN[bracket];
      depths[openCh] = Math.max(0, depths[openCh] - 1);
      const colors = CLOSE_COLORS[bracket];
      const depth = depths[openCh];
      const color = colors[depth % colors.length];
      parts.push(
        `<span style="color:${color};font-weight:bold">${html.slice(i, i + consumed)}</span>`,
      );
      i += consumed;
    } else {
      parts.push(ch);
      i++;
    }
  }
  return parts.join("");
}

/**
 * Highlight code with rainbow brackets. Returns HTML string or null on failure.
 */
export function highlightCode(code: string, language?: string): string | null {
  // Explicit plain text has no grammar. Keep the same escaping and rainbow brackets.
  if (isPlainLanguage(language))
    return colorizeBracketsHtml(
      code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;"),
    );
  if (!_hljs) return null;
  try {
    const result =
      language && _hljs.getLanguage(language)
        ? _hljs.highlight(code, { language })
        : _hljs.highlightAuto(code);
    return colorizeBracketsHtml(result.value);
  } catch {
    return null;
  }
}

/** HTML-safe plain lines without running the optional syntax highlighter. */
export function plainCodeLines(code: string): string[] {
  return code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").split("\n");
}

export function highlightCodeLines(code: string, language?: string): string[] {
  const html = highlightCode(code, language);
  return html === null ? plainCodeLines(code) : html.split("\n");
}
