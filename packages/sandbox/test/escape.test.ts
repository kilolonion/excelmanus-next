// 逃逸门禁：escape-cases.json 全部用例 + 公共后置条件。
// 公共后置条件：金丝雀不外泄 / 宿主原型与内建行为不变 / 哨兵目录校验和不变 /
// 哨兵 TCP 端口零连接 / 宿主进程随后跑 `return 1+1` 1s 内得 2 / RSS 增量 ≤512MB。
// 判定逻辑与 spikes/quickjs-sandbox/src/run-cases.ts 一致；
// 路径类用例依赖宿主侧校验，用与 kernel resolveWorkspacePath 同语义的
// test/stub-host.ts 替身（e2e-script.test.ts 再用真实 kernel 校验复核）。

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunOutcome, SandboxPool } from "../src/index.ts";
import { createStubHost, STUB_NAMESPACES, type StubHost } from "./stub-host.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface CaseDef {
  id: string;
  category: string;
  code?: string;
  codes?: string[];
  kind?: "concurrent" | "repeat";
  timeoutMs?: number;
  repeat?: number;
  expect: Record<string, unknown>;
  followUpCode?: string;
  followUpExpect?: string;
  note?: string;
}

const casesFile = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "escape-cases.json"), "utf8"),
) as { cases: CaseDef[] };

// ---------- 金丝雀 / 哨兵 ----------

const canaryEnv = `CANARY-ENV-${randomBytes(16).toString("hex")}`;
const canaryHost = `CANARY-HOST-${randomBytes(16).toString("hex")}`;
const canaryFile = `CANARY-FILE-${randomBytes(16).toString("hex")}`;
process.env.EXCELMANUS_TEST_CANARY = canaryEnv;
// 宿主内存金丝雀：证明宿主内存对象不会经脚本外泄
const hostSecretHolder = { secret: canaryHost };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qjs-escape-"));
const sentinelDir = path.join(tmpRoot, "sentinel");
fs.mkdirSync(sentinelDir, { recursive: true });
fs.writeFileSync(path.join(sentinelDir, "watch.txt"), `sentinel ${canaryFile}`);
fs.mkdirSync(path.join(sentinelDir, "sub"));
fs.writeFileSync(path.join(sentinelDir, "sub", "keep.txt"), "keep");

function dirChecksum(dir: string, excludeRel?: string): string {
  const items: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (excludeRel !== undefined && (r === excludeRel || r.startsWith(`${excludeRel}/`)))
        continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        items.push(`L ${r}`);
      } else if (e.isDirectory()) {
        items.push(`D ${r}`);
        walk(full, r);
      } else {
        const h = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        items.push(`F ${r} ${h}`);
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(items.join("\n")).digest("hex");
}

const sentinelChecksum0 = dirChecksum(sentinelDir);

// ---------- 宿主原型快照 ----------

function protoSnapshot(): unknown {
  return {
    obj: Object.getOwnPropertyNames(Object.prototype).sort(),
    arr: Object.getOwnPropertyNames(Array.prototype).sort(),
    fn: Object.getOwnPropertyNames(Function.prototype).sort(),
    json: Object.getOwnPropertyNames(JSON).sort(),
    promise: Object.getOwnPropertyNames(Promise).sort(),
    markers: {
      jsonStringify: JSON.stringify({ a: 1 }),
      arrayPush: [1].push(2),
      protoHas: Object.hasOwn({ x: 1 }, "x"),
      promiseCtor: typeof Promise.resolve === "function",
      funcCtorProto: Object.getPrototypeOf(() => {}) === Function.prototype,
    },
  };
}

const protoSnap0 = JSON.stringify(protoSnapshot());
const protoUnchanged = () => JSON.stringify(protoSnapshot()) === protoSnap0;

// RSS 增量判定前强制 GC：宿主 V8 不急于归还已释放内存，
// 不 gc 的话每例测量会被此前用例的堆松弛污染
v8.setFlagsFromString("--expose-gc");
const gc = (globalThis as { gc?: () => void }).gc?.bind(globalThis);

// ---------- 工作区 fixture ----------

function buildWorkspace(id: string): string {
  const dir = path.join(tmpRoot, "ws", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.xlsx"), "fake workbook bytes");
  fs.writeFileSync(path.join(dir, "slow.xlsx"), "slow workbook bytes");
  fs.writeFileSync(path.join(dir, "rows50k.xlsx"), "big workbook bytes");
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello workspace");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  if (id === "S04") {
    const outside = path.join(tmpRoot, "outside-s04");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), `top-secret ${canaryFile}`);
    fs.symlinkSync(outside, path.join(dir, "link-to-outside"), "junction");
  }
  if (id === "S05") {
    fs.mkdirSync(path.join(dir, ".excelmanus", "backups"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".excelmanus", "backups", "x.xlsx"), "hidden");
  }
  return dir;
}

// ---------- 判定 ----------

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function outcomeValue(o: RunOutcome): unknown {
  return o.kind === "ok" ? o.value : undefined;
}

function outcomeLabel(o: RunOutcome, durationMs?: number): string {
  if (o.kind === "ok") return `ok:${JSON.stringify(o.value)?.slice(0, 120)}`;
  if (o.kind === "scriptError") return `scriptError:${o.name}:${o.message.slice(0, 120)}`;
  return `terminated:${o.reason} in ${durationMs?.toFixed(0) ?? "?"}ms`;
}

function outcomeIs(o: RunOutcome, cat: string): boolean {
  if (cat === "scriptError") return o.kind === "scriptError";
  return o.kind === "terminated" && o.reason === cat;
}

// ---------- 测试 ----------

describe("sandbox escape cases", () => {
  let pool: SandboxPool;
  let sentinelConnections = 0;
  let sentinelServer: net.Server;
  let globalsAllowlist: Set<string>;
  let protoOwnNames: Set<string>;

  beforeAll(async () => {
    sentinelServer = net.createServer((sock) => {
      sentinelConnections++;
      sock.destroy();
    });
    await new Promise<void>((res) => sentinelServer.listen(0, "127.0.0.1", res));
    pool = new SandboxPool({ size: 2 });
    // 空 QuickJS 上下文枚举 ES 内建清单（G10 判据来源）+ Object.prototype 自有名（S13 fp 判据）
    const enumHost = createStubHost(buildWorkspace("enum"));
    const enumRes = await pool.run(
      {
        code: "return { g: Object.getOwnPropertyNames(globalThis).sort(), p: Object.getOwnPropertyNames(Object.getPrototypeOf({})).sort() }",
        timeoutMs: 5000,
        namespaces: {},
        bare: true,
      },
      enumHost,
    );
    if (enumRes.kind !== "ok") throw new Error(`基线枚举失败: ${JSON.stringify(enumRes)}`);
    const enumData = enumRes.value as { g: string[]; p: string[] };
    globalsAllowlist = new Set<string>([...enumData.g, "files", "wb", "console"]);
    protoOwnNames = new Set<string>(enumData.p);
  }, 30_000);

  afterAll(async () => {
    sentinelServer.close();
    await pool.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (hostSecretHolder.secret !== canaryHost) throw new Error("canary mutated");
  });

  function judgeSingle(c: CaseDef, o: RunOutcome, durationMs: number): string | undefined {
    const ex = c.expect as {
      result?: unknown;
      resultIn?: unknown[];
      terminated?: string;
      limited?: string[];
      kind?: string;
      files?: string[];
      wb?: string[];
    };
    if (ex.result !== undefined) {
      const v = outcomeValue(o);
      return deepEq(v, ex.result)
        ? undefined
        : `expected ${JSON.stringify(ex.result)}, got ${outcomeLabel(o, durationMs)}`;
    }
    if (ex.resultIn) {
      const v = outcomeValue(o);
      return ex.resultIn.some((r) => deepEq(v, r))
        ? undefined
        : `expected one of ${JSON.stringify(ex.resultIn)}, got ${outcomeLabel(o, durationMs)}`;
    }
    if (ex.terminated) {
      const limit = (c.timeoutMs ?? 30_000) + 500;
      return o.kind === "terminated" && o.reason === ex.terminated && durationMs <= limit
        ? undefined
        : `expected terminated:${ex.terminated} within ${limit}ms, got ${outcomeLabel(o, durationMs)}`;
    }
    if (ex.limited) {
      return ex.limited.some((cat) => outcomeIs(o, cat))
        ? undefined
        : `expected one of ${JSON.stringify(ex.limited)}, got ${outcomeLabel(o, durationMs)}`;
    }
    if (ex.kind === "scriptFailsOrSafe") return undefined;
    if (ex.kind === "globalsSubsetOfAllowlist") {
      const v = outcomeValue(o);
      if (!Array.isArray(v)) return `expected array of globals, got ${outcomeLabel(o)}`;
      const extra = v.filter((x) => !globalsAllowlist.has(String(x)));
      return extra.length === 0 ? undefined : `extra globals: ${JSON.stringify(extra)}`;
    }
    if (ex.kind === "sdkSurfaceExact") {
      const v = outcomeValue(o) as { files?: string[]; wb?: string[]; fp?: string[] };
      if (!v || typeof v !== "object") return `expected surface object, got ${outcomeLabel(o)}`;
      const filesOk = deepEq(v.files, ex.files);
      const wbOk = deepEq(v.wb, ex.wb);
      const fpExtra = (v.fp ?? []).filter((x) => !protoOwnNames.has(x));
      return filesOk && wbOk && fpExtra.length === 0
        ? undefined
        : `files=${JSON.stringify(v.files)} wb=${JSON.stringify(v.wb)} fpExtra=${JSON.stringify(fpExtra)}`;
    }
    return undefined;
  }

  for (const c of casesFile.cases) {
    const timeoutBudget = c.kind === "repeat" ? 120_000 : (c.timeoutMs ?? 30_000) + 20_000;
    test(`${c.id} ${c.category}`, { timeout: timeoutBudget }, async () => {
      const ws = buildWorkspace(c.id);
      const host: StubHost = createStubHost(ws);
      const auditExclude = `ws/${c.id}`;
      const tmpAudit0 = dirChecksum(tmpRoot, auditExclude);
      gc?.();
      const rss0 = process.memoryUsage().rss;
      const outcomes: Array<{ o: RunOutcome; durationMs: number }> = [];
      const run = async (code: string, timeoutMs: number) => {
        const t0 = performance.now();
        const o = await pool.run({ code, timeoutMs, namespaces: STUB_NAMESPACES }, host);
        const durationMs = performance.now() - t0;
        outcomes.push({ o, durationMs });
        return { o, durationMs };
      };

      const failures: string[] = [];
      let extraBlob = "";

      if (c.kind === "concurrent" && c.codes) {
        const results = await Promise.all(c.codes.map((code) => run(code, c.timeoutMs ?? 10_000)));
        const vals = results.map((r) => outcomeValue(r.o));
        const expected = (c.expect as { results: unknown[] }).results;
        if (!deepEq(vals, expected)) {
          failures.push(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(vals)}`);
        }
      } else if (c.kind === "repeat" && c.repeat) {
        const anomalies: string[] = [];
        for (let i = 0; i < c.repeat; i++) {
          let code = c.code!;
          let tmo = 10_000;
          if (i % 5 === 2) {
            code = "while (true) {}";
            tmo = 400;
          } else if (i % 5 === 4) {
            code = "throw new Error('boom')";
          }
          const { o } = await run(code, tmo);
          if (o.kind === "ok") {
            if (o.value !== "ok") anomalies.push(`run${i}: ${outcomeLabel(o)}`);
          } else if (o.kind === "terminated" && o.reason === "timeout") {
            // 预期
          } else if (o.kind === "scriptError") {
            // 预期
          } else {
            anomalies.push(`run${i}: ${outcomeLabel(o)}`);
          }
        }
        const rssGrowthMB = (process.memoryUsage().rss - rss0) / 1024 / 1024;
        const maxMB = (c.expect as { maxGrowthMB?: number }).maxGrowthMB ?? 100;
        if (rssGrowthMB > maxMB) failures.push(`rssGrowth=${rssGrowthMB.toFixed(1)}MB > ${maxMB}`);
        if (anomalies.length) failures.push(`anomalies=${JSON.stringify(anomalies)}`);
        extraBlob = JSON.stringify({ rssGrowthMB: +rssGrowthMB.toFixed(1) });
      } else {
        const { o, durationMs } = await run(c.code ?? "", c.timeoutMs ?? 30_000);
        const err = judgeSingle(c, o, durationMs);
        if (err) failures.push(err);
        if (c.followUpCode) {
          const f = await run(c.followUpCode, 5000);
          if (!deepEq(outcomeValue(f.o), c.followUpExpect)) {
            failures.push(
              `followUp expected ${JSON.stringify(c.followUpExpect)} got ${JSON.stringify(outcomeValue(f.o))}`,
            );
          }
        }
      }

      // ---- 公共后置条件 ----
      const blob = JSON.stringify([outcomes.map(({ o }) => o), extraBlob]);
      const leakedCanary = [canaryEnv, canaryHost, canaryFile].find((cn) => blob.includes(cn));
      if (leakedCanary) failures.push(`canary leaked: ${leakedCanary.slice(0, 20)}...`);
      if (!protoUnchanged()) failures.push("host prototypes changed");
      if (dirChecksum(sentinelDir) !== sentinelChecksum0) failures.push("sentinel dir modified");
      if (sentinelConnections !== 0) failures.push("sentinel port got connections");
      if (dirChecksum(tmpRoot, auditExclude) !== tmpAudit0)
        failures.push("writes outside workspace");
      // 宿主存活：平凡脚本 1s 内得 2（同时证明 worker 补位正常）
      const lvT0 = performance.now();
      const lv = await pool.run(
        { code: "return 1+1", timeoutMs: 1000, namespaces: STUB_NAMESPACES },
        host,
      );
      if (!(lv.kind === "ok" && lv.value === 2 && performance.now() - lvT0 <= 1000)) {
        failures.push(`liveness failed: ${outcomeLabel(lv)}`);
      }
      // 给刚回收的 worker 线程一段退出窗口再测 RSS（worker 与宿主共享进程 RSS）
      await new Promise((r) => setTimeout(r, 250));
      gc?.();
      const rssGrowth = (process.memoryUsage().rss - rss0) / 1024 / 1024;
      if (rssGrowth > 512) failures.push(`rssGrowth=${rssGrowth.toFixed(1)}MB > 512MB`);
      // T01 额外断言：在途宿主调用确实被 abort（08 §4 取消语义）
      if (c.id === "T01" && host.evidence.length === 0) {
        failures.push("T01: in-flight host call was not aborted");
      }

      expect(failures, failures.join("; ")).toEqual([]);
    });
  }
});
