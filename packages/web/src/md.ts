// Markdown → 受信 HTML：marked 解析后按标签白名单消毒（不带 dompurify，避免 MPL 依赖）。

import { parseRange } from "@excelmanus/core";
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
  const linkRanges = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        const pattern =
          /(?<![\p{L}\p{N}_])(?:(?:'(?:[^']|'')+'|[\p{L}\p{N}_.-]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?(?![\p{L}\p{N}_:])/gu;
        const fragment = doc.createDocumentFragment();
        let offset = 0;
        for (const match of text.matchAll(pattern)) {
          const range = match[0].replaceAll("$", "");
          try {
            parseRange(range);
          } catch {
            continue;
          }
          fragment.append(doc.createTextNode(text.slice(offset, match.index)));
          const a = doc.createElement("a");
          a.href = `#range=${encodeURIComponent(range)}`;
          a.textContent = match[0];
          fragment.append(a);
          offset = match.index + match[0].length;
        }
        if (offset > 0) {
          fragment.append(doc.createTextNode(text.slice(offset)));
          child.replaceWith(fragment);
        }
      } else if (child instanceof Element && !["A", "PRE"].includes(child.tagName)) {
        linkRanges(child);
      }
    }
  };
  linkRanges(doc.body);
  return doc.body.innerHTML;
}

export function renderMarkdown(text: string): string {
  return sanitize(marked.parse(text, { async: false }));
}

export function renderPlainText(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return sanitize(el.innerHTML);
}
