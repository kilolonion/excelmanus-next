import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/backend/api";
import { fetchWorkspaceFile } from "@/stores/files-store";

/** 带鉴权取工作区图片，转 object URL；文件变化（version）后重新读取。 */
export function useWorkspaceImage(
  path: string,
  enabled: boolean,
  version: number,
  attempt: number,
) {
  const key = JSON.stringify([path, version, attempt]);
  const [state, setState] = useState<{
    key: string;
    blobUrl: string | null;
    loading: boolean;
    error: string;
  }>({
    key: "",
    blobUrl: null,
    loading: false,
    error: "",
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ key, blobUrl: null, loading: true, error: "" });
    fetchWorkspaceFile(path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ key, blobUrl: url, loading: false, error: "" });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            key,
            blobUrl: null,
            loading: false,
            error: errorMessage(err, "图片加载失败"),
          });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, enabled, key]);
  return enabled && state.key === key ? state : { blobUrl: null, loading: enabled, error: "" };
}
