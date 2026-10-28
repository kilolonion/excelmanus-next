// 文本/图片预览弹窗：只挂一次，所有入口走 openWorkspaceFile。
import { create } from "zustand";
import { api, errorMessage } from "@/lib/backend/api";
import { fileName } from "@/lib/paths";
import { useSessionStore } from "@/stores/session-store";

export interface PreviewTarget {
  path: string;
  filename: string;
  generation?: number;
}

interface TextContent {
  workspaceId: string;
  path: string;
  content: string;
  loading: boolean;
  error: string;
}
interface PreviewState {
  textContent: TextContent | null;
  text: PreviewTarget | null;
  image: PreviewTarget | null;
  /** 最近预览过的文本文件，供弹窗内切换。 */
  recent: PreviewTarget[];
}

export const usePreviewStore = create<PreviewState>()(() => ({
  textContent: null,
  text: null,
  image: null,
  recent: [],
}));

export function openTextPreview(path: string): void {
  textRequest += 1;
  const target = { path, filename: fileName(path), generation: textRequest };
  usePreviewStore.setState((s) => ({
    textContent: null,
    text: target,
    image: null,
    recent: [...s.recent.filter((r) => r.path !== path), target].slice(-10),
  }));
  const retained = new Set(usePreviewStore.getState().recent.map((item) => item.path));
  for (const cachedPath of textCache.keys()) {
    if (!retained.has(cachedPath)) textCache.delete(cachedPath);
  }
}

export function openImagePreview(path: string): void {
  textRequest += 1;
  usePreviewStore.setState({
    textContent: null,
    image: { path, filename: fileName(path) },
    text: null,
  });
}

export function closePreview(): void {
  textRequest += 1;
  textCache.clear();
  usePreviewStore.setState({ textContent: null, text: null, image: null });
}

let textRequest = 0;
let cacheScope = "";
const textCache = new Map<string, string>();
const MAX_TEXT_CACHE_BYTES = 32 * 1024 * 1024;

function retainText(path: string, content: string): void {
  // Count UTF-16 code units conservatively; the active view still owns its complete text.
  if (content.length * 2 > MAX_TEXT_CACHE_BYTES) return;
  textCache.delete(path);
  textCache.set(path, content);
  let bytes = 0;
  for (const text of textCache.values()) bytes += text.length * 2;
  while (bytes > MAX_TEXT_CACHE_BYTES || textCache.size > 10) {
    const oldest = textCache.keys().next().value!;
    bytes -= textCache.get(oldest)!.length * 2;
    textCache.delete(oldest);
  }
}

/** Only the current text selection may publish its response, including errors. */
export async function loadTextPreview(
  workspaceId: string,
  path: string,
  version: number,
): Promise<void> {
  const request = ++textRequest;
  const scope = JSON.stringify([workspaceId, version]);
  if (cacheScope !== scope) {
    textCache.clear();
    cacheScope = scope;
  }
  const cached = textCache.get(path);
  usePreviewStore.setState({
    textContent: {
      workspaceId,
      path,
      content: cached ?? "",
      loading: cached === undefined,
      error: "",
    },
  });
  if (cached !== undefined) {
    textCache.delete(path);
    textCache.set(path, cached);
    return;
  }
  try {
    const blob = await api().downloadFile(workspaceId, path);
    if (request !== textRequest) return;
    const content = await blob.text();
    if (request !== textRequest) return;
    retainText(path, content);
    usePreviewStore.setState({
      textContent: { workspaceId, path, content, loading: false, error: "" },
    });
  } catch (error) {
    if (request !== textRequest) return;
    usePreviewStore.setState({
      textContent: {
        workspaceId,
        path,
        content: "",
        loading: false,
        error: errorMessage(error, "读取文件失败"),
      },
    });
  }
}

useSessionStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  closePreview();
  usePreviewStore.setState({ recent: [] });
});
