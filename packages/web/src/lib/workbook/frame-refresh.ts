/** Coalesce display-only model notifications; callers keep their initial read synchronous. */
export function createFrameRefresh(read: () => void) {
  let frame: number | undefined;
  let disposed = false;
  return {
    schedule() {
      if (disposed || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!disposed) read();
      });
    },
    dispose() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}
