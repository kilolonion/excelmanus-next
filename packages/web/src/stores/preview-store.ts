// 文本/图片预览弹窗：只挂一次，所有入口走 openWorkspaceFile。
import { create } from "zustand";
import { fileName } from "@/lib/paths";

export interface PreviewTarget {
  path: string;
  filename: string;
}

interface PreviewState {
  text: PreviewTarget | null;
  image: PreviewTarget | null;
  /** 最近预览过的文本文件，供弹窗内切换。 */
  recent: PreviewTarget[];
}

export const usePreviewStore = create<PreviewState>()(() => ({
  text: null,
  image: null,
  recent: [],
}));

export function openTextPreview(path: string): void {
  const target = { path, filename: fileName(path) };
  usePreviewStore.setState((s) => ({
    text: target,
    image: null,
    recent: [...s.recent.filter((r) => r.path !== path), target].slice(-10),
  }));
}

export function openImagePreview(path: string): void {
  usePreviewStore.setState({ image: { path, filename: fileName(path) }, text: null });
}

export function closePreview(): void {
  usePreviewStore.setState({ text: null, image: null });
}
