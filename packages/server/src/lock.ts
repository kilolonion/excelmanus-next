// instance.lock 单实例锁（10 §2）：同一数据目录只允许一个后端进程。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class InstanceLockError extends Error {
  constructor(pid: number) {
    super(`数据目录已被另一个实例占用（pid=${pid}）`);
    this.name = "InstanceLockError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireInstanceLock(dataDir: string): { release(): void } {
  const p = join(dataDir, "instance.lock");
  if (existsSync(p)) {
    const old = Number(readFileSync(p, "utf8").trim());
    if (Number.isInteger(old) && old > 0 && old !== process.pid && pidAlive(old)) {
      throw new InstanceLockError(old);
    }
  }
  writeFileSync(p, String(process.pid), { mode: 0o600 });
  return {
    release: () => {
      try {
        if (readFileSync(p, "utf8").trim() === String(process.pid)) rmSync(p);
      } catch {
        // 已删除则忽略
      }
    },
  };
}
