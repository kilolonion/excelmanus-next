import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db.ts";
import { FileLeaseError, LeaseService, normalizeLeaseTarget } from "../src/leases.ts";
import { KERNEL_MIGRATIONS } from "../src/migrations.ts";
import {
  isInsidePath,
  isInternalName,
  registerProtectedRoot,
  resolveWorkspacePath,
} from "../src/paths.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 当前卷是否不区分大小写（macOS APFS 默认、Windows NTFS）。 */
function caseInsensitive(dir: string): boolean {
  writeFileSync(join(dir, "probe-ci"), "");
  try {
    realpathSync.native(join(dir, "PROBE-CI"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(join(dir, "probe-ci"), { force: true });
  }
}

describe("路径规范化与内部目录隐藏（P0-09/P0-10/P0-13）", () => {
  test("内部目录名按大小写与 Unicode 折叠识别", () => {
    for (const n of [".excelmanus", ".EXCELMANUS", ".excelmanuſ", ".excelmanus.", ".excelmanus "])
      expect(isInternalName(n)).toBe(true);
    for (const n of [".excelmanus-next", "excelmanus", ".excelmanu"])
      expect(isInternalName(n)).toBe(false);
  });

  test("任意层的 .excelmanus 及其别名都不可见", () => {
    const root = tmp("excelmanus-paths-");
    mkdirSync(join(root, ".excelmanus", "tmp"), { recursive: true });
    mkdirSync(join(root, "sub", ".excelmanus"), { recursive: true });
    writeFileSync(join(root, ".excelmanus", "tmp", "probe.txt"), "secret");
    for (const p of [
      ".excelmanuſ/tmp/probe.txt",
      ".EXCELMANUS/tmp/probe.txt",
      ".excelmanuſ/tmp/new.txt",
      "sub/.excelmanus/x",
      "sub/.Excelmanuſ",
    ])
      expect(() => resolveWorkspacePath(root, p), p).toThrow(/路径不存在/);
  });

  test("存在部分返回磁盘规范拼写，rel 由规范 abs 反推", () => {
    const root = tmp("excelmanus-paths-case-");
    mkdirSync(join(root, "Data"));
    writeFileSync(join(root, "Data", "Sales.xlsx"), "x");
    expect(resolveWorkspacePath(root, "Data/./x/../Sales.xlsx").rel).toBe("Data/Sales.xlsx");
    if (!caseInsensitive(root)) return;
    const a = resolveWorkspacePath(root, "data/SALES.XLSX");
    expect(a.rel).toBe("Data/Sales.xlsx");
    expect(a.abs).toBe(join(root, "Data", "Sales.xlsx"));
    expect(resolveWorkspacePath(root, "DATA/new.txt").rel).toBe("Data/new.txt");
  });

  test("受保护的数据目录对不在其内的工作区不可见", () => {
    const parent = tmp("excelmanus-paths-prot-");
    const dataDir = join(parent, "data");
    mkdirSync(join(dataDir, "workspace"), { recursive: true });
    writeFileSync(join(dataDir, "master.key"), "k");
    writeFileSync(join(dataDir, "workspace", "a.txt"), "a");
    mkdirSync(join(dataDir, "blobs"));
    registerProtectedRoot(dataDir, { exempt: join(dataDir, "workspace") });
    expect(() => resolveWorkspacePath(parent, "data/master.key")).toThrow(/路径不存在/);
    expect(() => resolveWorkspacePath(parent, "data")).toThrow(/路径不存在/);
    // 旧库登记的工作区 = 数据目录本身 / 数据目录内其他子目录：同样拒绝
    expect(() => resolveWorkspacePath(dataDir, "master.key")).toThrow(/路径不存在/);
    expect(() => resolveWorkspacePath(join(dataDir, "blobs"), "x")).toThrow(/路径不存在/);
    // 默认工作区（豁免子树）：照常可用
    expect(resolveWorkspacePath(join(dataDir, "workspace"), "a.txt").rel).toBe("a.txt");
    expect(isInsidePath(parent, dataDir)).toBe(true);
    expect(isInsidePath(dataDir, `${dataDir}x`)).toBe(false);
  });
});

describe("租约目标规范化（P1-19）", () => {
  test("尾斜杠目录、.. 与大小写别名都按同一目标判定", () => {
    const root = tmp("excelmanus-lease-norm-");
    writeFileSync(join(root, "report.xlsx"), "x");
    mkdirSync(join(root, "out"));
    const db = openDb(join(root, "db.sqlite"), KERNEL_MIGRATIONS);
    db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES ('ws','w',?,?)").run(
      root,
      new Date().toISOString(),
    );
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sessions(id, workspace_id, created_at, updated_at) VALUES ('ses_1','ws',?,?)",
    ).run(now, now);
    const leases = new LeaseService(db);
    leases.acquire({ sessionId: "ses_1", agentId: "a", targets: ["out/", "report.xlsx"] });
    const blocked = ["out/x.xlsx", "tmp/../report.xlsx", "./out", "report.xlsx!Sheet1!A1"];
    if (caseInsensitive(root)) blocked.push("Report.xlsx", "OUT/y.csv");
    for (const t of blocked)
      expect(
        () => leases.assertAvailable({ sessionId: "ses_1", agentId: "b", targets: [t] }),
        t,
      ).toThrow(FileLeaseError);
    expect(() =>
      leases.assertAvailable({ sessionId: "ses_1", agentId: "b", targets: ["outx/a.xlsx"] }),
    ).not.toThrow();
    expect(normalizeLeaseTarget("out//", undefined)).toBe("out");
    expect(normalizeLeaseTarget("./", undefined)).toBe(".");
    db.close();
  });
});
