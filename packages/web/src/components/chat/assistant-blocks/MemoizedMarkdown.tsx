import { ChevronDown, ChevronUp } from "lucide-react";
import React, { useDeferredValue, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isWorkspaceFileHref } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { decodeUriEscapedPath, fileName } from "@/lib/paths";
import { useStreamingMarkdownText } from "@/lib/use-streaming-markdown-text";
import { baseMarkdownComponents } from "../MarkdownComponents";
import { MentionHighlighter } from "../MentionHighlighter";

/**
 * Recursively process React children: replace plain string nodes
 * with MentionHighlighter so @mentions get blue-highlighted.
 */
function processChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === "string") {
      return <MentionHighlighter text={child} />;
    }
    return child;
  });
}

const remarkPluginsStable = [remarkGfm];

function isWorkspaceFileLink(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("./") || href.startsWith("../") || !href.includes("://")) {
    return isWorkspaceFileHref(href);
  }
  return false;
}

function WorkspaceFileLink({ href, children }: { href: string; children: React.ReactNode }) {
  const filename = fileName(href) || href;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        openWorkspaceFile(href);
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium cursor-pointer transition-all border border-[var(--em-primary-alpha-15)] bg-[var(--em-primary-alpha-06)] hover:bg-[var(--em-primary-alpha-15)] hover:border-[var(--em-primary-alpha-20)] text-[var(--em-primary)]"
      aria-label={`打开 ${filename}`}
    >
      <span className="break-all">{children}</span>
    </button>
  );
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  ...baseMarkdownComponents,
  p({ children }) {
    return <p>{processChildren(children)}</p>;
  },
  li({ children }) {
    return <li>{processChildren(children)}</li>;
  },
  // 拦截链接：工作区文件链接 → 预览/下载按钮，其他 → 普通 <a>
  a({ href, children }) {
    if (href && isWorkspaceFileLink(href)) {
      return <WorkspaceFileLink href={decodeUriEscapedPath(href)}>{children}</WorkspaceFileLink>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--em-primary)] underline"
      >
        {children}
      </a>
    );
  },
};

const MAX_COLLAPSED_HEIGHT_ASSISTANT = 400; // px
// Keep ordinary responses formatted; measured dense tables become expensive at this size.
const RAW_READING_CHARACTERS = 50_000;

const MarkdownBody = React.memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPluginsStable} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

export const MemoizedMarkdown = React.memo(function MemoizedMarkdown({
  content,
  isStreamingText,
  defaultExpanded,
}: {
  content: string;
  isStreamingText?: boolean;
  defaultExpanded?: boolean;
}) {
  const scheduledContent = useStreamingMarkdownText(content, !!isStreamingText);
  const deferredContent = useDeferredValue(scheduledContent);
  const renderedContent = isStreamingText ? deferredContent : content;
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [needsExpand, setNeedsExpand] = useState(false);
  const [formattedContent, setFormattedContent] = useState<string | null>(null);
  const large = content.length > RAW_READING_CHARACTERS;
  const showRaw = large && (!!isStreamingText || formattedContent !== content);

  useEffect(() => {
    if (formattedContent !== null && formattedContent !== content) setFormattedContent(null);
  }, [content, formattedContent]);

  useEffect(() => {
    // Streaming is never collapsed. Measure the final body after deferred text catches up.
    if (showRaw) setNeedsExpand(false);
    else if (!isStreamingText && contentRef.current) {
      setNeedsExpand(contentRef.current.scrollHeight > MAX_COLLAPSED_HEIGHT_ASSISTANT);
    }
  }, [content, isStreamingText, showRaw]);

  return (
    <div className="relative">
      {large && (
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>
            {showRaw
              ? isStreamingText
                ? "原文 · 输出完成后可排版阅读"
                : "长内容 · 原文预览"
              : "长内容 · 排版视图"}
          </span>
          <button
            type="button"
            disabled={!!isStreamingText}
            onClick={() => {
              setFormattedContent(showRaw ? content : null);
              if (showRaw) setExpanded(true);
            }}
            className="shrink-0 text-[var(--em-primary)] hover:underline disabled:cursor-wait disabled:opacity-50"
          >
            {showRaw ? "排版阅读" : "返回原文"}
          </button>
        </div>
      )}
      <div
        ref={contentRef}
        className={`prose prose-sm max-w-none text-foreground text-[13px] leading-relaxed transition-[max-height] duration-300${needsExpand && !expanded && !isStreamingText && !showRaw ? " overflow-hidden" : ""}${isStreamingText ? " streaming-cursor" : ""}`}
        style={{
          maxHeight:
            needsExpand && !expanded && !isStreamingText && !showRaw
              ? `${MAX_COLLAPSED_HEIGHT_ASSISTANT}px`
              : undefined,
        }}
      >
        {showRaw ? (
          <pre className="m-0 whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-[12px] leading-relaxed text-foreground">
            {renderedContent}
          </pre>
        ) : (
          <MarkdownBody content={renderedContent} />
        )}
      </div>
      {needsExpand && !expanded && !isStreamingText && !showRaw && (
        <div className="relative -mt-8 pt-8 bg-gradient-to-t from-background to-transparent">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1 py-1 text-[11px] text-[var(--em-primary)] hover:text-[var(--em-primary-dark)] transition-colors cursor-pointer"
          >
            <ChevronDown className="h-3 w-3" />
            展开全部
          </button>
        </div>
      )}
      {needsExpand && expanded && !isStreamingText && !showRaw && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 mt-1 py-1 text-[11px] text-[var(--em-primary)] hover:text-[var(--em-primary-dark)] transition-colors cursor-pointer"
        >
          <ChevronUp className="h-3 w-3" />
          收起
        </button>
      )}
    </div>
  );
});
