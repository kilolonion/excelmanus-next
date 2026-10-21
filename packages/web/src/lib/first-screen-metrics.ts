// QA-only measurement. No observer, storage access or transport unless explicitly enabled.
type MetricName =
  | "navigation"
  | "resource"
  | "fcp"
  | "lcp"
  | "longtask"
  | "boot-start"
  | "backend-connected"
  | "bootstrap-ready"
  | "workspace-ready"
  | "splash-commit-raf"
  | "splash-hidden-raf"
  | "content-commit-raf";
type Route =
  | "document"
  | "asset"
  | "auth"
  | "bootstrap"
  | "workspaces"
  | "sessions"
  | "history"
  | "profiles"
  | "settings"
  | "sync"
  | "other-api";
interface Observation {
  name: MetricName;
  startTime: number;
  duration: number;
  route?: Route;
}
interface Entry {
  entryType: string;
  name: string;
  startTime: number;
  duration: number;
}
interface Payload {
  runId: string;
  sessionId: string;
  observations: Observation[];
}
interface Environment {
  now(): number;
  origin: string;
  runId(): string;
  observe(
    type: string,
    receive: (entries: Entry[]) => void,
  ): { disconnect(): void; takeRecords(): Entry[] };
  entries(type: string): Entry[];
  raf(cb: () => void): number;
  cancelRaf(id: number): void;
  timeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  send(payload: Payload): void;
}

export function classifyResource(raw: string, origin: string): Route | null {
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const path = url.pathname;
  if (path === "/" || path === "/index.html") return "document";
  if (path.startsWith("/assets/")) return "asset";
  if (!path.startsWith("/api/v1/")) return null;
  if (/^\/api\/v1\/sessions\/[^/]+\/(log|history)/.test(path)) return "history";
  if (path.startsWith("/api/v1/auth/")) return "auth";
  if (path === "/api/v1/bootstrap") return "bootstrap";
  if (path.startsWith("/api/v1/workspaces")) return "workspaces";
  if (path.startsWith("/api/v1/sessions")) return "sessions";
  if (path.startsWith("/api/v1/model-profiles")) return "profiles";
  if (path.startsWith("/api/v1/settings")) return "settings";
  if (path.startsWith("/api/v1/sync")) return "sync";
  return "other-api";
}

export function createFirstScreenMetrics(
  enabled: boolean,
  target: string | null,
  env: Environment,
) {
  if (!enabled || !target || target.length > 128) return null;
  let stopped = false;
  let sent = false;
  const observations: Observation[] = [];
  const stops: { disconnect(): void; takeRecords(): Entry[] }[] = [];
  const seen = new Set<string>();
  let resources = 0;
  let longtasks = 0;
  const marked = new Set<MetricName>();
  const add = (value: Observation) => {
    if (
      stopped ||
      observations.length >= 270 ||
      seen.size >= 1000 ||
      !Number.isFinite(value.startTime) ||
      !Number.isFinite(value.duration) ||
      value.startTime < 0 ||
      value.duration < 0 ||
      value.startTime > 30000 ||
      value.duration > 30000
    )
      return;
    const key = JSON.stringify(value);
    if (seen.has(key)) return;
    if (value.name === "resource" && resources++ >= 200) return;
    if (value.name === "longtask" && longtasks++ >= 50) return;
    if (value.name === "lcp") {
      const previous = observations.findIndex((entry) => entry.name === "lcp");
      if (previous >= 0) observations.splice(previous, 1);
    }
    seen.add(key);
    observations.push(value);
  };
  const receive = (entries: Entry[]) => {
    for (const entry of entries) {
      if (entry.entryType === "resource") {
        const route = classifyResource(entry.name, env.origin);
        if (route)
          add({ name: "resource", startTime: entry.startTime, duration: entry.duration, route });
      } else if (entry.entryType === "navigation") {
        add({ name: "navigation", startTime: entry.startTime, duration: entry.duration });
      } else if (entry.entryType === "paint" && entry.name === "first-contentful-paint") {
        add({ name: "fcp", startTime: entry.startTime, duration: 0 });
      } else if (entry.entryType === "largest-contentful-paint") {
        add({ name: "lcp", startTime: entry.startTime, duration: 0 });
      } else if (entry.entryType === "longtask") {
        add({ name: "longtask", startTime: entry.startTime, duration: entry.duration });
      }
    }
  };
  for (const type of ["resource", "paint", "largest-contentful-paint", "longtask"]) {
    try {
      stops.push(env.observe(type, receive));
    } catch {
      /* unsupported is missing, never zero */
    }
  }
  const stop = () => {
    stopped = true;
    for (const observer of stops) observer.disconnect();
  };
  const timer = env.timeout(stop, 30000);
  return {
    mark(name: MetricName) {
      if (marked.has(name)) return;
      marked.add(name);
      add({ name, startTime: env.now(), duration: 0 });
    },
    correct(sessionId: string | null, stillCorrect: () => boolean) {
      if (stopped || sent || sessionId !== target) return () => {};
      let cancelled = false;
      let id = 0;
      const observeCommit = () => {
        if (cancelled || stopped || sent) return;
        if (!stillCorrect()) {
          id = env.raf(observeCommit);
          return;
        }
        for (const observer of stops) receive(observer.takeRecords());
        receive(env.entries("navigation"));
        add({ name: "content-commit-raf", startTime: env.now(), duration: 0 });
        const payload = { runId: env.runId(), sessionId: target, observations };
        sent = true;
        stop();
        env.clearTimeout(timer);
        if (new TextEncoder().encode(JSON.stringify(payload)).length <= 32768) env.send(payload);
      };
      id = env.raf(observeCommit);
      return () => {
        cancelled = true;
        env.cancelRaf(id);
      };
    },
  };
}

export let firstScreenMetrics: ReturnType<typeof createFirstScreenMetrics> = null;

export function startFirstScreenMetrics(enabled: boolean, send: Environment["send"]) {
  if (!enabled || firstScreenMetrics) return;
  // Only set in an independently approved QA browser context, never the restricted cloud browser.
  let target: string | null;
  try {
    target = sessionStorage.getItem("excelmanus.qa.first-screen.session");
  } catch {
    return;
  }
  if (!target) return;
  firstScreenMetrics = createFirstScreenMetrics(true, target, {
    now: () => performance.now(),
    origin: location.origin,
    runId: () => crypto.randomUUID(),
    observe: (type, receive) => {
      const observer = new PerformanceObserver((list) => receive(list.getEntries()));
      observer.observe({ type, buffered: true });
      return { disconnect: () => observer.disconnect(), takeRecords: () => observer.takeRecords() };
    },
    entries: (type) => performance.getEntriesByType(type),
    raf: (cb) => requestAnimationFrame(cb),
    cancelRaf: (id) => cancelAnimationFrame(id),
    timeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    send,
  });
}
