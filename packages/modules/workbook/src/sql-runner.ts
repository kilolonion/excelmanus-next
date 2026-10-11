import { spawn } from "node:child_process";
import { FileOperationError } from "@excelmanus/kernel";
export interface SqlTable {
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
}
// Source is bundled as a string so packaged desktop builds need no external worker asset.
// The subprocess runs only trusted SQLite orchestration; model SQL cannot access JS or filesystem.
// Process isolation permits hard cancellation even while SQLite is executing native code.
const source = String.raw`
process.once("message",workerData=>{
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec('PRAGMA hard_heap_limit=134217728; PRAGMA temp_store=MEMORY');
try {
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 db.exec('BEGIN');
 for(const table of workerData.tables){
  db.exec('CREATE TABLE '+quote(table.name)+' ('+table.columns.map(quote).join(',')+')');
  const insert=db.prepare('INSERT INTO '+quote(table.name)+' VALUES ('+table.columns.map(()=>'?').join(',')+')');
  for(const row of table.rows)insert.run(...row);
 }
 db.function('regexp',(pattern,value)=>new RegExp(pattern,'u').test(String(value??''))?1:0);
 db.exec('COMMIT; PRAGMA query_only=ON');
 const stmt=db.prepare(workerData.sql);
 const columns=stmt.columns().map(c=>c.name), rows=[];
 if(new Set(columns).size!==columns.length)throw Error('结果列名重复，请使用 AS 为列指定不同名称');
 for(const row of stmt.iterate()){
  if((rows.length+1)*Math.max(columns.length,1)>200000)throw Error('查询结果最多20万格，请用 LIMIT 或聚合缩小结果');
  rows.push(row);
 }
 process.send({ok:true,rows,columns});
}catch(e){process.send({ok:false,error:e.message});}
finally{db.close();process.disconnect();}
});
`;
export async function runSql(
  tables: SqlTable[],
  sql: string,
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  if (Buffer.byteLength(JSON.stringify(tables), "utf8") > 32 * 1024 * 1024)
    throw new FileOperationError("LIMIT_EXCEEDED", "SQL 输入序列化后最多32MiB");
  const child = spawn(process.execPath, ["--max-old-space-size=128", "-e", source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    return await new Promise<{ rows: Record<string, unknown>[]; columns: string[] }>(
      (resolve, reject) => {
        const fail = (message: string, code: "TIMEOUT" | "INVALID_ARGUMENT" = "INVALID_ARGUMENT") =>
          reject(new FileOperationError(code, message));
        timer = setTimeout(
          () => fail("SQL 查询超时，已终止独立查询进程，请缩小查询范围", "TIMEOUT"),
          timeoutMs,
        );
        abort = () => fail("SQL 查询已取消");
        child.once("message", (value) => {
          const message = value as {
            ok: boolean;
            rows: Record<string, unknown>[];
            columns: string[];
            error?: string;
          };
          if (message.ok) resolve({ rows: message.rows, columns: message.columns });
          else fail(String(message.error));
        });
        child.once("error", (error) => fail(error.message));
        child.once("exit", () => fail("SQL 查询进程退出且未返回结果"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else
          child.send({ tables, sql }, (error) => {
            if (error) fail(error.message);
          });
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
  }
}
