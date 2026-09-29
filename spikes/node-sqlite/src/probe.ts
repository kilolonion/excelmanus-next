// node:sqlite 探针：同一套代码分别在 Node / ELECTRON_RUN_AS_NODE /
// Electron 主进程 / Electron utilityProcess 内运行，结果写 results/<name>.json。
// 子进程实验一律以 ELECTRON_RUN_AS_NODE=1 拉起 process.execPath，
// 使 Node 宿主与 Electron 宿主下的测量口径一致。

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(SRC_DIR);
const RESULTS_DIR = path.join(PKG_DIR, "results");

// node:sqlite 的最小接口形状（不依赖 @types/node 的版本新鲜度）
interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface DB {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
type DatabaseSyncCtor = new (p: string) => DB;

interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const pick = (p: number) =>
    s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
  return {
    n: xs.length,
    min: +s[0]!.toFixed(3),
    p50: +pick(50).toFixed(3),
    p95: +pick(95).toFixed(3),
    p99: +pick(99).toFixed(3),
    max: +s[s.length - 1]!.toFixed(3),
  };
}

function ms(x: number): number {
  return Math.round(x * 1000) / 1000;
}

interface ProbeResult {
  env: Record<string, unknown>;
  import: Record<string, unknown>;
  sqliteVersion?: string;
  pragmas?: Record<string, unknown>;
  fts5?: Record<string, unknown>;
  json1?: Record<string, unknown>;
  txn?: Record<string, unknown>;
  crash?: Record<string, unknown>;
  twoConn?: Record<string, unknown>;
  notes: string[];
}

const notes: string[] = [];

function pragma1(db: DB, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : undefined;
}

// ---------- 子进程工具 ----------

function spawnChild(
  args: string[],
  opts: { timeoutMs?: number } = {},
): {
  stdout: string[];
  stderr: string[];
  done: Promise<{ code: number | null; signal: string | null }>;
  kill: (sig: string) => void;
} {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (b: Buffer) => stdout.push(b.toString()));
  child.stderr.on("data", (b: Buffer) => stderr.push(b.toString()));
  const done = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.on("exit", (code, signal) => res({ code, signal }));
  });
  if (opts.timeoutMs) {
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    void done.finally(() => clearTimeout(t));
  }
  return { stdout, stderr, done, kill: (sig) => child.kill(sig as NodeJS.Signals) };
}

// ---------- 各项测量 ----------

function flagProbe(): Record<string, unknown> {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "-e",
      'import("node:sqlite").then(()=>console.log("OK"),(e)=>{console.error("IMPERR",e.message);process.exit(2)})',
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 },
  );
  return {
    acceptedFlag: r.status !== 9 && !(r.stderr ?? "").includes("bad option"),
    exitStatus: r.status,
    importOk: (r.stdout ?? "").includes("OK"),
    stderrTail: (r.stderr ?? "").trim().split("\n").slice(-2).join("\n"),
  };
}

function pragmaTest(db: DB): Record<string, unknown> {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  return {
    journal_mode: pragma1(db, "journal_mode"),
    synchronous: pragma1(db, "synchronous"),
    foreign_keys: pragma1(db, "foreign_keys"),
    busy_timeout: pragma1(db, "busy_timeout"),
    expected: { journal_mode: "wal", synchronous: 1, foreign_keys: 1, busy_timeout: 5000 },
  };
}

const CN_ROWS = [
  "沙箱隔离模型生成代码的执行环境",
  "记忆检索需要可靠的中文分词",
  "会议纪要讨论沙箱与持久化",
  "完全无关的一句中文文本",
];

function fts5Test(db: DB): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const mk = (name: string, tok?: string) => {
    db.exec(`CREATE VIRTUAL TABLE ${name} USING fts5(content${tok ? `, tokenize='${tok}'` : ""})`);
    const ins = db.prepare(`INSERT INTO ${name}(content) VALUES(?)`);
    for (const r of CN_ROWS) ins.run(r);
  };
  const tryMatch = (t: string, q: string): unknown => {
    try {
      const rows = db.prepare(`SELECT rowid, content FROM ${t} WHERE ${t} MATCH ?`).all(q);
      return { hits: rows.map((r) => r.rowid) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  try {
    mk("d_uni");
    out.unicode61 = {
      queries: {
        生成: tryMatch("d_uni", "生成"),
        模型生成: tryMatch("d_uni", "模型生成"),
        检索: tryMatch("d_uni", "检索"),
        沙箱隔离模型: tryMatch("d_uni", "沙箱隔离模型"),
      },
      note: "unicode61 对中文大概率把整句当一个 token：子串检索预期 0 命中或仅整句命中",
    };
  } catch (e) {
    out.unicode61Error = e instanceof Error ? e.message : String(e);
  }
  try {
    mk("d_tri", "trigram");
    out.trigram = {
      queries: {
        生成代: tryMatch("d_tri", "生成代"),
        模型生成: tryMatch("d_tri", "模型生成"),
        要可靠: tryMatch("d_tri", "要可靠"),
        沙箱: tryMatch("d_tri", "沙箱"),
      },
      note: "trigram 应能命中 3 字以上中文子串；2 字 '沙箱' 行为记录于实测",
    };
  } catch (e) {
    out.trigramError = e instanceof Error ? e.message : String(e);
  }
  return out;
}

function txnBench(db: DB): Record<string, unknown> {
  db.exec(`CREATE TABLE session_log(
    session_id TEXT, seq INTEGER, type TEXT, data TEXT, created_at TEXT,
    PRIMARY KEY(session_id, seq))`);
  db.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY, last_seq INTEGER)`);
  const ins = db.prepare(
    "INSERT INTO session_log(session_id,seq,type,data,created_at) VALUES(?,?,?,?,?)",
  );
  const upd = db.prepare(
    "INSERT INTO sessions(session_id,last_seq) VALUES(?,?) " +
      "ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq",
  );
  const N = 10_000;
  const times: number[] = new Array(N);
  const pad = "x".repeat(950);
  for (let i = 0; i < N; i++) {
    const data = JSON.stringify({ i, pad, kind: "run.started" });
    const t0 = performance.now();
    db.exec("BEGIN IMMEDIATE");
    ins.run("s1", i + 1, "log.append", data, new Date().toISOString());
    upd.run("s1", i + 1);
    db.exec("COMMIT");
    times[i] = performance.now() - t0;
  }
  const perTxn = stats(times);
  // 一批 100 条日志的单事务
  const b0 = performance.now();
  db.exec("BEGIN IMMEDIATE");
  for (let i = N; i < N + 100; i++) {
    ins.run("s1", i + 1, "log.append", JSON.stringify({ i, pad }), new Date().toISOString());
  }
  upd.run("s1", N + 100);
  db.exec("COMMIT");
  const batchMs = performance.now() - b0;
  return {
    perTxnMs: perTxn,
    batch100: { totalMs: ms(batchMs), perRowMs: ms(batchMs / 100) },
    criterion: "每个事务目标 <5ms，p99>20ms 则需移入 worker",
  };
}

async function crashTest(tmp: string): Promise<Record<string, unknown>> {
  const dbp = path.join(tmp, "crash.db");
  const childPath = path.join(SRC_DIR, "crash-child.ts");
  // 子进程每条提交之间主动停 2ms，保证父进程来得及在 500 条时 SIGKILL
  const c = spawnChild([childPath, dbp, "1000", "2"], { timeoutMs: 60_000 });
  const ctrl = { lastSeen: 0, killed: false };
  // stdout 数据到达即解析最后一个 COMMIT n，≥500 即杀
  const origPush = c.stdout.push.bind(c.stdout);
  c.stdout.push = ((chunk: string) => {
    const m = chunk.match(/COMMIT (\d+)/g);
    if (m) ctrl.lastSeen = Number(m[m.length - 1]!.split(" ")[1]);
    if (!ctrl.killed && ctrl.lastSeen >= 500) {
      ctrl.killed = true;
      c.kill("SIGKILL");
    }
    return origPush(chunk);
  }) as typeof c.stdout.push;
  const exitInfo = await c.done;
  // 重新打开校验
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: DatabaseSyncCtor;
  };
  const db = new DatabaseSync(dbp);
  const rows = db.prepare("SELECT count(*) c FROM t").get()?.c as number;
  const ic = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  db.close();
  return {
    lastSeenCommit: ctrl.lastSeen,
    killed: ctrl.killed,
    exit: exitInfo,
    committedRowsAfterReopen: rows,
    rowsGeLastSeen: rows >= ctrl.lastSeen,
    integrityCheck: ic,
    note: "WAL + per-txn commit：杀前已确认提交的行重启后必须仍在",
  };
}

async function twoConnTest(tmp: string): Promise<Record<string, unknown>> {
  const dbp = path.join(tmp, "twoconn.db");
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: DatabaseSyncCtor;
  };
  const db1 = new DatabaseSync(dbp);
  db1.exec("PRAGMA journal_mode=WAL");
  db1.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const lockChildPath = path.join(SRC_DIR, "lock-child.ts");
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (t: number) => Atomics.wait(sab, 0, 0, t);

  const scenario = async (childBusyTimeoutMs: number, holdMs: number) => {
    db1.exec("BEGIN IMMEDIATE");
    db1.prepare("INSERT INTO t(v) VALUES('holder')").run();
    const c = spawnChild([lockChildPath, dbp, String(childBusyTimeoutMs)], {
      timeoutMs: holdMs + childBusyTimeoutMs + 10_000,
    });
    sleep(holdMs);
    db1.exec("COMMIT");
    const ex = await c.done;
    return {
      childBusyTimeoutMs,
      holdMs,
      childOutput: c.stdout.join("").trim(),
      childStderr: c.stderr.join("").trim().split("\n").slice(-1)[0],
      exit: ex,
    };
  };
  const out: Record<string, unknown> = {};
  out.blockThenSucceed = await scenario(5000, 1500);
  out.timeoutFails = await scenario(200, 1500);
  db1.close();
  return out;
}

// ---------- 主流程 ----------

export async function runProbe(outName: string): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  process.on("warning", (w) => warnings.push(`${w.name}: ${w.message.split("\n")[0]}`));

  const res: ProbeResult = {
    env: {
      name: outName,
      execPath: process.execPath,
      node: process.version,
      electron: (process.versions as Record<string, string | undefined>).electron ?? null,
      v8: process.versions.v8,
      platform: `${os.platform()}/${os.arch()}`,
      processType: (process as unknown as { type?: string }).type ?? "node",
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
      tsLoaderNote: "由宿主 Node 直接执行 .ts（类型剥离）",
      warnings,
      // Electron 主进程入口可注入 app 生命周期状态
      ...((globalThis as Record<string, unknown>).__PROBE_ENV_EXTRA as
        | Record<string, unknown>
        | undefined),
    },
    import: {},
    notes,
  };

  let DatabaseSync: DatabaseSyncCtor;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: DatabaseSyncCtor;
    });
    res.import = { ok: true, withoutFlag: true, flagProbe: flagProbe() };
  } catch (e) {
    res.import = {
      ok: false,
      withoutFlag: false,
      error: e instanceof Error ? e.message : String(e),
      flagProbe: flagProbe(),
    };
    write(outName, res);
    return res as unknown as Record<string, unknown>;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nsp-"));
  try {
    const dbp = path.join(tmp, "main.db");
    const db = new DatabaseSync(dbp);
    res.sqliteVersion = db.prepare("SELECT sqlite_version() v").get()?.v as string;
    res.pragmas = pragmaTest(db);
    res.fts5 = fts5Test(db);
    const jv = db.prepare(`SELECT json_extract('{"a":{"b":[1,2,3]}}','$.a.b[1]') v`).get()?.v;
    res.json1 = { ok: jv === 2, value: jv };
    res.txn = txnBench(db);
    db.close();
    res.crash = await crashTest(tmp);
    res.twoConn = await twoConnTest(tmp);
  } catch (e) {
    notes.push(`probe aborted mid-way: ${e instanceof Error ? e.message : e}`);
    res.notes = notes;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  write(outName, res);
  return res as unknown as Record<string, unknown>;
}

function write(name: string, res: ProbeResult): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const p = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(res, null, 2));
  console.log(`results → ${p}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const name = process.argv[2] ?? "node";
  const wd = setTimeout(() => {
    console.error("probe watchdog: exceeded 240s");
    process.exit(3);
  }, 240_000);
  runProbe(name)
    .catch((e) => {
      console.error("probe failed:", e);
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(wd));
}
