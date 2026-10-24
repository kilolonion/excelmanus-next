import { type ChildProcess, spawn } from "node:child_process";
import { chmod, chown, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbookCapturePacket, WorkbookCaptureReceipt } from "@excelmanus/protocol";

export interface WorkbookCaptureInput {
  packet: WorkbookCapturePacket;
  baseUrl: string;
  executablePath: string;
  signal?: AbortSignal;
}
export interface WorkbookCaptureResult {
  png: string;
  receipt: WorkbookCaptureReceipt;
}
interface BrowserIdentity {
  uid: number;
  gid: number;
}
interface BrowserLaunchPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  identity?: BrowserIdentity;
}

/** Pure launch policy; process identity is supplied only by the host, never the packet. */
export function workbookCaptureLaunchPlan(input: {
  executablePath: string;
  args: string[];
  profile: string;
  platform: string;
  uid?: number;
  euid?: number;
  gid?: number;
  egid?: number;
  browserUser?: string;
  passwd?: string;
}): BrowserLaunchPlan {
  const root = input.uid === 0 || input.euid === 0;
  const unchanged = { command: input.executablePath, args: input.args };
  if (input.browserUser === undefined && !root) return unchanged;
  if (input.browserUser !== "devspace")
    throw new Error("截图浏览器只支持显式配置 EXCELMANUS_BROWSER_USER=devspace；不会以 root 回退");
  if (input.platform !== "linux") throw new Error("截图浏览器 devspace 身份仅支持 Linux");
  const entries = (input.passwd ?? "").split("\n").filter((line) => line.startsWith("devspace:"));
  const fields = entries[0]?.split(":") ?? [];
  const uid = Number(fields[2]),
    gid = Number(fields[3]);
  if (
    entries.length !== 1 ||
    fields.length !== 7 ||
    !/^[1-9][0-9]*$/.test(fields[2] ?? "") ||
    !/^[1-9][0-9]*$/.test(fields[3] ?? "") ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid >= 0xffffffff ||
    gid >= 0xffffffff
  )
    throw new Error("截图浏览器需要现有且唯一的非 root devspace 账户");
  if (!root) {
    if (input.uid !== uid || input.euid !== uid || input.gid !== gid || input.egid !== gid)
      throw new Error("当前进程身份不是 devspace；不能切换截图浏览器身份");
    return unchanged;
  }
  if (!isAbsolute(input.executablePath)) throw new Error("降权截图浏览器必须配置可信绝对路径");
  return {
    command: "/usr/bin/setpriv",
    // libuv's spawn uid/gid ignores setgroups errors. setpriv fails before exec on any
    // requested identity/group change failure and preserves the existing private pipes.
    args: [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      input.executablePath,
      ...input.args,
    ],
    identity: { uid, gid },
    cwd: input.profile,
    env: {
      HOME: input.profile,
      XDG_CONFIG_HOME: input.profile,
      XDG_CACHE_HOME: input.profile,
      XDG_DATA_HOME: input.profile,
      XDG_RUNTIME_DIR: input.profile,
      TMPDIR: input.profile,
      TMP: input.profile,
      TEMP: input.profile,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  };
}

/** Check the host's own browser PID before navigation or workbook data injection. */
export function verifyWorkbookCaptureIdentity(status: string, identity: BrowserIdentity): void {
  const field = (name: string) =>
    new RegExp(`^${name}:[\\t ]*([^\\n]*)$`, "m").exec(status)?.[1]?.trim();
  const idsMatch = (name: string, expected: number) => {
    const values = field(name)?.split(/[\t ]+/);
    return (
      values?.length === 4 &&
      values.every((value) => /^\d+$/.test(value) && Number(value) === expected)
    );
  };
  const groups = field("Groups");
  if (
    !idsMatch("Uid", identity.uid) ||
    !idsMatch("Gid", identity.gid) ||
    groups === undefined ||
    (groups !== "" &&
      !groups
        .split(/[\t ]+/)
        .every((value) => /^\d+$/.test(value) && Number(value) === identity.gid)) ||
    !/^0+$/.test(field("CapEff") ?? "") ||
    !/^0+$/.test(field("CapAmb") ?? "")
  )
    throw new Error("截图浏览器身份验证失败；已拒绝截图");
}

interface ProtocolMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message?: string };
}
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const TOO_LARGE = "截图过大，请缩小range/viewport";
const FRAME_WAIT =
  "async function() { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; }";
const MOUNT = "async function(packet) { return await window.excelmanusCapture.mount(packet); }";
const NETWORK_GUARD = `(() => {
  const blocked = function() { throw new Error("截图页面禁止网络API"); };
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection"]) {
    Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false });
  }
  Object.defineProperty(navigator, "sendBeacon", { value: blocked, writable: false, configurable: false });
  Object.defineProperty(navigator, "serviceWorker", { value: undefined, writable: false, configurable: false });
})();`;

class BrowserCommandError extends Error {
  readonly transientNavigation: boolean;
  constructor(error: { code: number; message?: string }) {
    super(`截图浏览器命令失败（${error.code}）`);
    this.transientNavigation =
      /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(
        error.message ?? "",
      );
  }
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("截图已取消");
}

/** Controls only the newly spawned process, over its private fd 3/4. */
class BrowserPipe {
  private nextId = 0;
  private buffer = "";
  private failure?: Error;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly input: Writable;
  onEvent?: (message: ProtocolMessage) => Promise<void>;
  private readonly onAbort: () => void;
  private readonly signal: AbortSignal;

  constructor(child: ChildProcess, signal: AbortSignal, launchError?: string) {
    this.signal = signal;
    this.input = child.stdio[3] as Writable;
    const output = child.stdio[4] as Readable;
    this.onAbort = () => this.fail(aborted(signal));
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.input.on("error", () => this.fail(new Error("截图浏览器通信失败")));
    output.on("error", () => this.fail(new Error("截图浏览器通信失败")));
    child.once("error", () =>
      this.fail(new Error(launchError ?? "无法启动截图浏览器，请检查可执行文件配置")),
    );
    child.once("exit", () => this.fail(new Error(launchError ?? "截图浏览器已退出")));
    child.stderr?.on("data", (chunk: Buffer) => {
      if (
        /DevTools not allowed|Remote debugging.*disallowed|blocked.*policy|No usable sandbox/i.test(
          chunk.toString(),
        )
      )
        this.fail(new Error("截图浏览器受到沙箱或策略限制；不会绕过限制"));
    });
    output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 12 * 1024 * 1024) {
        this.fail(new Error(TOO_LARGE));
        return;
      }
      while (true) {
        const end = this.buffer.indexOf("\0");
        if (end < 0) break;
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!frame) continue;
        let message: ProtocolMessage;
        try {
          message = JSON.parse(frame) as ProtocolMessage;
        } catch {
          this.fail(new Error("截图浏览器返回了无效响应"));
          return;
        }
        if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          if (message.error) request.reject(new BrowserCommandError(message.error));
          else request.resolve(message.result ?? {});
        } else if (this.onEvent) {
          void this.onEvent(message).catch(() => this.fail(new Error("截图浏览器网络隔离失败")));
        }
      }
    });
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.signal.aborted) return Promise.reject(aborted(this.signal));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  dispose(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    this.fail(new Error("截图浏览器已关闭"));
    this.onEvent = undefined;
  }
}

function allowedRequest(url: string, method: string, resourceType: string, entry: URL): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (
    method !== "GET" ||
    target.origin !== entry.origin ||
    target.username ||
    target.password ||
    target.hash
  )
    return false;
  if (resourceType === "Document") return target.href === entry.href;
  if (
    target.search ||
    /%|\\/.test(target.pathname) ||
    !/^\/(?:assets|fonts)\/[a-zA-Z0-9_./-]+$/.test(target.pathname)
  )
    return false;
  const extensions: Record<string, RegExp> = {
    Script: /\.(?:js|mjs)$/i,
    Stylesheet: /\.css$/i,
    Font: /\.(?:woff2?|ttf|otf)$/i,
    Image: /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i,
  };
  return extensions[resourceType]?.test(target.pathname) ?? false;
}

function valueFrom(result: Record<string, unknown>): unknown {
  if (result.exceptionDetails) throw new Error("工作簿真实视图挂载失败");
  return (result.result as { value?: unknown } | undefined)?.value;
}
function checkedPng(value: unknown, packet: WorkbookCapturePacket): string {
  if (typeof value !== "string" || !value) throw new Error("截图浏览器未返回PNG");
  if (value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4) throw new Error(TOO_LARGE);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_PNG_BYTES) throw new Error(TOO_LARGE);
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("截图浏览器未返回有效PNG");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width * height > 1600 * 1200 * 4) throw new Error(TOO_LARGE);
  if (
    width !== Math.round(packet.viewport.width * packet.dpr) ||
    height !== Math.round(packet.viewport.height * packet.dpr)
  )
    throw new Error("截图PNG尺寸与固定视口不一致");
  return value;
}

async function stopBrowser(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGTERM");
  if (await Promise.race([closed.then(() => true), delay(400).then(() => false)])) return;
  child.kill("SIGKILL");
  await closed;
}

async function runCapture(
  input: WorkbookCaptureInput,
  signal: AbortSignal,
): Promise<WorkbookCaptureResult> {
  const parsed = WorkbookCapturePacket.safeParse(input.packet);
  if (!parsed.success) throw new Error("截图输入无效或超过范围/快照大小限制");
  const packet = parsed.data;
  const base = new URL(input.baseUrl);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("截图入口必须是无凭证的应用根地址");
  if (!input.executablePath) throw new Error("尚未配置截图浏览器");
  const entry = new URL("/?capture=1", base);
  signal.throwIfAborted();
  const uid = process.getuid?.(),
    euid = process.geteuid?.();
  const root = uid === 0 || euid === 0;
  const browserUser = process.env.EXCELMANUS_BROWSER_USER;
  const profile = await mkdtemp(join(root ? "/tmp" : tmpdir(), "excelmanus-capture-"));
  let child: ChildProcess | undefined;
  let pipe: BrowserPipe | undefined;
  let closed: Promise<void> | undefined;
  try {
    await chmod(profile, 0o700);
    const launch = workbookCaptureLaunchPlan({
      executablePath: input.executablePath,
      args: [
        "--headless",
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        `--window-size=${packet.viewport.width},${packet.viewport.height}`,
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      profile,
      platform: process.platform,
      uid,
      euid,
      gid: process.getgid?.(),
      egid: process.getegid?.(),
      browserUser,
      passwd:
        browserUser === "devspace"
          ? await readFile("/etc/passwd", { encoding: "utf8", signal }).catch(() => {
              signal.throwIfAborted();
              throw new Error("无法确认现有 devspace 账户；已拒绝截图");
            })
          : undefined,
    });
    // Only this invocation's fresh private directory changes ownership. Its mode stays
    // 0700, and the original host remains responsible for removing it in finally.
    if (launch.identity) await chown(profile, launch.identity.uid, launch.identity.gid);
    signal.throwIfAborted();
    child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      cwd: launch.cwd,
      env: launch.env,
    });
    closed = new Promise((resolve) => child?.once("close", () => resolve()));
    pipe = new BrowserPipe(
      child,
      signal,
      launch.identity
        ? "无法以 devspace 启动截图浏览器；请检查 /usr/bin/setpriv 和可信浏览器配置，不会以 root 回退"
        : undefined,
    );
    const browser = pipe;
    const context = await browser.command("Target.createBrowserContext", { disposeOnDetach: true });
    if (launch.identity) {
      try {
        if (!Number.isInteger(child.pid) || !child.pid || child.pid <= 0) throw new Error();
        const status = await readFile(`/proc/${child.pid}/status`, { encoding: "utf8", signal });
        verifyWorkbookCaptureIdentity(status, launch.identity);
      } catch {
        signal.throwIfAborted();
        throw new Error("截图浏览器身份验证失败；已拒绝截图");
      }
    }
    const target = await browser.command("Target.createTarget", {
      url: "about:blank",
      browserContextId: context.browserContextId,
    });
    const attached = await browser.command("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const session = String(attached.sessionId);
    browser.onEvent = async (message) => {
      const event = message.params ?? {};
      if (message.method === "Target.attachedToTarget") {
        const info = event.targetInfo as { targetId?: string } | undefined;
        if (info?.targetId)
          await browser.command("Target.closeTarget", { targetId: info.targetId });
        return;
      }
      if (message.sessionId !== session) return;
      if (message.method === "Fetch.authRequired") {
        await browser.command(
          "Fetch.continueWithAuth",
          { requestId: event.requestId, authChallengeResponse: { response: "CancelAuth" } },
          session,
        );
      } else if (message.method === "Fetch.requestPaused") {
        const request = event.request as {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
        const headers = event.responseHeaders as { name: string; value: string }[] | undefined;
        const location = headers?.find((header) => header.name.toLowerCase() === "location")?.value;
        const allowed =
          allowedRequest(request.url, request.method, String(event.resourceType), entry) &&
          (!location ||
            allowedRequest(
              new URL(location, request.url).href,
              "GET",
              String(event.resourceType),
              entry,
            ));
        if (!allowed) {
          await browser.command(
            "Fetch.failRequest",
            { requestId: event.requestId, errorReason: "BlockedByClient" },
            session,
          );
        } else if (event.responseStatusCode !== undefined) {
          await browser.command(
            "Fetch.continueResponse",
            {
              requestId: event.requestId,
              responseCode: event.responseStatusCode,
              responseHeaders: (headers ?? []).filter(
                (header) => !/^set-cookie$/i.test(header.name),
              ),
            },
            session,
          );
        } else {
          await browser.command(
            "Fetch.continueRequest",
            {
              requestId: event.requestId,
              headers: Object.entries(request.headers)
                .filter(([name]) => !/^(cookie|authorization|proxy-authorization)$/i.test(name))
                .map(([name, value]) => ({ name, value })),
            },
            session,
          );
        }
      }
    };
    await browser.command("Page.enable", {}, session);
    await browser.command("Network.enable", {}, session);
    await browser.command("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] }, session);
    await browser.command("Network.setBypassServiceWorker", { bypass: true }, session);
    await browser.command(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      session,
    );
    await browser.command(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "*", requestStage: "Response" },
        ],
        handleAuthRequests: true,
      },
      session,
    );
    await browser.command(
      "Emulation.setDeviceMetricsOverride",
      { ...packet.viewport, deviceScaleFactor: packet.dpr, mobile: false },
      session,
    );
    await browser.command(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: NETWORK_GUARD },
      session,
    );
    const navigation = await browser.command("Page.navigate", { url: entry.href }, session);
    if (navigation.errorText) throw new Error("截图页面加载失败；不会绕过浏览器安全限制");
    while (true) {
      try {
        const ready = await browser.command(
          "Runtime.evaluate",
          {
            expression: "typeof window.excelmanusCapture?.mount === 'function'",
            returnByValue: true,
          },
          session,
        );
        if (valueFrom(ready) === true) break;
      } catch (error) {
        if (!(error instanceof BrowserCommandError) || !error.transientNavigation) throw error;
      }
      await delay(50, undefined, { signal });
    }
    const page = await browser.command(
      "Runtime.evaluate",
      { expression: "window", returnByValue: false },
      session,
    );
    const objectId = (page.result as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error("截图页面没有可用的执行上下文");
    const mounted = await browser.command(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: MOUNT,
        arguments: [{ value: packet }],
        awaitPromise: true,
        returnByValue: true,
      },
      session,
    );
    const receiptResult = WorkbookCaptureReceipt.safeParse(valueFrom(mounted));
    if (!receiptResult.success) throw new Error("截图页面返回了无效视图回执");
    const receipt = receiptResult.data;
    if (
      receipt.docId !== packet.docId ||
      receipt.sheetId !== packet.sheetId ||
      receipt.rev !== packet.rev ||
      receipt.requestedRange !== packet.range ||
      receipt.viewport.width !== packet.viewport.width ||
      receipt.viewport.height !== packet.viewport.height ||
      receipt.dpr !== packet.dpr
    )
      throw new Error("截图视图回执与冻结工作簿不一致");
    let previous = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      valueFrom(
        await browser.command(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration: FRAME_WAIT, awaitPromise: true, returnByValue: true },
          session,
        ),
      );
      const shot = await browser.command(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, fromSurface: true },
        session,
      );
      const png = checkedPng(shot.data, packet);
      if (png === previous) return { png, receipt };
      previous = png;
    }
    throw new Error("截图视图尚未稳定，请稍后重试");
  } finally {
    pipe?.dispose();
    try {
      if (child && closed) await stopBrowser(child, closed);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
}

export interface WorkbookCaptureDriver {
  (input: WorkbookCaptureInput): Promise<WorkbookCaptureResult>;
  close(): Promise<void>;
}

/** Each driver admits one browser and at most two waiting captures. Deadline includes waiting. */
export function createWorkbookCaptureDriver(
  options: { timeoutMs?: number } = {},
): WorkbookCaptureDriver {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error("截图总超时必须在30秒以内");
  type Job = {
    start: () => void;
    started: boolean;
    controller: AbortController;
    done: Promise<void>;
  };
  const waiting: Job[] = [];
  const jobs = new Set<Job>();
  let active = false;
  let isClosed = false;
  const drain = () => {
    if (!active && !isClosed) waiting.shift()?.start();
  };
  const capture = ((input: WorkbookCaptureInput) =>
    new Promise<WorkbookCaptureResult>((resolve, reject) => {
      if (isClosed) {
        reject(new Error("截图服务已关闭"));
        return;
      }
      if (input.signal?.aborted) {
        reject(new Error("截图已取消"));
        return;
      }
      if (active && waiting.length >= 2) {
        reject(new Error("截图队列繁忙，请稍后重试"));
        return;
      }
      const controller = new AbortController();
      const externalAbort = () => controller.abort(new Error("截图已取消"));
      const timer = setTimeout(
        () => controller.abort(new Error("截图超时，请缩小range/viewport后重试")),
        timeoutMs,
      );
      let markDone: () => void = () => {};
      const done = new Promise<void>((resolveDone) => {
        markDone = resolveDone;
      });
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", externalAbort);
        controller.signal.removeEventListener("abort", cancelWaiting);
        jobs.delete(job);
        markDone();
      };
      const cancelWaiting = () => {
        if (job.started) return;
        const index = waiting.indexOf(job);
        if (index >= 0) waiting.splice(index, 1);
        cleanup();
        reject(aborted(controller.signal));
      };
      const job: Job = {
        started: false,
        controller,
        done,
        start: () => {
          active = true;
          job.started = true;
          void runCapture(input, controller.signal).then(
            (result) => {
              cleanup();
              active = false;
              drain();
              resolve(result);
            },
            (error) => {
              cleanup();
              active = false;
              drain();
              reject(error);
            },
          );
        },
      };
      jobs.add(job);
      input.signal?.addEventListener("abort", externalAbort, { once: true });
      controller.signal.addEventListener("abort", cancelWaiting, { once: true });
      if (active) waiting.push(job);
      else job.start();
    })) as WorkbookCaptureDriver;
  capture.close = async () => {
    isClosed = true;
    const pending = [...jobs];
    for (const job of pending) job.controller.abort(new Error("截图服务已关闭"));
    await Promise.all(pending.map((job) => job.done));
  };
  return capture;
}

export const captureWorkbookView = createWorkbookCaptureDriver();
