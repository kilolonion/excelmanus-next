import "@/app/globals.css";

// Frozen browser captures must branch before app, theme, metrics, or backend boot.
if (new URLSearchParams(window.location.search).get("capture") === "1") {
  void import("@/components/excel/WorkbookCaptureView").then(({ startWorkbookCapturePage }) =>
    startWorkbookCapturePage(),
  );
} else {
  void (async () => {
    const [
      { StrictMode, createElement },
      { createRoot },
      { Root },
      { startRendererOnly },
      { applyTheme },
      { api },
      { startFirstScreenMetrics },
    ] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("@/app/Root"),
      import("@/lib/backend/channel"),
      import("@/lib/theme"),
      import("@/lib/backend/api"),
      import("@/lib/first-screen-metrics"),
    ]);
    startFirstScreenMetrics(import.meta.env.VITE_QA_FIRST_SCREEN_METRICS === "1", (payload) => {
      void api()
        .reportFirstScreenMetrics(payload)
        .catch(() => undefined);
    });
    applyTheme();
    if (new URLSearchParams(window.location.search).get("renderer") === "1") {
      void startRendererOnly();
    } else {
      const el = document.getElementById("root");
      if (!el) throw new Error("缺少 #root");
      createRoot(el).render(createElement(StrictMode, null, createElement(Root)));
    }
  })();
}
