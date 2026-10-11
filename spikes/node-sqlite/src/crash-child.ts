// 崩溃耐久性子进程：打开 db 文件，逐条提交 1000 个事务，每提交一条打印 "COMMIT n"。
// 父进程在看到足够提交数后 SIGKILL；子进程不需要做任何清理。

const [dbp, totalS, paceS] = process.argv.slice(2);
if (!dbp) throw new Error("usage: crash-child.ts <dbPath> <total> <paceMs>");
const total = Number(totalS ?? "1000");
const paceMs = Number(paceS ?? "0");
const sab = new Int32Array(new SharedArrayBuffer(4));

const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
  DatabaseSync: new (
    p: string,
  ) => {
    exec(s: string): void;
    prepare(s: string): { run(...p: unknown[]): unknown };
    close(): void;
  };
};

const db = new DatabaseSync(dbp);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
const ins = db.prepare("INSERT INTO t(v) VALUES(?)");
for (let i = 1; i <= total; i++) {
  db.exec("BEGIN IMMEDIATE");
  ins.run(`row-${i}`);
  db.exec("COMMIT");
  process.stdout.write(`COMMIT ${i}\n`);
  if (paceMs > 0) Atomics.wait(sab, 0, 0, paceMs);
}
process.exit(0);
