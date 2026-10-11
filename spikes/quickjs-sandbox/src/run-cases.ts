// M0-C 逃逸测试 harness：跑 escape-cases.json 全部用例 + 公共后置条件。
// 公共后置条件：金丝雀不外泄 / 宿主原型与内建行为不变 / 哨兵目录校验和不变 /
// 哨兵 TCP 端口零连接 / 宿主进程随后跑 `return 1+1` 1s 内得 2 / RSS 增量 ≤512MB。
// 用法：node src/run-cases.ts（结果写 results/cases.json）

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS } from "./protocol.ts";
import { type RunOutcome, Sandbox } from "./sandbox.ts";
import { createSdkHost, type EvidenceLog } from "./sdk-host.ts";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS_DIR = path.join(PKG_DIR, "results");

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

const casesFile = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "escape-cases.json"), "utf8")) as {
  cases: CaseDef[];
};

// ---------- 金丝雀 / 哨兵 ----------

const canaryEnv = `CANARY-ENV-${randomBytes(16).toString("hex")}`;
const canaryHost = `CANARY-HOST-${randomBytes(16).toString("hex")}`;
const canaryFile = `CANARY-FILE-${randomBytes(16).toString("hex")}`;
process.env.EXCELMANUS_SPIKE_CANARY = canaryEnv;
// 宿主内存金丝雀：挂在全局可见处以外的地方也会被宿主对象图扫到，这里只是普通宿主数据
const hostSecretHolder = { secret: canaryHost };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qjs-spike-"));
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

// 哨兵端口：监听本地端口并计连接数
let sentinelConnections = 0;
const sentinelServer = net.createServer((sock) => {
  sentinelConnections++;
  sock.destroy();
});
await new Promise<void>((res) => sentinelServer.listen(0, "127.0.0.1", res));

// ---------- 宿主原型快照 ----------

function protoSnapshot(): unknown {
  return {
    obj: Object.getOwnPropertyNames(Object.prototype).sort(),
    arr: Object.getOwnPropertyNames(Array.prototype).sort(),
    fn: Object.getOwnPropertyNames(Function.prototype).sort(),
    json: Object.getOwnPropertyNames(JSON).sort(),
    promise: Object.getOwnPropertyNames(Promise).sort(),
    // 行为标记：内建函数仍按预期工作
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
function protoUnchanged(): boolean {
  return JSON.stringify(protoSnapshot()) === protoSnap0;
}

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
  if (o.outcome.kind !== "ok") return undefined;
  try {
    return JSON.parse(o.outcome.valueJson);
  } catch {
    return o.outcome.valueJson;
  }
}

function outcomeLabel(o: RunOutcome): string {
  if (o.outcome.kind === "ok") return `ok:${o.outcome.valueJson.slice(0, 120)}`;
  if (o.outcome.kind === "scriptError")
    return `scriptError:${o.outcome.name}:${o.outcome.message.slice(0, 120)}`;
  return `terminated:${o.outcome.reason}`;
}

function outcomeIs(o: RunOutcome, cat: string): boolean {
  if (cat === "scriptError") return o.outcome.kind === "scriptError";
  return o.outcome.kind === "terminated" && o.outcome.reason === cat;
}

function judgeSingle(c: CaseDef, o: RunOutcome): { pass: boolean; detail: string } {
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
      ? { pass: true, detail: `result=${JSON.stringify(v)}` }
      : { pass: false, detail: `expected ${JSON.stringify(ex.result)}, got ${outcomeLabel(o)}` };
  }
  if (ex.resultIn) {
    const v = outcomeValue(o);
    const hit = ex.resultIn.some((r) => deepEq(v, r));
    return hit
      ? { pass: true, detail: `result=${JSON.stringify(v)} ∈ expected` }
      : {
          pass: false,
          detail: `expected one of ${JSON.stringify(ex.resultIn)}, got ${outcomeLabel(o)}`,
        };
  }
  if (ex.terminated) {
    const limit = (c.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 500;
    const ok =
      o.outcome.kind === "terminated" &&
      o.outcome.reason === ex.terminated &&
      o.durationMs <= limit;
    return ok
      ? {
          pass: true,
          detail: `terminated:${(o.outcome as { reason: string }).reason} in ${o.durationMs.toFixed(0)}ms via ${o.via}`,
        }
      : {
          pass: false,
          detail: `expected terminated:${ex.terminated} within ${limit}ms, got ${outcomeLabel(o)} durationMs=${o.durationMs.toFixed(0)} via ${o.via}`,
        };
  }
  if (ex.limited) {
    const ok = ex.limited.some((cat) => outcomeIs(o, cat));
    return ok
      ? {
          pass: true,
          detail: `limited:${outcomeLabel(o)} in ${o.durationMs.toFixed(0)}ms via ${o.via}`,
        }
      : {
          pass: false,
          detail: `expected one of ${JSON.stringify(ex.limited)}, got ${outcomeLabel(o)}`,
        };
  }
  if (ex.kind === "scriptFailsOrSafe") {
    return { pass: true, detail: `outcome=${outcomeLabel(o)}（仅以公共后置条件为准）` };
  }
  if (ex.kind === "globalsSubsetOfAllowlist") {
    const v = outcomeValue(o);
    if (!Array.isArray(v)) {
      return { pass: false, detail: `expected array of globals, got ${outcomeLabel(o)}` };
    }
    const extra = (v as unknown[]).filter((x) => !globalsAllowlist.has(String(x)));
    return extra.length === 0
      ? { pass: true, detail: `${v.length} globals ⊆ allowlist` }
      : { pass: false, detail: `extra globals: ${JSON.stringify(extra)}` };
  }
  if (ex.kind === "sdkSurfaceExact") {
    const v = outcomeValue(o) as { files?: string[]; wb?: string[]; fp?: string[] };
    if (!v || typeof v !== "object") {
      return { pass: false, detail: `expected surface object, got ${outcomeLabel(o)}` };
    }
    const filesOk = deepEq(v.files, ex.files);
    const wbOk = deepEq(v.wb, ex.wb);
    const fpExtra = (v.fp ?? []).filter((x) => !protoOwnNames.has(x));
    const fpOk = fpExtra.length === 0;
    return {
      pass: filesOk && wbOk && fpOk,
      detail: `files=${JSON.stringify(v.files)} wb=${JSON.stringify(v.wb)} fpExtra=${JSON.stringify(fpExtra)}`,
    };
  }
  if (ex.kind === "rssGrowthBounded") {
    // T04 在外层聚合判定
    return { pass: true, detail: "" };
  }
  return { pass: false, detail: `unknown expect shape ${JSON.stringify(ex)}` };
}

// ---------- 主流程 ----------

const sandbox = new Sandbox({ poolSize: 2 });
await sandbox.warmup();

// 空 QuickJS 上下文枚举 ES 内建清单（G10 判据来源）+ Object.prototype 自有名（S13 fp 判据）
const enumHost = createSdkHost(buildWorkspace("enum"));
const enumRes = await sandbox.runScript(
  "return { g: Object.getOwnPropertyNames(globalThis).sort(), p: Object.getOwnPropertyNames(Object.getPrototypeOf({})).sort() }",
  { sdkHost: enumHost, bare: true, timeoutMs: 5000 },
);
if (enumRes.outcome.kind !== "ok") {
  console.error("基线枚举失败", enumRes.outcome);
  process.exit(1);
}
const enumData = JSON.parse(enumRes.outcome.valueJson) as { g: string[]; p: string[] };
const globalsAllowlist = new Set<string>([...enumData.g, "files", "wb", "console"]);
const protoOwnNames = new Set<string>(enumData.p);
console.log(`[baseline] ES globals=${enumData.g.length} Object.prototype own=${enumData.p.length}`);

interface CaseReport {
  id: string;
  category: string;
  expect: unknown;
  outcome: string;
  outcomeDetail?: unknown;
  durationMs: number;
  terminationWithinBound?: boolean;
  evidence?: EvidenceLog;
  postconditions: Record<string, boolean | string | number>;
  pass: boolean;
  detail: string;
  note?: string;
}

const reports: CaseReport[] = [];

for (const c of casesFile.cases) {
  const evidence: EvidenceLog = [];
  const ws = buildWorkspace(c.id);
  const sdkHost = createSdkHost(ws);
  // 工作区外文件审计：tmpRoot 快照排除本用例自己的工作区目录（ws/<id> 内允许写）
  const auditExclude = `ws/${c.id}`;
  const tmpAudit0 = dirChecksum(tmpRoot, auditExclude);
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  let outcomes: RunOutcome[] = [];
  let judge: { pass: boolean; detail: string };
  let extra: Record<string, unknown> = {};

  try {
    if (c.kind === "concurrent" && c.codes) {
      const ex = c.expect as { results: string[] };
      outcomes = await Promise.all(
        c.codes.map((code) =>
          sandbox.runScript(code, {
            sdkHost,
            evidence,
            timeoutMs: c.timeoutMs ?? 10_000,
          }),
        ),
      );
      const vals = outcomes.map(outcomeValue);
      judge = deepEq(vals, ex.results)
        ? { pass: true, detail: `results=${JSON.stringify(vals)}` }
        : {
            pass: false,
            detail: `expected ${JSON.stringify(ex.results)}, got ${JSON.stringify(vals)}`,
          };
    } else if (c.kind === "repeat" && c.repeat) {
      const t4stats = {
        runs: 0,
        ok: 0,
        errors: 0,
        timeouts: 0,
        other: 0,
        anomalies: [] as string[],
      };
      for (let i = 0; i < c.repeat; i++) {
        let code = c.code!;
        let tmo = 10_000;
        if (i % 5 === 2) {
          code = "while (true) {}";
          tmo = 400;
        } else if (i % 5 === 4) {
          code = "throw new Error('boom')";
        }
        const r = await sandbox.runScript(code, { sdkHost, evidence, timeoutMs: tmo });
        t4stats.runs++;
        if (r.outcome.kind === "ok") {
          t4stats.ok++;
          if (outcomeValue(r) !== "ok") t4stats.anomalies.push(`run${i}: ${outcomeLabel(r)}`);
        } else if (r.outcome.kind === "terminated" && r.outcome.reason === "timeout") {
          t4stats.timeouts++;
        } else if (r.outcome.kind === "scriptError") {
          t4stats.errors++;
        } else {
          t4stats.other++;
          t4stats.anomalies.push(`run${i}: ${outcomeLabel(r)}`);
        }
      }
      const rssGrowthMB = (process.memoryUsage().rss - rss0) / 1024 / 1024;
      const maxMB = (c.expect as { maxGrowthMB?: number }).maxGrowthMB ?? 100;
      const workersOk = sandbox.activeWorkerCount === 2;
      extra = {
        ...t4stats,
        rssGrowthMB: +rssGrowthMB.toFixed(1),
        activeWorkers: sandbox.activeWorkerCount,
      };
      judge =
        rssGrowthMB <= maxMB && workersOk && t4stats.anomalies.length === 0
          ? {
              pass: true,
              detail: `100 runs, rss +${rssGrowthMB.toFixed(1)}MB, workers=${sandbox.activeWorkerCount}`,
            }
          : {
              pass: false,
              detail: `rssGrowth=${rssGrowthMB.toFixed(1)}MB (max ${maxMB}), workers=${sandbox.activeWorkerCount}, anomalies=${JSON.stringify(t4stats.anomalies)}`,
            };
    } else {
      const r = await sandbox.runScript(c.code ?? "", {
        sdkHost,
        evidence,
        timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      outcomes.push(r);
      judge = judgeSingle(c, r);
      if (c.followUpCode) {
        const f = await sandbox.runScript(c.followUpCode, { sdkHost, evidence, timeoutMs: 5000 });
        outcomes.push(f);
        const fv = outcomeValue(f);
        if (!deepEq(fv, c.followUpExpect)) {
          judge = {
            pass: false,
            detail: `${judge.detail}; followUp expected ${JSON.stringify(c.followUpExpect)} got ${JSON.stringify(fv)}`,
          };
        } else {
          judge.detail += `; followUp=${JSON.stringify(fv)}`;
        }
      }
    }
  } catch (e) {
    judge = { pass: false, detail: `harness exception: ${e instanceof Error ? e.message : e}` };
  }

  const durationMs = performance.now() - t0;

  // ---- 公共后置条件 ----
  const outcomeBlob = JSON.stringify({
    outcomes: outcomes.map((o) => ({ outcome: o.outcome, stdout: o.stdout })),
    extra,
  });
  const leakedCanary = [canaryEnv, canaryHost, canaryFile].find((cn) => outcomeBlob.includes(cn));
  const pc: Record<string, boolean | string | number> = {};
  pc.noCanaryLeak = !leakedCanary;
  if (leakedCanary) pc.noCanaryLeak = `LEAKED: ${leakedCanary.slice(0, 20)}...`;
  pc.prototypesUnchanged = protoUnchanged();
  const sum1 = dirChecksum(sentinelDir);
  pc.sentinelDirUnchanged = sum1 === sentinelChecksum0;
  pc.sentinelPortNoConnections = sentinelConnections === 0;
  pc.noWritesOutsideWorkspace = dirChecksum(tmpRoot, auditExclude) === tmpAudit0;
  // 宿主存活检查：平凡脚本 1s 内得 2
  const lvT0 = performance.now();
  const lv = await sandbox.runScript("return 1+1", {
    sdkHost,
    evidence,
    timeoutMs: 1000,
  });
  pc.livenessReturn2 =
    lv.outcome.kind === "ok" && outcomeValue(lv) === 2 && performance.now() - lvT0 <= 1000;
  const rssGrowth = (process.memoryUsage().rss - rss0) / 1024 / 1024;
  pc.rssGrowthWithin512MB = rssGrowth <= 512;
  pc.rssGrowthMB = +rssGrowth.toFixed(1);

  const allPost = Object.entries(pc)
    .filter(([k]) => k !== "rssGrowthMB")
    .every(([, v]) => v === true);
  const pass = judge.pass && allPost;
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const report: CaseReport = {
    id: c.id,
    category: c.category,
    expect: c.expect,
    outcome: outcomes.map(outcomeLabel).join(" | ") || "(none)",
    outcomeDetail: Object.keys(extra).length ? extra : undefined,
    durationMs: +durationMs.toFixed(1),
    evidence: evidence.length ? evidence : undefined,
    postconditions: pc,
    pass,
    detail: judge.detail,
    note: c.note,
  };
  if ((c.expect as { terminated?: string }).terminated) {
    report.terminationWithinBound =
      outcomes[0] !== undefined && outcomes[0].durationMs <= timeoutMs + 500;
  }
  reports.push(report);
  console.log(
    `[${pass ? "PASS" : "FAIL"}] ${c.id} ${judge.detail.slice(0, 140)}${allPost ? "" : " POSTCOND:" + JSON.stringify(pc)}`,
  );
}

// ---------- 汇总与落盘 ----------

const summary = {
  total: reports.length,
  passed: reports.filter((r) => r.pass).length,
  failed: reports.filter((r) => !r.pass).map((r) => r.id),
  canaryEnv,
  sentinelConnections,
  platform: { os: os.platform(), arch: os.arch(), node: process.version },
};
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, "cases.json"),
  JSON.stringify({ summary, cases: reports }, null, 2),
);
console.log(
  `\n${summary.passed}/${summary.total} passed; failed: ${summary.failed.join(",") || "-"}`,
);
console.log(`results → ${path.join(RESULTS_DIR, "cases.json")}`);

sentinelServer.close();
await sandbox.dispose();
// 引用宿主金丝雀，确保其确实存活在宿主内存中（防误删）
if (hostSecretHolder.secret !== canaryHost) throw new Error("canary mutated");
