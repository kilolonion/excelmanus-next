import type { ReactNode } from "react";
import { classifyWorkspaceFile } from "@/lib/file-kind";
import { openWorkspaceFile } from "@/lib/open-file";
import { FilePathLink, isFilePath } from "./FilePathLink";
import { extractMentions, mentionLabel } from "./mention-tokens";

interface MentionHighlighterProps {
  text: string;
  className?: string;
}

const CAPSULE =
  "inline-flex items-center max-w-[220px] rounded-full px-1.5 py-0 text-[11px] font-medium leading-4 align-middle";
const CAPSULE_STYLE = {
  backgroundColor: "color-mix(in srgb, var(--em-primary) 14%, transparent)",
  color: "var(--em-primary)",
};

/** 把消息中的 `@文件` 渲染为可点击胶囊，裸文件路径渲染为链接。 */
export function MentionHighlighter({ text, className }: MentionHighlighterProps) {
  const tokens = extractMentions(text).filter(
    (token) => token.kind !== "path" || isFilePath(token.value),
  );
  if (tokens.length === 0) return <span className={className}>{text}</span>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor)
      parts.push(<span key={`t-${cursor}`}>{text.slice(cursor, token.start)}</span>);
    if (token.kind === "path") {
      parts.push(
        <FilePathLink key={`m-${token.start}`} filePath={token.value} variant="text">
          {token.raw}
        </FilePathLink>,
      );
    } else {
      const kind = classifyWorkspaceFile(token.value);
      const label = mentionLabel(token);
      const open = () => openWorkspaceFile(token.value);
      parts.push(
        <span
          key={`m-${token.start}`}
          className={`${CAPSULE} cursor-pointer hover:opacity-80`}
          style={CAPSULE_STYLE}
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
          aria-label={kind === "spreadsheet" ? `在工作台打开 ${label}` : `打开 ${label}`}
        >
          <span className="truncate">{label}</span>
        </span>,
      );
    }
    cursor = token.end;
  }
  if (cursor < text.length) parts.push(<span key={`t-${cursor}`}>{text.slice(cursor)}</span>);
  return <span className={className}>{parts}</span>;
}
