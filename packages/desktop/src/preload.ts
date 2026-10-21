// 预加载脚本（13 §1.2）：只暴露白名单 IPC；令牌由主进程交给渲染进程，不放在 URL 中。
// sandbox: true 下以 CommonJS 打包运行，只能使用 electron 的受限模块。

import { contextBridge, ipcRenderer } from "electron";

const boot = ipcRenderer.sendSync("em:bootstrap") as {
  backendUrl: string;
  token: string;
  platform: string;
};

type Listener<T> = (v: T) => void;
const on = <T>(channel: string, fn: Listener<T>) => {
  ipcRenderer.on(channel, (_e, v: T) => fn(v));
};

contextBridge.exposeInMainWorld("excelmanusDesktop", {
  backendUrl: boot.backendUrl,
  token: boot.token,
  platform: boot.platform,
  openExternal: (url: string) => ipcRenderer.send("em:open-external", url),
  showInFolder: (workspaceId: string, path: string) =>
    ipcRenderer.send("em:show-in-folder", workspaceId, path),
  chooseDirectory: () => ipcRenderer.invoke("em:choose-directory") as Promise<string | null>,
  checkForUpdates: () => ipcRenderer.invoke("em:check-updates"),
  installUpdate: () => ipcRenderer.send("em:install-update"),
  onMenu: (fn: Listener<string>) => on("em:menu", fn),
  onFocusSession: (fn: Listener<string>) => on("em:focus-session", fn),
  onUpdateStatus: (fn: Listener<unknown>) => on("em:update-status", fn),
});
