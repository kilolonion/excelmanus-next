// Markdown → DOMPurify 消毒 → 区域引用 → 最终消毒。

import { parseRange } from "@excelmanus/core";
import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
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
  ],
  ALLOWED_ATTR: ["href", "class"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|#|\.?\/)/i,
};

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class" && !/^language-[\w-]+$/.test(data.attrValue)) {
    data.keepAttr = false;
  }
  if (data.attrName === "href" && node.nodeName !== "A") {
    data.keepAttr = false;
  }
});

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(
    DOMPurify.sanitize(html, SANITIZE_CONFIG),
    "text/html",
  );
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
  return DOMPurify.sanitize(doc.body.innerHTML, SANITIZE_CONFIG);
}

export function renderMarkdown(text: string): string {
  return sanitize(marked.parse(text, { async: false }));
}

export function renderPlainText(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return sanitize(el.innerHTML);
}
