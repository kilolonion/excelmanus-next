// Electron 主进程（13）：单实例、主密钥（safeStorage）、utilityProcess 后端（崩溃自动重启 ≤3 次）、
// app://excelmanus 前端来源、窗口与菜单、白名单 IPC、系统通知、离屏截图窗口、退出确认、
// 自动更新（electron-updater，已签名安装包才启用）与 --self-test。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  protocol,
  safeStorage,
  shell,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import type { BackendToMain, MainToBackend } from "./backend.ts";
import { loadDesktopMasterKey } from "./master-key.ts";
import { APP_ORIGIN, contentSecurityPolicy, resolveAppFile } from "./protocol.ts";
import { loginShellPath, resolvedPath } from "./shell-path.ts";

const SELF_TEST = process.argv.includes("--self-test");
const MAX_BACKEND_RESTARTS = 3;
const MAX_RENDERER_RELOADS = 3;

/** 打包后资源在 resources/app；开发时为 packages/desktop/build/app。 */
const RESOURCES = app.isPackaged
  ? join(process.resourcesPath, "app")
  : join(import.meta.dirname, "..");
const WEB_ROOT = join(RESOURCES, "web");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let backend: UtilityProcess | undefined;
let backendInfo: { port: number; token: string; url: string } | undefined;
let backendRestarts = 0;
let quitting = false;
let mainWindow: BrowserWindow | undefined;
let renderWindow: BrowserWindow | undefined;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let nextId = 1;

function dataDir(): string {
  if (SELF_TEST) {
    const i = process.argv.indexOf("--data-dir");
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
    return join(app.getPath("temp"), `excelmanus-self-test-${process.pid}`);
  }
  // 附录 C P-1 建议：新数据目录，避免与旧版冲突
  return process.env.EXCELMANUS_HOME ?? join(app.getPath("home"), ".excelmanus-next");
}

type Request = Extract<MainToBackend, { id: number }>;
type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

function ask<T>(msg: RequestBody, timeoutMs = 60_000): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error("后端无响应"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    backend?.postMessage({ ...msg, id } as MainToBackend);
  });
}

// ---------- 后端 ----------

let cachedPath: string | undefined;
/** 后端（及其 stdio MCP 子进程）的 PATH：合并登录 shell 的 PATH（P1-46）。只解析一次。 */
function backendPath(): string {
  cachedPath ??= resolvedPath(process.env.PATH, loginShellPath());
  return cachedPath;
}

function startBackend(masterKey: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(RESOURCES, "dist", "backend.mjs"), [], {
      serviceName: "ExcelManus Backend",
      stdio: "pipe",
      env: { ...process.env, PATH: backendPath(), NODE_NO_WARNINGS: "1" },
    });
    backend = child;
    child.stdout?.on("data", (d: Buffer) => {
      if (SELF_TEST) return;
      process.stdout.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("message", (msg: BackendToMain) => {
      if (msg.type === "ready") {
        backendInfo = { port: msg.port, token: msg.token, url: msg.url };
        backendRestarts = 0;
        resolve();
      } else if (msg.type === "fatal") {
        reject(new Error(msg.message));
      } else if (msg.type === "reply") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.value);
        else p?.reject(new Error(msg.error ?? "失败"));
      } else if (msg.type === "notify") {
        notify(msg.title, msg.body, msg.sessionId);
      }
    });
    child.on("exit", (code) => {
      backend = undefined;
      for (const p of pending.values()) p.reject(new Error("后端已退出"));
      pending.clear();
      if (quitting || SELF_TEST) return;
      // 13 §2：后端崩溃自动重启，最多连续 3 次
      if (backendRestarts < MAX_BACKEND_RESTARTS) {
        backendRestarts += 1;
        void startBackend(masterKey)
          .then(() => {
            mainWindow?.webContents.reload();
            renderWindow?.webContents.reload();
          })
          .catch((e: unknown) => showFatal(e));
      } else {
        showFatal(new Error(`后端连续崩溃（退出码 ${code}）`));
      }
    });
    child.postMessage({
      type: "init",
      dataDir: dataDir(),
      masterKey: masterKey.toString("base64"),
      resources: RESOURCES,
    } satisfies MainToBackend);
  });
}

// ---------- 窗口 ----------

const webPreferences = {
  preload: join(RESOURCES, "dist", "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
} as const;

function lockDown(win: BrowserWindow): void {
  // 13 §1.2：导航限制在自身来源，外部链接交给系统浏览器
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "ExcelManus",
    show: false,
    backgroundColor: "#f9f9f8",
    webPreferences,
  });
  lockDown(win);
  let reloads = 0;
  win.webContents.on("render-process-gone", () => {
    // 13 §2：渲染进程崩溃自动重新加载，最多 3 次
    if (reloads < MAX_RENDERER_RELOADS) {
      reloads += 1;
      win.webContents.reload();
    } else showFatal(new Error("界面进程多次崩溃"));
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (process.platform === "darwin") {
      // macOS：关闭窗口不退出，保留后端与离屏截图
      win.hide();
      return;
    }
    // Windows/Linux：关闭主窗口即退出应用（13 §2）。离屏截图窗口仍在，window-all-closed
    // 不会触发，所以在这里发起退出；经 before-quit 的同一退出确认，取消则窗口保留。
    app.quit();
  });
  void win.loadURL(`${APP_ORIGIN}/`);
  return win;
}

/** 离屏截图窗口（13 §1）：加载只读渲染页，作为 workbook_render 的渲染端。 */
function createRenderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  lockDown(win);
  win.webContents.on("render-process-gone", () => win.webContents.reload());
  if (SELF_TEST || !app.isPackaged) {
    win.webContents.on("console-message", (e) => process.stderr.write(`[render] ${e.message}\n`));
    win.webContents.on("did-fail-load", (_e, code, desc, url) =>
      process.stderr.write(`[render] 加载失败 ${code} ${desc} ${url}\n`),
    );
    win.webContents.on("preload-error", (_e, path, err) =>
      process.stderr.write(`[render] 预加载失败 ${path} ${err.message}\n`),
    );
  }
  void win.loadURL(`${APP_ORIGIN}/?renderer=1`);
  return win;
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showFatal(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const choice = dialog.showMessageBoxSync({
    type: "error",
    title: "ExcelManus 无法启动",
    message: "后端启动失败",
    detail: `${message}\n\n数据目录：${dataDir()}`,
    buttons: ["重试", "打开数据目录", "退出"],
    defaultId: 0,
  });
  if (choice === 0) {
    app.relaunch();
    app.exit(0);
  } else if (choice === 1) {
    void shell.openPath(dataDir());
    app.exit(1);
  } else app.exit(1);
}

function notify(title: string, body: string, sessionId: string): void {
  // 13 §3：窗口不在前台时才弹系统通知；点击定位到会话
  if (mainWindow?.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => {
    showMain();
    mainWindow?.webContents.send("em:focus-session", sessionId);
  });
  n.show();
}

// ---------- IPC（白名单 + 校验发送方） ----------

function trusted(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const own = [mainWindow, renderWindow].some(
    (w) => w && !w.isDestroyed() && w.webContents.id === e.sender.id,
  );
  // 预加载阶段 senderFrame.url 可能尚未提交，退回到 webContents 的当前（或待提交）地址
  const url = e.senderFrame?.url || e.sender.getURL();
  const ok = own && url.startsWith(`${APP_ORIGIN}/`) && e.senderFrame?.parent === null;
  if (!ok) process.stderr.write(`拒绝来自 ${url || "(未知)"} 的 IPC\n`);
  return ok;
}

function registerIpc(): void {
  ipcMain.on("em:bootstrap", (e) => {
    if (!trusted(e) || !backendInfo) {
      e.returnValue = { backendUrl: "", token: "", platform: process.platform };
      return;
    }
    e.returnValue = {
      backendUrl: backendInfo.url,
      token: backendInfo.token,
      platform: process.platform,
    };
  });
  ipcMain.on("em:open-external", (e, url: unknown) => {
    if (trusted(e) && typeof url === "string" && /^https?:\/\//.test(url))
      void shell.openExternal(url);
  });
  ipcMain.on("em:show-in-folder", (e, workspaceId: unknown, path: unknown) => {
    if (!trusted(e) || typeof workspaceId !== "string" || typeof path !== "string") return;
    void ask<string>({ type: "resolvePath", workspaceId, path })
      .then((abs) => shell.showItemInFolder(abs))
      .catch(() => {});
  });
  ipcMain.handle("em:choose-directory", async (e) => {
    if (!trusted(e) || !mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("em:check-updates", async (e) =>
    trusted(e) ? checkForUpdates(true) : { status: "denied" },
  );
  ipcMain.on("em:install-update", (e) => {
    if (trusted(e)) void installUpdate();
  });
}

// ---------- 菜单（02 §10 快捷键） ----------

function buildMenu(): void {
  const send = (action: string) => () => {
    showMain();
    mainWindow?.webContents.send("em:menu", action);
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "ExcelManus",
            submenu: [
              { role: "about" as const, label: "关于 ExcelManus" },
              { label: "检查更新…", click: () => void checkForUpdates(true) },
              { type: "separator" as const },
              { label: "设置…", accelerator: "CmdOrCtrl+,", click: send("settings") },
              { type: "separator" as const },
              { role: "hide" as const, label: "隐藏" },
              { role: "quit" as const, label: "退出 ExcelManus" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新会话", accelerator: "CmdOrCtrl+N", click: send("new-session") },
        ...(process.platform === "darwin"
          ? []
          : [
              { label: "设置…", accelerator: "CmdOrCtrl+,", click: send("settings") },
              { label: "检查更新…", click: () => void checkForUpdates(true) },
              { role: "quit" as const, label: "退出" },
            ]),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "聚焦表格", accelerator: "CmdOrCtrl+1", click: send("focus-workbench") },
        { label: "聚焦对话", accelerator: "CmdOrCtrl+2", click: send("focus-chat") },
        { label: "输入框（附带选区）", accelerator: "CmdOrCtrl+L", click: send("focus-composer") },
        { label: "切换侧栏", accelerator: "CmdOrCtrl+B", click: send("toggle-sidebar") },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "togglefullscreen", label: "全屏" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const, label: "开发者工具" }]),
      ],
    },
    {
      label: "任务",
      submenu: [{ label: "停止当前任务", accelerator: "CmdOrCtrl+.", click: send("stop") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 自动更新（13 §4.3） ----------

let updater: typeof import("electron-updater").autoUpdater | undefined;
let updateReady = false;

async function loadUpdater() {
  if (updater || !app.isPackaged) return updater;
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  const push = (s: { status: string; version?: string; message?: string }) =>
    mainWindow?.webContents.send("em:update-status", s);
  autoUpdater.on("update-available", (i) => push({ status: "downloading", version: i.version }));
  autoUpdater.on("update-not-available", () => push({ status: "latest" }));
  autoUpdater.on("error", (e) => push({ status: "error", message: e.message }));
  autoUpdater.on("update-downloaded", (i) => {
    updateReady = true;
    push({ status: "ready", version: i.version });
  });
  updater = autoUpdater;
  return updater;
}

async function checkForUpdates(
  manual: boolean,
): Promise<{ status: string; version?: string; message?: string }> {
  if (!app.isPackaged) return { status: "unavailable", message: "开发构建不检查更新" };
  // 发布流水线写入 app-update.yml 后才启用（ADR 0010）；未签名或手动分发的构建只能手动更新
  if (!existsSync(join(process.resourcesPath, "app-update.yml")))
    return { status: "unavailable", message: "此构建未配置自动更新，请手动下载新版本" };
  try {
    const u = await loadUpdater();
    const r = await u?.checkForUpdates();
    if (!r?.isUpdateAvailable) return { status: "latest" };
    return { status: "downloading", version: r.updateInfo.version };
  } catch (e) {
    // 未签名的 macOS 构建无法自动更新（13 §4.2），只提示手动更新
    const message = e instanceof Error ? e.message : String(e);
    if (manual)
      void dialog.showMessageBox({ type: "info", message: "检查更新失败", detail: message });
    return { status: "error", message };
  }
}

async function installUpdate(): Promise<void> {
  if (!updateReady || !updater) return;
  // 有代理运行时不自动重启，等待用户确认（13 §4.3）
  if (!(await confirmQuit("安装更新需要重启。"))) return;
  quitting = true;
  await stopBackend();
  updater.quitAndInstall();
}

// ---------- 退出（13 §2） ----------

async function confirmQuit(prefix = ""): Promise<boolean> {
  const status = await ask<{ running: boolean }>({ type: "status" }, 5000).catch(() => ({
    running: false,
  }));
  if (!status.running) return true;
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    message: `${prefix}退出将中断正在运行的任务`,
    detail: "被中断的任务在下次启动时显示为「已中断」，可以点击继续。",
    buttons: ["退出", "取消"],
    defaultId: 1,
    cancelId: 1,
  });
  return choice === 0;
}

function stopBackend(): Promise<void> {
  return new Promise((resolve) => {
    const child = backend;
    if (!child) return resolve();
    const t = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.postMessage({ type: "shutdown" } satisfies MainToBackend);
  });
}

let quitPrompting = false;
app.on("before-quit", (e) => {
  if (quitting || SELF_TEST) return;
  e.preventDefault();
  // 确认框未关闭前重复触发（连点关闭按钮/菜单退出）不再弹第二个
  if (quitPrompting) return;
  quitPrompting = true;
  void confirmQuit()
    .then(async (ok) => {
      if (!ok) return;
      quitting = true;
      await stopBackend();
      app.quit();
    })
    .finally(() => {
      quitPrompting = false;
    });
});

app.on("second-instance", () => showMain());
app.on("activate", () => showMain());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------- 启动 ----------

function registerProtocol(): void {
  protocol.handle("app", async (req) => {
    const hit = resolveAppFile(WEB_ROOT, req.url);
    if (!hit) return new Response("Not Found", { status: 404 });
    const headers: Record<string, string> = { "content-type": hit.mime };
    if (hit.mime.startsWith("text/html") && backendInfo) {
      headers["content-security-policy"] = contentSecurityPolicy(backendInfo.port);
    }
    return new Response(readFileSync(hit.file), { headers });
  });
}

async function runSelfTest(): Promise<void> {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  try {
    const key = loadDesktopMasterKey(dataDir(), safeStorage);
    results.push({ name: "主密钥", ok: true, detail: key.storage });
    await startBackend(key.key);
    results.push({ name: "后端启动", ok: true, detail: backendInfo?.url });
    registerIpc();
    registerProtocol();
    results.push(...(await ask<typeof results>({ type: "selfTest" }, 120_000)));
    renderWindow = createRenderWindow();
    const r = await ask<{ bytes: number }>({ type: "renderProbe" }, 30_000)
      .then((v) => ({ name: "离屏截图", ok: v.bytes > 100, detail: `${v.bytes} 字节 PNG` }))
      .catch((e: unknown) => ({
        name: "离屏截图",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      }));
    results.push(r);
  } catch (e) {
    results.push({ name: "启动", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  const ok = results.every((r) => r.ok);
  process.stdout.write(`${JSON.stringify({ selfTest: ok ? "pass" : "fail", results }, null, 2)}\n`);
  quitting = true;
  await stopBackend();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  if (SELF_TEST) return runSelfTest();
  // 启动画面：后端就绪前先显示（13 §2）
  const splash = new BrowserWindow({
    width: 360,
    height: 200,
    frame: false,
    resizable: false,
    show: true,
    webPreferences: { sandbox: true },
  });
  void splash.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font:15px system-ui;background:#f9f9f8;color:#4d4540">ExcelManus 正在启动…</body>')}`,
  );
  try {
    const key = loadDesktopMasterKey(dataDir(), safeStorage);
    if (key.storage === "plain")
      process.stderr.write("系统密钥存储不可用：主密钥以仅当前用户可读的文件保存\n");
    await startBackend(key.key);
    registerIpc();
    registerProtocol();
    buildMenu();
    mainWindow = createMainWindow();
    renderWindow = createRenderWindow();
    mainWindow.once("ready-to-show", () => splash.destroy());
    // 启动时与每 24 小时检查一次更新（后台下载，完成后提示重启）
    setTimeout(() => void checkForUpdates(false), 10_000);
    setInterval(() => void checkForUpdates(false), 24 * 3600_000);
  } catch (e) {
    splash.destroy();
    showFatal(e);
  }
});
