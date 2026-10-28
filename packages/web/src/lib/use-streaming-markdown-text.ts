import { useEffect, useRef, useState } from "react";

const LARGE_MARKDOWN_CHARACTERS = 20_000;
const DISPLAY_INTERVAL_MS = 150;

/** Coalesce only long, growing live text. Final/replacement content is always immediate. */
export function useStreamingMarkdownText(content: string, streaming: boolean): string {
  const [buffered, setBuffered] = useState<string | null>(null);
  const immediate = useRef(content);
  const previous = useRef(content);
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batching = streaming && content.length > LARGE_MARKDOWN_CHARACTERS;
  const candidate =
    buffered !== null && buffered.length >= immediate.current.length ? buffered : immediate.current;
  const growing = content.startsWith(previous.current);
  const displayed = batching && growing && content.startsWith(candidate) ? candidate : content;

  useEffect(() => {
    const replaced = !growing;
    previous.current = content;
    latest.current = content;
    if (!batching || replaced || content === displayed) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (!batching || replaced) {
        immediate.current = content;
        if (buffered !== null) setBuffered(null);
      }
      return;
    }
    // Keep the original deadline while more deltas arrive; a debounce could starve the display.
    if (timer.current === null)
      timer.current = setTimeout(() => {
        timer.current = null;
        setBuffered(latest.current);
      }, DISPLAY_INTERVAL_MS);
  }, [content, batching, displayed, buffered, growing]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return displayed;
}
