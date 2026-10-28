import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentToolAccess,
  resolveWorkspacePath,
  type ToolDefinition,
  withFileAccessSync,
} from "@excelmanus/kernel";
import {
  createApiClient,
  type LogRecord,
  numericRefId,
  type StepEvent,
} from "@excelmanus/protocol";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { startServer } from "../src/index.ts";
import { createTestProfile } from "./fixtures/create-model.ts";

const input = z.object({ stage: z.enum(["targets", "intentMeta", "execute"]), path: z.string() });
const text: StepEvent[] = [
  { kind: "text.delta", text: "没有访问任何其他文件" },
  { kind: "finish", reason: "stop" },
];

test("真实HTTP可信生命周期守住pre-target/meta/execute，并保留继续而重置无关新任务", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scope-lifecycle-"));
  const plans: StepEvent[][] = [];
  const stages: string[] = [];
  const probe: ToolDefinition<z.infer<typeof input>> = {
    name: "scope_probe",
    title: "probe",
    description: "test",
    input,
    output: z.unknown(),
    roles: ["main"],
    effect: "read",
    replay: "safe",
    timeoutMs: 5000,
    targets(args, scope) {
      expect(currentToolAccess()).toBeDefined();
      stages.push("targets");
      if (args.stage === "targets") resolveWorkspacePath(scope!.workspaceRoot, args.path);
      return [];
    },
    intentMeta(args, ctx) {
      expect(currentToolAccess()).toBe(ctx.access);
      stages.push("intentMeta");
      if (args.stage === "intentMeta") resolveWorkspacePath(ctx.workspaceRoot, args.path);
      return undefined as never;
    },
    execute(args, ctx) {
      expect(currentToolAccess()).toBe(ctx.access);
      stages.push("execute");
      const data = withFileAccessSync({ kind: "file-bytes", path: args.path }, () =>
        readFileSync(join(ctx.workspaceRoot, args.path), "utf8"),
      );
      return { status: "ok", data };
    },
  };
  const server = await startServer({
    dataDir,
    log: () => {},
    modules: [{ id: "scope-test", tools: [probe] }],
    gateway: {
      async *step() {
        for (const event of plans.shift() ?? text) yield event;
      },
    },
  });
  try {
    for (const dir of ["allowed", "outside"]) {
      mkdirSync(join(server.workspaceRoot, dir));
      writeFileSync(join(server.workspaceRoot, dir, "x.txt"), dir);
    }
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "scope-test",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    let lastSeq = 0;
    async function turn(
      message: string,
      stage: "targets" | "intentMeta" | "execute",
      path: string,
    ) {
      stages.length = 0;
      const callId = `c${lastSeq}`;
      plans.push(
        [
          {
            kind: "tool.call",
            toolCallId: callId,
            toolName: "scope_probe",
            args: { stage, path },
            rawArgs: JSON.stringify({ stage, path }),
          },
          { kind: "finish", reason: "tool-calls" },
        ],
        text,
        text,
      );
      await api.sendMessage(session.id, "main", { clientMessageId: `m${lastSeq}`, text: message });
      let items: LogRecord[] = [];
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        items = (await api.getSessionLog(session.id, { limit: 1000 })).items.filter(
          (r) => r.seq > lastSeq,
        );
        if (items.some((r) => r.type === "turn.completed" || r.type === "turn.failed")) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(items.some((r) => r.type === "turn.completed" || r.type === "turn.failed")).toBe(true);
      lastSeq = Math.max(...items.map((r) => r.seq));
      plans.length = 0;
      return items;
    }
    let rows = await turn("仅访问目录 allowed，检查文件", "targets", "outside/x.txt");
    expect(stages).toEqual(["targets"]);
    expect(rows.find((r) => r.type === "tool.result")?.data.result).toMatchObject({
      status: "error",
    });
    const origin = (
      rows.find((r) => r.type === "turn.started")!.data.accessBinding as { originTurnId: string }
    ).originTurnId;
    expect(
      rows
        .filter((r) => r.type === "model.output" && typeof r.data.text === "string")
        .map((r) => r.data.text)
        .join("\n"),
    ).not.toContain("没有访问任何其他文件");
    rows = await turn("继续", "intentMeta", "outside/x.txt");
    expect(stages).toEqual(["targets", "intentMeta"]);
    expect(rows.find((r) => r.type === "turn.started")?.data.accessBinding).toMatchObject({
      originTurnId: origin,
      decision: { kind: "restricted", root: "allowed" },
    });
    rows = await turn("仅访问目录 allowed，读取内容", "execute", "outside/x.txt");
    expect(stages).toEqual(["targets", "intentMeta", "execute"]);
    expect(rows.find((r) => r.type === "tool.result")?.data.result).toMatchObject({
      status: "error",
    });
    rows = await turn("分析 outside/x.txt", "execute", "outside/x.txt");
    expect(rows.find((r) => r.type === "tool.result")?.data.result).toMatchObject({
      status: "ok",
      data: "outside",
    });
    expect(rows.find((r) => r.type === "turn.started")?.data.accessBinding).toMatchObject({
      decision: { kind: "unbounded" },
    });
    expect(rows.some((r) => r.type === "access.fact")).toBe(false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

test("context 受理先按有效scope查DB路径，继续继承，允许选区在绑定后才snapshot", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scope-context-"));
  let modelCalls = 0;
  const server = await startServer({
    dataDir,
    log: () => {},
    gateway: {
      async *step() {
        modelCalls++;
        for (const event of text) yield event;
      },
    },
  });
  try {
    mkdirSync(join(server.workspaceRoot, "allowed"));
    mkdirSync(join(server.workspaceRoot, "outside"));
    writeFileSync(join(server.workspaceRoot, "allowed", "x.csv"), "a,b\n1,2");
    writeFileSync(join(server.workspaceRoot, "outside", "x.csv"), "x,y\n3,4");
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "mock",
      provider: "custom-openai-compatible",
      model: "scope-context",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({});
    const allowed = (await api.openDoc(session.workspaceId, { path: "allowed/x.csv" })).document;
    const outside = (await api.openDoc(session.workspaceId, { path: "outside/x.csv" })).document;
    const outsideRef = { docId: outside.id, rev: outside.rev, range: "A1" };
    await expect(
      api.sendMessage(session.id, "main", {
        clientMessageId: "out-context",
        text: "仅访问目录 allowed，检查选区",
        context: [outsideRef],
      }),
    ).rejects.toThrow(/允许目录/);
    expect(modelCalls).toBe(0);
    await api.sendMessage(session.id, "main", {
      clientMessageId: "in-context",
      text: "仅访问目录 allowed，检查选区",
      context: [{ docId: allowed.id, rev: allowed.rev, range: "A1" }],
    });
    let rows: LogRecord[] = [];
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      rows = (await api.getSessionLog(session.id, { limit: 1000 })).items;
      if (rows.some((r) => r.type === "turn.completed")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rows.some((r) => r.type === "turn.context.validated")).toBe(true);
    const start = rows.find((r) => r.type === "turn.started")!.seq;
    expect(rows.filter((r) => r.type === "access.fact").every((r) => r.seq > start)).toBe(true);
    expect(rows.some((r) => r.type === "access.fact" && r.data.path === "allowed/x.csv")).toBe(
      true,
    );
    const before = modelCalls;
    await expect(
      api.sendMessage(session.id, "main", {
        clientMessageId: "continue-context",
        text: "继续",
        context: [outsideRef],
      }),
    ).rejects.toThrow(/允许目录/);
    expect(modelCalls).toBe(before);
    await api.sendMessage(session.id, "main", {
      clientMessageId: "ambiguous",
      text: "不得访问其他目录，检查 x.csv",
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      rows = (await api.getSessionLog(session.id, { limit: 1000 })).items;
      if (rows.filter((r) => r.type === "turn.completed").length === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(modelCalls).toBe(before);
    expect(
      rows.filter((r) => r.type === "model.output" && r.data.deliveryStatus === "incomplete").at(-1)
        ?.data.text,
    ).toContain("仅访问目录 <相对目录>");
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);

const finiteIo = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; path: string }>,
  afterCopy: undefined as undefined | ((from: string, to: string) => void),
  descriptors: new Map<number, string>(),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...a: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...a);
      finiteIo.descriptors.set(fd, String(a[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      finiteIo.descriptors.delete(fd);
      return fs.closeSync(fd);
    },
    fchmodSync: (...a: Parameters<typeof fs.fchmodSync>) => {
      fs.fchmodSync(...a);
      const to = finiteIo.descriptors.get(a[0]);
      const from = [...finiteIo.descriptors.values()].find(
        (p) => p === to?.replace(/output\.txt$/, "source.txt"),
      );
      if (from && to) finiteIo.afterCopy?.(from, to);
    },
    copyFileSync: (...a: Parameters<typeof fs.copyFileSync>) => {
      const result = fs.copyFileSync(...a);
      finiteIo.afterCopy?.(String(a[0]), String(a[1]));
      return result;
    },
    readdirSync: (...a: Parameters<typeof fs.readdirSync>) => {
      finiteIo.calls.push({ kind: "list", path: String(a[0]) });
      return fs.readdirSync(...a);
    },
    lstatSync: (...a: Parameters<typeof fs.lstatSync>) => {
      finiteIo.calls.push({ kind: "stat", path: String(a[0]) });
      return fs.lstatSync(...a);
    },
    statSync: (...a: Parameters<typeof fs.statSync>) => {
      finiteIo.calls.push({ kind: "stat", path: String(a[0]) });
      return fs.statSync(...a);
    },
    readFileSync: (...a: Parameters<typeof fs.readFileSync>) => {
      finiteIo.calls.push({ kind: "read", path: String(a[0]) });
      return fs.readFileSync(...a);
    },
  };
});

test("finite files: real HTTP blocks root discovery and source actor writes but permits exact copy edit finalization and download", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "finite-http-"));
  const plans: StepEvent[][] = [];
  const server = await startServer({
    dataDir,
    log: () => {},
    gateway: {
      async *step() {
        for (const event of plans.shift() ?? text) yield event;
      },
    },
  });
  try {
    const api = createApiClient(server.url, server.token);
    await createTestProfile(api, {
      name: "finite",
      provider: "custom-openai-compatible",
      model: "finite",
      baseUrl: "https://mock.invalid/v1",
      apiKey: "test",
    });
    const { session } = await api.createSession({ permissionMode: "auto" });
    await api.createFile(session.workspaceId, "source.xlsx");
    await api.createFile(session.workspaceId, "neighbor.xlsx");
    const source = (await api.openDoc(session.workspaceId, { path: "source.xlsx" })).document;
    const neighbor = (await api.openDoc(session.workspaceId, { path: "neighbor.xlsx" })).document;
    const before = readFileSync(join(server.workspaceRoot, "source.xlsx"));
    const snapshot = await api.getDocSnapshot(session.workspaceId, source.id);
    const revisions = await api.listDocRevisions(session.workspaceId, source.id);
    const calls = [
      ["finite-find", "find", { path: ".", glob: "source*.xlsx" }],
      ["finite-neighbor", "workbook_read", { path: "neighbor.xlsx", mode: "overview" }],
      [
        "finite-source-path",
        "workbook_edit",
        { path: "source.xlsx", ops: [{ op: "cells.set", range: "A1", values: [[98]] }] },
      ],
      [
        "finite-source-id",
        "workbook_edit",
        { docId: source.id, ops: [{ op: "cells.set", range: "A1", values: [[99]] }] },
      ],
      ["finite-source-recalc", "workbook_edit", { docId: source.id, ops: [{ op: "recalculate" }] }],
      [
        "finite-source-dryrun",
        "workbook_edit",
        {
          docId: source.id,
          dryRun: true,
          ops: [{ op: "cells.set", range: "A1", values: [[100]] }],
        },
      ],
      ["finite-mkdir", "files", { ops: [{ op: "mkdir", path: "extra" }] }],
      ["finite-copy", "files", { ops: [{ op: "copy", path: "source.xlsx", to: "output.xlsx" }] }],
      [
        "finite-edit",
        "workbook_edit",
        { path: "output.xlsx", ops: [{ op: "cells.set", range: "A1", values: [[7]] }] },
      ],
      [
        "finite-read",
        "workbook_read",
        { path: "output.xlsx", mode: "range", range: "A1", facets: ["values"] },
      ],
      [
        "finite-present",
        "present",
        {
          finalize: {
            status: "complete",
            sources: [
              { refId: numericRefId({ toolCallId: "finite-read", pointer: "/data/values/0/0" }) },
            ],
          },
        },
      ],
    ] as const;
    for (const [toolCallId, toolName, args] of calls)
      plans.push([
        { kind: "tool.call", toolCallId, toolName, args, rawArgs: JSON.stringify(args) },
        { kind: "finish", reason: "tool-calls" },
      ]);
    finiteIo.calls.length = 0;
    await expect(
      api.sendMessage(session.id, "main", {
        clientMessageId: "finite-context-outside",
        text: "把当前 source.xlsx 另存为 output.xlsx，只处理这两个文件，不访问或修改其他文件。",
        context: [{ docId: neighbor.id, rev: neighbor.rev, range: "A1" }],
      }),
    ).rejects.toThrow(/允许目录或文件集合/);
    expect(
      finiteIo.calls.filter((c) => c.path === join(server.workspaceRoot, "neighbor.xlsx")),
    ).toEqual([]);
    finiteIo.calls.length = 0;
    await api.sendMessage(session.id, "main", {
      clientMessageId: "finite",
      text: "把当前 source.xlsx 另存为 output.xlsx，只处理这两个文件，不访问或修改其他文件。完成后报告 output.xlsx 的 A1 数值。",
    });
    let rows: LogRecord[] = [];
    await vi.waitFor(
      async () => {
        rows = (await api.getSessionLog(session.id, { limit: 2000 })).items;
        expect(rows.some((r) => r.type === "turn.completed" || r.type === "turn.failed")).toBe(
          true,
        );
      },
      { timeout: 30000, interval: 20 },
    );
    const io = [...finiteIo.calls];
    expect.soft(rows.find((r) => r.type === "turn.started")?.data.accessBinding).toMatchObject({
      decision: {
        kind: "files",
        readPaths: ["source.xlsx", "output.xlsx"],
        writePaths: ["output.xlsx"],
      },
      accessDeliveryRequired: true,
    });
    for (const id of [
      "finite-find",
      "finite-neighbor",
      "finite-source-path",
      "finite-source-id",
      "finite-source-recalc",
      "finite-source-dryrun",
      "finite-mkdir",
    ])
      expect
        .soft(
          rows.find((r) => r.type === "tool.result" && r.data.toolCallId === id)?.data.result,
          id,
        )
        .toMatchObject({ status: "error" });
    expect.soft(io.filter((c) => c.kind === "list" && c.path === server.workspaceRoot)).toEqual([]);
    expect
      .soft(io.filter((c) => c.path === join(server.workspaceRoot, "neighbor.xlsx")))
      .toEqual([]);
    expect.soft(existsSync(join(server.workspaceRoot, "extra"))).toBe(false);
    expect.soft(readFileSync(join(server.workspaceRoot, "source.xlsx"))).toEqual(before);
    expect.soft(await api.getDocSnapshot(session.workspaceId, source.id)).toEqual(snapshot);
    expect.soft(await api.listDocRevisions(session.workspaceId, source.id)).toEqual(revisions);
    for (const id of ["finite-copy", "finite-edit", "finite-read", "finite-present"])
      expect
        .soft(
          rows.find((r) => r.type === "tool.result" && r.data.toolCallId === id)?.data.result,
          id,
        )
        .toMatchObject({ status: "ok" });
    const copied = rows.find((r) => r.type === "tool.result" && r.data.toolCallId === "finite-copy")
      ?.data.result as { data?: { results?: Array<{ copyBaseline?: unknown }> } };
    expect.soft(copied.data?.results?.[0]?.copyBaseline).toMatchObject({
      version: 1,
      destinationWasAbsent: true,
      sourceSha256: expect.any(String),
      destinationSha256: expect.any(String),
    });
    expect.soft(rows.some((r) => r.type === "access.unscoped")).toBe(false);
    expect
      .soft(
        rows.find((r) => r.type === "tool.result" && r.data.toolCallId === "finite-present")?.data
          .result,
      )
      .toMatchObject({ data: { finalizationStatus: "complete" } });
    const downloaded = Buffer.from(
      await (await api.downloadFile(session.workspaceId, "output.xlsx")).arrayBuffer(),
    );
    expect(downloaded).toEqual(readFileSync(join(server.workspaceRoot, "output.xlsx")));
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 45000);

test.each([
  "replacement",
  "destination-replacement",
  "failure",
  "destination-failure",
  "existing",
  "same-path",
  "missing-parent",
] as const)(
  "finite files: copy baseline is absent after identity replacement, failed copy or rejected overwrite (%s)",
  async (mode) => {
    const dataDir = mkdtempSync(join(tmpdir(), "finite-copy-proof-"));
    let first = true;
    const server = await startServer({
      dataDir,
      log: () => {},
      gateway: {
        async *step() {
          if (first) {
            first = false;
            yield {
              kind: "tool.call",
              toolCallId: "copy-proof",
              toolName: "files",
              args: {
                ops: [
                  ...(mode === "destination-failure"
                    ? [{ op: "copy", path: "source.txt", to: "earlier.txt" }]
                    : []),
                  {
                    op: "copy",
                    path: "source.txt",
                    to:
                      mode === "same-path"
                        ? "source.txt"
                        : mode === "missing-parent"
                          ? "missing/output.txt"
                          : "output.txt",
                  },
                ],
              },
              rawArgs: "{}",
            };
            yield { kind: "finish", reason: "tool-calls" };
          } else for (const event of text) yield event;
        },
      },
    });
    try {
      const api = createApiClient(server.url, server.token);
      await createTestProfile(api, {
        name: "copy",
        provider: "custom-openai-compatible",
        model: "copy",
        baseUrl: "https://mock.invalid/v1",
        apiKey: "test",
      });
      const { session } = await api.createSession({ permissionMode: "auto" });
      writeFileSync(join(server.workspaceRoot, "source.txt"), "original");
      if (mode === "existing")
        writeFileSync(join(server.workspaceRoot, "output.txt"), "preexisting");
      finiteIo.afterCopy = (from, to) => {
        if (to !== join(server.workspaceRoot, "output.txt")) return;
        finiteIo.afterCopy = undefined;
        if (mode === "failure") throw new Error("injected partial copy failure");
        const temp = join(server.workspaceRoot, "replacement.txt");
        writeFileSync(temp, "original");
        renameSync(temp, mode.startsWith("destination-") ? to : from);
        if (mode === "destination-failure") throw new Error("injected failure after replacement");
      };
      await api.sendMessage(session.id, "main", {
        clientMessageId: "copy-proof",
        text:
          mode === "same-path" || mode === "existing" || mode === "destination-failure"
            ? "复制 source.txt，不覆盖任何已有文件。"
            : `把 source.txt 另存为 ${mode === "missing-parent" ? "missing/output.txt" : "output.txt"}，只处理这两个文件，不访问或修改其他文件。`,
      });
      let result: unknown;
      await vi.waitFor(
        async () => {
          const rows = (await api.getSessionLog(session.id, { limit: 2000 })).items;
          result = rows.find((r) => r.type === "tool.result" && r.data.toolCallId === "copy-proof")
            ?.data.result;
          expect(result).toBeDefined();
        },
        { timeout: 15000 },
      );
      expect(result).toMatchObject({
        status:
          mode === "destination-failure"
            ? "uncertain"
            : ["failure", "existing", "same-path", "missing-parent"].includes(mode)
              ? "error"
              : "ok",
      });
      expect(JSON.stringify(result)).not.toContain('"copyBaseline"');
      expect(readFileSync(join(server.workspaceRoot, "source.txt"), "utf8")).toBe("original");
      expect(existsSync(join(server.workspaceRoot, "output.txt"))).toBe(
        !["failure", "same-path", "missing-parent"].includes(mode),
      );
      expect(existsSync(join(server.workspaceRoot, "missing"))).toBe(false);
      expect(existsSync(join(server.workspaceRoot, "earlier.txt"))).toBe(false);
      if (mode === "destination-failure") expect(JSON.stringify(result)).toContain("output.txt");
      if (mode === "existing" || mode.startsWith("destination-"))
        expect(readFileSync(join(server.workspaceRoot, "output.txt"), "utf8")).toBe(
          mode === "existing" ? "preexisting" : "original",
        );
    } finally {
      finiteIo.afterCopy = undefined;
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  30000,
);
