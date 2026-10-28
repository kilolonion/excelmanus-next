import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import * as captureModule from "../src/workbook-capture.ts";
import { createWorkbookCaptureDriver } from "../src/workbook-capture.ts";

describe("capture browser process identity", () => {
  const root = {
    executablePath: "/trusted/chrome-headless-shell",
    args: ["--remote-debugging-pipe", "about:blank"],
    profile: "/tmp/excelmanus-capture-owned",
    platform: "linux",
    uid: 0,
    euid: 0,
    gid: 0,
    egid: 0,
    passwd: "root:x:0:0::/root:/bin/bash\ndevspace:x:1000:1000::/home/devspace:/bin/bash\n",
  };

  test("root requires the explicitly selected existing non-root devspace identity", () => {
    expect(() => captureModule.workbookCaptureLaunchPlan(root)).toThrow(/EXCELMANUS_BROWSER_USER/);
    for (const browserUser of ["root", "1000", "other", "devspace --keep-groups"])
      expect(() => captureModule.workbookCaptureLaunchPlan({ ...root, browserUser })).toThrow();
    for (const passwd of [
      "",
      "devspace:x:0:1000::::",
      "devspace:x:1000:0::::",
      `${root.passwd}${root.passwd}`,
    ])
      expect(() =>
        captureModule.workbookCaptureLaunchPlan({ ...root, browserUser: "devspace", passwd }),
      ).toThrow(/devspace/);
    expect(() =>
      captureModule.workbookCaptureLaunchPlan({ ...root, uid: 1000, browserUser: undefined }),
    ).toThrow(/EXCELMANUS_BROWSER_USER/);
    expect(() =>
      captureModule.workbookCaptureLaunchPlan({
        ...root,
        browserUser: "devspace",
        executablePath: "chrome",
      }),
    ).toThrow(/绝对路径/);
  });

  test("root launch uses only the fixed setpriv command and a private environment", () => {
    const plan = captureModule.workbookCaptureLaunchPlan({ ...root, browserUser: "devspace" });
    expect(plan.command).toBe("/usr/bin/setpriv");
    expect(plan.args).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      root.executablePath,
      ...root.args,
    ]);
    expect(plan.identity).toEqual({ uid: 1000, gid: 1000 });
    expect(plan.cwd).toBe(root.profile);
    expect(plan.env).toEqual({
      HOME: root.profile,
      XDG_CONFIG_HOME: root.profile,
      XDG_CACHE_HOME: root.profile,
      XDG_DATA_HOME: root.profile,
      XDG_RUNTIME_DIR: root.profile,
      TMPDIR: root.profile,
      TMP: root.profile,
      TEMP: root.profile,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });

  test("non-root captures keep the original executable, environment and identity", () => {
    const current = { ...root, uid: 1000, euid: 1000, gid: 1000, egid: 1000 };
    expect(captureModule.workbookCaptureLaunchPlan(current)).toEqual({
      command: root.executablePath,
      args: root.args,
    });
    expect(
      captureModule.workbookCaptureLaunchPlan({ ...current, browserUser: "devspace" }),
    ).toEqual({ command: root.executablePath, args: root.args });
    expect(() =>
      captureModule.workbookCaptureLaunchPlan({ ...current, uid: 1001, browserUser: "devspace" }),
    ).toThrow(/身份/);
  });

  test("actual child identity rejects saved root IDs, extra groups, capabilities or missing evidence", () => {
    const status =
      "Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n";
    const identity = { uid: 1000, gid: 1000 };
    expect(() => captureModule.verifyWorkbookCaptureIdentity(status, identity)).not.toThrow();
    expect(() =>
      captureModule.verifyWorkbookCaptureIdentity(
        status.replace("Groups:\t", "Groups:\t1000"),
        identity,
      ),
    ).not.toThrow();
    for (const invalid of [
      status.replace("1000\t1000\t1000\t1000", "1000\t1000\t0\t1000"),
      status.replace("Gid:\t1000", "Gid:\t0"),
      status.replace("Groups:\t", "Groups:\t1000 999"),
      status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001"),
      status.replace("CapAmb:\t0000000000000000", "CapAmb:\t0000000000000001"),
      status.replace(/CapEff:[^\n]*\n/, ""),
      "",
    ])
      expect(() => captureModule.verifyWorkbookCaptureIdentity(invalid, identity)).toThrow(
        /身份验证失败/,
      );
  });
});

function makePng(width: number, height: number, fill = 0): string {
  const chunk = (name: string, content: Buffer) => {
    const bytes = Buffer.alloc(content.length + 12);
    bytes.writeUInt32BE(content.length);
    bytes.write(name, 4);
    content.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, fill);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const png = makePng(1000, 700);
const packet = {
  workspaceId: "wks_capture",
  docId: "doc_capture",
  sheetId: "sheet_capture",
  rev: 4,
  snapshot: { id: "doc_capture", sheetOrder: ["sheet_capture"], sheets: { sheet_capture: {} } },
  range: "A1:B2",
  bounds: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
  viewport: { width: 1000, height: 700 },
  dpr: 1,
};
const receipt = {
  docId: packet.docId,
  sheetId: packet.sheetId,
  rev: packet.rev,
  requestedRange: packet.range,
  visibleRange: "A1:F20",
  fullyVisible: true,
  viewport: packet.viewport,
  dpr: 1,
  zoom: 1 as const,
  scroll: { row: 0, column: 0 },
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Command = { method: string; params: Record<string, unknown> };
type Trace = { pid: number; args: string[]; commands: Command[] };
async function fakeBrowser(
  mode = "success",
  requests: object[] = [],
  outputReceipt = receipt,
  outputPng = png,
) {
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  dirs.push(dir);
  const executablePath = join(dir, "browser.cjs");
  const tracePath = join(dir, "trace.json");
  // Only the external browser is substituted. Pipes, queue, deadline, process exit and
  // profile removal run through the production driver and actual OS child processes.
  await writeFile(
    executablePath,
    `#!${process.execPath}
const fs = require('node:fs');
const config = ${JSON.stringify({ mode, requests, receipt: outputReceipt, png: outputPng, alternate: makePng(1000, 700, 255), tracePath })};
const trace = { pid: process.pid, args: process.argv.slice(2), commands: [] };
const save = () => fs.writeFileSync(config.tracePath, JSON.stringify(trace));
save();
const send = value => fs.writeSync(4, JSON.stringify(value) + '\\0');
let buffer = '', shots = 0, evaluations = 0;
fs.createReadStream(null, { fd: 3 }).on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    trace.commands.push(message); save();
    if (config.mode === 'timeout') continue;
    if (config.mode === 'crash') process.exit(7);
    let result = {};
    if (message.method === 'Target.createBrowserContext') result = { browserContextId: 'context' };
    if (message.method === 'Target.createTarget') result = { targetId: 'target' };
    if (message.method === 'Target.attachToTarget') result = { sessionId: 'session' };
    if (message.method === 'Page.navigate') {
      for (const request of config.requests) send({ method: 'Fetch.requestPaused', sessionId: 'session', params: request });
      send({ method: 'Fetch.authRequired', sessionId: 'session', params: { requestId: 'auth', request: { url: 'http://127.0.0.1:8787/assets/private.js' } } });
    }
    if (config.mode === 'navigation-race' && message.method === 'Runtime.evaluate' && ++evaluations === 1) { send({ id: message.id, error: { code: -32000, message: 'Execution context was destroyed.' } }); continue; }
    if (message.method === 'Runtime.evaluate') result = { result: message.params.returnByValue ? { value: true } : { objectId: 'window' } };
    if (message.method === 'Runtime.callFunctionOn') result = { result: { value: message.params.arguments?.length ? config.receipt : true } };
    if (message.method === 'Page.captureScreenshot') result = { data: config.mode === 'unstable' && (++shots) % 2 === 0 ? config.alternate : config.png };
    send({ id: message.id, result, sessionId: message.sessionId });
    if (message.method === 'Browser.close') process.exit(0);
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executablePath, 0o700);
  return {
    executablePath,
    trace: async () => JSON.parse(await readFile(tracePath, "utf8")) as Trace,
    ready: async () => {
      for (let i = 0; i < 100; i++) {
        try {
          await access(tracePath);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    },
  };
}
async function expectCleaned(trace: Trace) {
  const profile = trace.args.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
  expect(profile).toBeTruthy();
  await expect(access(profile as string)).rejects.toThrow();
  expect(() => process.kill(trace.pid, 0)).toThrow();
  expect(trace.args).toContain("--remote-debugging-pipe");
  expect(trace.args).toContain("--headless");
  expect(
    trace.args.some((arg) => /no-sandbox|remote-debugging-port|ignore-certificate/.test(arg)),
  ).toBe(false);
}

describe("workbook browser capture", () => {
  test("allows only same-origin static GETs, checks redirects and cancels authentication", async () => {
    const cases = [
      ["entry", "http://127.0.0.1:8787/?capture=1", "GET", "Document", true],
      ["js", "http://127.0.0.1:8787/assets/main-abc.js", "GET", "Script", true],
      ["font", "http://127.0.0.1:8787/assets/geist.woff2", "GET", "Font", true],
      ["css", "http://127.0.0.1:8787/assets/main.css", "GET", "Stylesheet", true],
      ["outside", "https://evil.invalid/assets/main.js", "GET", "Script", false],
      ["api", "http://127.0.0.1:8787/api/v1/bootstrap", "GET", "XHR", false],
      ["post", "http://127.0.0.1:8787/assets/main.js", "POST", "Script", false],
      ["socket", "ws://127.0.0.1:8787/assets/socket.js", "GET", "WebSocket", false],
      ["root", "http://127.0.0.1:8787/", "GET", "Document", false],
      ["query", "http://127.0.0.1:8787/assets/main.js?secret=data", "GET", "Script", false],
      ["credentials", "http://user:pass@127.0.0.1:8787/assets/main.js", "GET", "Script", false],
      ["traversal", "http://127.0.0.1:8787/assets/%2e%2e%2fapi.js", "GET", "Script", false],
      ["fetch", "http://127.0.0.1:8787/assets/main.js", "GET", "Fetch", false],
    ] as const;
    const requests: object[] = cases.map(([requestId, url, method, resourceType]) => ({
      requestId,
      request: {
        url,
        method,
        headers: { Cookie: "secret", Authorization: "secret", Accept: "*/*" },
      },
      resourceType,
    }));
    requests.push({
      requestId: "redirect",
      request: {
        url: "https://evil.invalid/assets/main.js",
        method: "GET",
        headers: { Cookie: "secret", Authorization: "secret", Accept: "*/*" },
      },
      resourceType: "Script",
    });
    requests.push({
      requestId: "redirect-response",
      request: { url: "http://127.0.0.1:8787/assets/main.js", method: "GET", headers: {} },
      resourceType: "Script",
      responseStatusCode: 302,
      responseHeaders: [{ name: "Location", value: "https://evil.invalid/assets/main.js" }],
    });
    requests.push({
      requestId: "asset-response",
      request: { url: "http://127.0.0.1:8787/assets/main.js", method: "GET", headers: {} },
      resourceType: "Script",
      responseStatusCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "text/javascript" },
        { name: "Set-Cookie", value: "secret=1" },
      ],
    });
    const browser = await fakeBrowser("success", requests);
    const capture = createWorkbookCaptureDriver();
    const result = await capture({
      packet,
      baseUrl: "http://127.0.0.1:8787",
      executablePath: browser.executablePath,
    });
    expect(result).toEqual({ png, receipt });
    const trace = await browser.trace();
    for (const [requestId, , , , allowed] of cases) {
      expect(trace.commands).toContainEqual(
        expect.objectContaining({
          method: allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
          params: expect.objectContaining({ requestId }),
        }),
      );
    }
    expect(trace.commands).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: expect.objectContaining({ requestId: "redirect" }),
      }),
    );
    expect(trace.commands).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueWithAuth",
        params: { requestId: "auth", authChallengeResponse: { response: "CancelAuth" } },
      }),
    );
    expect(trace.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.setBlockedURLs",
        params: { urls: ["ws://*", "wss://*"] },
      }),
    );
    const continued = trace.commands.filter(
      (command) => command.method === "Fetch.continueRequest",
    );
    for (const command of continued)
      expect(command.params.headers).toEqual([{ name: "Accept", value: "*/*" }]);
    expect(trace.commands).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: expect.objectContaining({ requestId: "redirect-response" }),
      }),
    );
    expect(trace.commands).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueResponse",
        params: {
          requestId: "asset-response",
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
        },
      }),
    );
    const guard = trace.commands.find(
      (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(guard).toBeDefined();
    const context = { navigator: {} } as Record<string, unknown>;
    runInNewContext(String(guard?.params.source), context);
    expect(() => runInNewContext("new WebSocket('wss://evil.invalid')", context)).toThrow(
      /禁止网络/,
    );
    expect(() => runInNewContext("fetch('/api/v1/bootstrap')", context)).toThrow(/禁止网络/);
    expect(() => runInNewContext("new Worker('/assets/worker.js')", context)).toThrow(/禁止网络/);
    const mount = trace.commands.find(
      (command) => command.method === "Runtime.callFunctionOn" && command.params.arguments,
    );
    expect(mount?.params.arguments).toEqual([{ value: packet }]);
    expect(mount?.params.functionDeclaration).not.toContain(packet.docId);
    expect(
      trace.commands.filter((command) => command.method === "Page.captureScreenshot"),
    ).toHaveLength(2);
    await expectCleaned(trace);
  });

  test("waits through the initial navigation context replacement", async () => {
    const browser = await fakeBrowser("navigation-race");
    const capture = createWorkbookCaptureDriver();
    expect(
      (
        await capture({
          packet,
          baseUrl: "http://127.0.0.1:8787",
          executablePath: browser.executablePath,
        })
      ).png,
    ).toBe(png);
    await expectCleaned(await browser.trace());
  });

  test("abort terminates its process, removes its profile and releases the queue", async () => {
    const browser = await fakeBrowser("timeout");
    const capture = createWorkbookCaptureDriver({ timeoutMs: 2000 });
    const controller = new AbortController();
    const result = capture({
      packet,
      baseUrl: "http://127.0.0.1:8787",
      executablePath: browser.executablePath,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow(/取消|abort/i);
    await browser.ready();
    controller.abort();
    await rejected;
    await expectCleaned(await browser.trace());
    const next = await fakeBrowser();
    expect(
      (
        await capture({
          packet,
          baseUrl: "http://127.0.0.1:8787",
          executablePath: next.executablePath,
        })
      ).png,
    ).toBe(png);
  });

  test("timeout and browser failure both clean up owned resources", async () => {
    for (const mode of ["timeout", "crash"]) {
      const browser = await fakeBrowser(mode);
      const capture = createWorkbookCaptureDriver({ timeoutMs: 200 });
      await expect(
        capture({
          packet,
          baseUrl: "http://127.0.0.1:8787",
          executablePath: browser.executablePath,
        }),
      ).rejects.toThrow();
      await expectCleaned(await browser.trace());
    }
  });

  test("permits one active capture and at most two waiting; waiting abort never launches", async () => {
    const browser = await fakeBrowser("timeout");
    const capture = createWorkbookCaptureDriver({ timeoutMs: 2000 });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const jobs = controllers.map((controller) =>
      capture({
        packet,
        baseUrl: "http://127.0.0.1:8787",
        executablePath: browser.executablePath,
        signal: controller.signal,
      }),
    );
    const rejected = Promise.all(jobs.map((job) => expect(job).rejects.toThrow(/取消|abort/i)));
    await expect(
      capture({ packet, baseUrl: "http://127.0.0.1:8787", executablePath: browser.executablePath }),
    ).rejects.toThrow(/队列|繁忙|queue/i);
    await browser.ready();
    controllers[1]?.abort();
    controllers[2]?.abort();
    controllers[0]?.abort();
    await rejected;
    await expectCleaned(await browser.trace());
  });

  test("closing a driver aborts active and waiting jobs and awaits cleanup", async () => {
    const browser = await fakeBrowser("timeout");
    const capture = createWorkbookCaptureDriver();
    const input = {
      packet,
      baseUrl: "http://127.0.0.1:8787",
      executablePath: browser.executablePath,
    };
    const active = capture(input).catch((error) => error as Error);
    const waiting = capture(input).catch((error) => error as Error);
    await browser.ready();
    await capture.close();
    expect(await active).toBeInstanceOf(Error);
    expect(await waiting).toBeInstanceOf(Error);
    await expectCleaned(await browser.trace());
    await expect(capture(input)).rejects.toThrow(/关闭/);
  });

  test("rejects receipt identity mismatches and unstable frames instead of returning a misleading image", async () => {
    for (const mode of ["mismatch", "unstable"]) {
      const browser = await fakeBrowser(
        mode,
        [],
        mode === "mismatch" ? { ...receipt, rev: 999 } : receipt,
      );
      await expect(
        createWorkbookCaptureDriver()({
          packet,
          baseUrl: "http://127.0.0.1:8787",
          executablePath: browser.executablePath,
        }),
      ).rejects.toThrow(mode === "mismatch" ? /不一致/ : /稳定/);
      const trace = await browser.trace();
      expect(
        trace.commands.filter((command) => command.method === "Page.captureScreenshot"),
      ).toHaveLength(mode === "mismatch" ? 0 : 6);
      await expectCleaned(trace);
    }
  });

  test("refuses oversized PNG bytes or actual IHDR pixel dimensions without rescaling", async () => {
    const pixels = Buffer.from(png, "base64");
    pixels.writeUInt32BE(5000, 16);
    pixels.writeUInt32BE(5000, 20);
    const bytes = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(8 * 1024 * 1024)]);
    for (const output of [pixels, bytes]) {
      const browser = await fakeBrowser("success", [], receipt, output.toString("base64"));
      await expect(
        createWorkbookCaptureDriver()({
          packet,
          baseUrl: "http://127.0.0.1:8787",
          executablePath: browser.executablePath,
        }),
      ).rejects.toThrow("截图过大，请缩小range/viewport");
      await expectCleaned(await browser.trace());
    }
  });
});
