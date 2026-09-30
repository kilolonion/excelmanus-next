// Markdown → 受信 HTML：marked 解析后按标签白名单消毒（不带 dompurify，避免 MPL 依赖）。

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

const ALLOWED_TAGS = new Set([
  "P",
  "BR",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "S",
  "DEL",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "CODE",
  "HR",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "A",
  "SPAN",
]);

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Element | ChildNode): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (!ALLOWED_TAGS.has(el.tagName)) {
          // 未知标签：只保留纯文本（不保留子元素，避免嵌套的危险元素绕过消毒）
          el.replaceWith(doc.createTextNode(el.textContent ?? ""));
          continue;
        }
        for (const attr of [...el.attributes]) {
          const n = attr.name.toLowerCase();
          const v = attr.value;
          const ok =
            el.tagName === "A" && n === "href" && /^https?:|^#|^\.?\//.test(v.trim())
              ? true
              : n === "class" && /^language-[\w-]+$/.test(v);
          if (!ok) el.removeAttribute(attr.name);
        }
        walk(el);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function renderMarkdown(text: string): string {
  return sanitize(marked.parse(text, { async: false }));
}
