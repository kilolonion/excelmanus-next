import { Check, Copy } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { HIGHLIGHT_WORKER_THRESHOLD } from "@/lib/highlight-policy";
import { ensureHljs, highlightCode } from "@/lib/hljs-utils";

interface CodeBlockProps {
  label?: string;
  language?: string;
  code: string;
  maxHeightClass?: string;
  streaming?: boolean;
}

export const CodeBlock = React.memo(function CodeBlock({
  label,
  language,
  code,
  maxHeightClass,
  streaming = false,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language?: string;
    html: string | null;
  } | null>(null);
  const highlightedHtml =
    !streaming && highlighted?.code === code && highlighted.language === language
      ? highlighted.html
      : null;
  const codeRef = useRef<HTMLElement>(null);

  // 流式代码先显示原文；完整大代码沿用预览 Worker，避免主线程全文高亮。
  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    let worker: Worker | null = null;
    const complete = (html: string | null) => {
      if (!cancelled) setHighlighted({ code, language, html });
    };
    if (code.length >= HIGHLIGHT_WORKER_THRESHOLD) {
      try {
        worker = new Worker(new URL("../../lib/preview-highlight.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<string | null>) => {
          if (!cancelled) complete(event.data);
          worker?.terminate();
          worker = null;
        };
        worker.onerror = () => {
          worker?.terminate();
          worker = null;
        };
        worker.postMessage({ code, language: language ?? "", output: "html" });
      } catch {
        worker?.terminate();
        worker = null;
      }
    } else {
      ensureHljs(language).then(() => {
        if (!cancelled) complete(highlightCode(code, language));
      });
    }
    return () => {
      cancelled = true;
      worker?.terminate();
      worker = null;
    };
  }, [code, language, streaming]);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [code]);

  const displayLang = language || "code";

  return (
    <div className="code-block group/code relative my-2 min-w-0 rounded-lg overflow-hidden border border-border/50">
      {/* 标题栏 */}
      <div className="code-block-header flex items-center justify-between gap-2 px-3 py-1.5 bg-muted border-b border-border/40">
        <div className="flex min-w-0 items-center gap-2 select-none">
          {label && <span className="text-[11px] font-medium text-foreground">{label}</span>}
          <span
            className={`${label ? "text-[10px]" : "text-[11px]"} font-medium text-muted-foreground font-mono`}
          >
            {displayLang}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded-md px-2 py-1 hover:bg-muted/60 h-8"
          aria-label={copied ? "已复制" : label ? `复制${label}` : "复制代码"}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" />
              <span className="text-emerald-500">已复制</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span className="hidden sm:inline">复制</span>
            </>
          )}
        </button>
      </div>

      {/* 代码主体 */}
      <div className={`code-block-scroll overflow-auto bg-card ${maxHeightClass ?? ""}`}>
        <pre className="!m-0 !rounded-none !bg-transparent p-3">
          {highlightedHtml ? (
            <code
              ref={codeRef}
              className={`hljs text-[11px] sm:text-[12.5px] leading-relaxed font-mono ${language ? `language-${language}` : ""}`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <code
              ref={codeRef}
              className="text-[11px] sm:text-[12.5px] leading-relaxed font-mono text-foreground"
            >
              {code}
            </code>
          )}
        </pre>
      </div>
    </div>
  );
});
