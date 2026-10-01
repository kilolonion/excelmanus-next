// 桌面后端（13 §1、§2）：在 utilityProcess 中运行与本机 Web 完全相同的后端。
// 与主进程只经 parentPort 通信：启动参数（数据目录、主密钥、资源位置）→ 就绪（端口、令牌）；
// 之后是通知、状态查询、路径解析、自检与优雅退出。

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type RunningServer, startServer } from "@excelmanus/server";

export interface BackendInit {
  type: "init";
  dataDir: string;
  masterKey: string;
  resources: string;
}

export type MainToBackend =
  | BackendInit
  | { type: "status"; id: number }
  | { type: "resolvePath"; id: number; workspaceId: string; path: string }
  | { type: "selfTest"; id: number }
  | { type: "renderProbe"; id: number }
  | { type: "shutdown" };

export type BackendToMain =
  | { type: "ready"; port: number; token: string; url: string }
  | { type: "fatal"; message: string }
  | { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string }
  | {
      type: "notify";
      kind: string;
      sessionId: string;
      title: string;
      body: string;
    }
  | { type: "closed" };

interface ParentPort {
  on(event: "message", fn: (e: { data: MainToBackend }) => void): void;
  postMessage(msg: BackendToMain): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("backend 必须由 Electron utilityProcess 启动");

let srv: RunningServer | undefined;
let resources = "";

const reply = (id: number, fn: () => Promise<unknown> | unknown) => {
  Promise.resolve()
    .then(fn)
    .then((value) => port.postMessage({ type: "reply", id, ok: true, value }))
    .catch((e: unknown) =>
      port.postMessage({
        type: "reply",
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
};

port.on("message", ({ data: msg }) => {
  switch (msg.type) {
    case "init":
      resources = msg.resources;
      startServer({
        dataDir: msg.dataDir,
        masterKey: Buffer.from(msg.masterKey, "base64"),
        shape: "desktop",
        extraOrigins: ["app://excelmanus"],
        builtinSkillsDir: join(msg.resources, "skills"),
        catalogDir: join(msg.resources, "catalog"),
        samplesDir: join(msg.resources, "samples"),
        sandboxWorkerUrl: pathToFileURL(join(msg.resources, "dist", "sandbox-worker.mjs")),
        // 前端由 app:// 协议提供，后端不托管静态文件
        webDist: join(msg.resources, "__no_web__"),
        onNotify: (n) => port.postMessage({ type: "notify", ...n }),
        log: (line) => process.stdout.write(`${line}\n`),
      })
        .then((s) => {
          srv = s;
          port.postMessage({ type: "ready", port: s.port, token: s.token, url: s.url });
        })
        .catch((e: unknown) =>
          port.postMessage({ type: "fatal", message: e instanceof Error ? e.message : String(e) }),
        );
      break;
    case "status":
      reply(msg.id, () => ({ running: srv?.hasRunningAgents() ?? false }));
      break;
    case "resolvePath":
      reply(msg.id, () => {
        if (!srv) throw new Error("后端未就绪");
        return srv.resolveWorkspaceFile(msg.workspaceId, msg.path);
      });
      break;
    case "selfTest":
      reply(msg.id, async () => {
        if (!srv) throw new Error("后端未就绪");
        return srv.selfTest(join(resources, "samples", "sales.xlsx"));
      });
      break;
    case "renderProbe":
      reply(msg.id, async () => {
        if (!srv) throw new Error("后端未就绪");
        for (let i = 0; i < 100 && !srv.renderAvailable(); i++)
          await new Promise((r) => setTimeout(r, 100));
        const png = await srv.renderProbe();
        return { bytes: Buffer.from(png, "base64").length };
      });
      break;
    case "shutdown":
      // 优雅退出（13 §2）：停止接收请求、写回活文档、关闭数据库；运行中的代理在下次启动时恢复为中断
      void (srv?.close() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => {
          port.postMessage({ type: "closed" });
          process.exit(0);
        });
      break;
  }
});
