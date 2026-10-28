import { useEffect, useMemo, useRef, useState } from "react";
import { createPreviewLineSearch, type PreviewMatches } from "./preview-line-search";
import type { TextLines } from "./text-lines";

const LARGE_SEARCH_CHARACTERS = 1_000_000;
const EMPTY: number[] = [];
type SearchRequest = { id: number; query: string; complete: (matches: PreviewMatches) => void };
type SearchWorker = {
  content: string;
  worker: Worker;
  busy: SearchRequest | null;
  queued: SearchRequest | null;
  fail: () => void;
};

function dispatchSearch(owned: SearchWorker) {
  if (owned.busy || !owned.queued) return;
  const request = owned.queued;
  owned.queued = null;
  owned.busy = request;
  try {
    owned.worker.postMessage({ type: "search", id: request.id, query: request.query });
  } catch {
    owned.fail();
  }
}

export function usePreviewSearch(content: string, query: string, lines: string[] | TextLines) {
  const [result, setResult] = useState<{
    content: string;
    query: string;
    matches: PreviewMatches;
  } | null>(null);
  const localSearch = useMemo(() => createPreviewLineSearch(lines), [lines]);
  const owned = useRef<SearchWorker | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    const stop = () => {
      owned.current?.worker.terminate();
      owned.current = null;
    };
    const id = ++sequence.current;
    let active = true;
    const complete = (matches: PreviewMatches) => {
      if (active) setResult({ content, query, matches });
    };
    if (!query.trim() || !content) {
      stop();
      setResult(null);
    } else if (content.length < LARGE_SEARCH_CHARACTERS) {
      stop();
      complete(localSearch(query));
    } else {
      try {
        if (owned.current?.content !== content) {
          stop();
          const worker = new Worker(new URL("./preview-search.worker.ts", import.meta.url), {
            type: "module",
          });
          const current: SearchWorker = {
            content,
            worker,
            busy: null,
            queued: null,
            fail: () => {},
          };
          owned.current = current;
          worker.onmessage = (event: MessageEvent<{ id: number; matches: PreviewMatches }>) => {
            if (owned.current !== current || current.busy?.id !== event.data.id) return;
            const completed = current.busy;
            current.busy = null;
            completed.complete(event.data.matches);
            dispatchSearch(current);
          };
          worker.onerror = () => {
            if (owned.current === current) current.fail();
          };
          worker.postMessage({ type: "init", content });
        }
        const current = owned.current;
        current.fail = () => {
          if (!active) return;
          stop();
          complete(localSearch(query));
        };
        // An in-flight scan finishes; subsequent input replaces only the unsent query.
        current.queued = { id, query, complete };
        dispatchSearch(current);
      } catch {
        stop();
        complete(localSearch(query));
      }
    }
    return () => {
      active = false;
    };
  }, [content, query, localSearch]);
  useEffect(
    () => () => {
      owned.current?.worker.terminate();
      owned.current = null;
    },
    [],
  );

  const matches = result?.content === content && result.query === query ? result.matches : EMPTY;
  const pending =
    !!content && !!query.trim() && (result?.content !== content || result.query !== query);
  return { matches, pending };
}
