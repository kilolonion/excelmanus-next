// Medium code can already spend hundreds of milliseconds in grammar auto-detection.
// Keep both chat and file previews responsive while the optional worker prepares colors.
export const HIGHLIGHT_WORKER_THRESHOLD = 20_000;
