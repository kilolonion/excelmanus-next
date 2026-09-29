// 双连接锁竞争子进程：以给定 busy_timeout 打开同一 db 文件并尝试写入一行，
// 打印 "OK <ms>" 或 "BUSY <ms>"。父进程持锁期间本进程的行为即测量对象。

const [dbp, btS] = process.argv.slice(2);
if (!dbp) throw new Error("usage: lock-child.ts <dbPath> <busyTimeoutMs>");
const bt = Number(btS ?? "5000");

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
db.exec(`PRAGMA busy_timeout=${bt}`);
const t0 = performance.now();
try {
  db.prepare("INSERT INTO t(v) VALUES('child')").run();
  process.stdout.write(`OK ${(performance.now() - t0).toFixed(1)}\n`);
} catch (e) {
  process.stdout.write(
    `BUSY ${(performance.now() - t0).toFixed(1)} ${e instanceof Error ? e.message : e}\n`,
  );
}
