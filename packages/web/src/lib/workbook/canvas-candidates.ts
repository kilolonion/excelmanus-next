/** Reuse canvas discovery between DOM changes; sizes remain live during resize/zoom. */
export function trackCanvasCandidates(host: HTMLElement) {
  let canvases: NodeListOf<HTMLCanvasElement> | undefined;
  let dirty = true;
  let disposed = false;
  const observer = new MutationObserver(() => {
    dirty = true;
  });
  observer.observe(host, { childList: true, subtree: true });
  return {
    current() {
      if (disposed) return undefined;
      if (dirty) {
        canvases = host.querySelectorAll<HTMLCanvasElement>("canvas");
        dirty = false;
      }
      let largest: HTMLCanvasElement | undefined;
      let height = -1;
      for (const canvas of canvases ?? []) {
        const nextHeight = canvas.clientHeight;
        if (nextHeight > height) {
          largest = canvas;
          height = nextHeight;
        }
      }
      return largest;
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      canvases = undefined;
    },
  };
}
