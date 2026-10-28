import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  KERNEL_MIGRATIONS,
  kernelProjections,
  openDb,
  SessionLog,
  type ToolContext,
} from "@excelmanus/kernel";
import { createGateway } from "@excelmanus/models";
import type { ContextItem } from "@excelmanus/protocol";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOC_PATH_MOVES_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
  workbookRenderTool,
} from "@excelmanus/workbook";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { renderHeadless } from "../src/headless-render.ts";
import type { RunningServer } from "../src/index.ts";
import { createWorkbookCaptureDriver } from "../src/workbook-capture.ts";
import { renderCoverageWorkbook } from "./fixtures/render-coverage.ts";

const captureBrowser = process.env.EXCELMANUS_CAPTURE_BROWSER;

test(
  "synthetic workbook PNG survives receipt, projection rebuild and actual provider image_url bytes",
  () => runVisualContext("reconstructed"),
  30000,
);
test.skipIf(!captureBrowser)(
  "browser-view PNG survives read-only capture, projection rebuild and actual SDK image_url bytes",
  () => runVisualContext("browser-view"),
  60000,
);

async function runVisualContext(mode: "reconstructed" | "browser-view") {
  const dir = mkdtempSync(join(tmpdir(), "visual-context-"));
  const db = openDb(join(dir, "state.db"), [
    ...KERNEL_MIGRATIONS,
    DOCUMENTS_MIGRATION,
    DOC_OPS_MIGRATION,
    CHECKPOINT_MIGRATION,
    DOC_MOVES_MIGRATION,
    DOC_PATH_MOVES_MIGRATION,
    DOC_OPS_REVERTS_MIGRATION,
    BACKUPS_MIGRATION,
  ]);
  const service = new DocumentService(db);
  const capture = createWorkbookCaptureDriver();
  let browserServer: RunningServer | undefined;
  try {
    if (mode === "browser-view") {
      if (!captureBrowser || !isAbsolute(captureBrowser))
        throw new Error(
          "EXCELMANUS_CAPTURE_BROWSER must name a trusted absolute browser executable",
        );
      const { startServer } = await import("../src/index.ts");
      browserServer = await startServer({ dataDir: join(dir, "capture-server"), log: () => {} });
    }
    db.prepare(
      "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES ('w', 'synthetic', ?, 1, 0, '2026-10-21T00:00:00.000Z')",
    ).run(dir);
    const sourcePath = join(dir, "visual.xlsx");
    writeFileSync(sourcePath, await renderCoverageWorkbook());
    const sourceHash = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const originalSha = sourceHash();
    const opened = await service.open("w", dir, "visual.xlsx");
    const revisions = () =>
      db
        .prepare("SELECT rev, head_rev, checkpoint_rev FROM documents WHERE id=?")
        .get(opened.meta.id);
    const backupRows = () => db.prepare("SELECT id, sha256, kind FROM backups ORDER BY id").all();
    const originalRevisions = revisions(),
      originalBackups = backupRows();
    const context: ToolContext = {
      workspaceId: "w",
      workspaceRoot: dir,
      sessionId: "s",
      agentId: "main",
      role: "main",
      toolCallId: "render",
      signal: AbortSignal.timeout(30000),
      reads: createReadTable(),
      backups: new BackupService(db).bind({
        workspaceId: "w",
        workspaceRoot: dir,
        sessionId: "s",
        agentId: "main",
      }),
    };
    const renderer = workbookRenderTool(
      service,
      renderHeadless,
      mode === "browser-view"
        ? (packet, signal) => {
            if (!browserServer || !captureBrowser)
              throw new Error("Browser capture fixture is unavailable");
            return capture({
              packet,
              signal,
              baseUrl: browserServer.url,
              executablePath: captureBrowser,
            });
          }
        : undefined,
    );
    const result = await renderer.execute({ path: "visual.xlsx", range: "A1:L20", mode }, context);
    expect(["ok", ...(mode === "browser-view" ? ["partial"] : [])]).toContain(result.status);
    const bytes = Buffer.from(result.images![0]!.data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(result.data).toMatchObject({
      image: {
        sha256: hash,
        byteLength: bytes.length,
        pixelWidth: bytes.readUInt32BE(16),
        pixelHeight: bytes.readUInt32BE(20),
        mode,
      },
    });
    if (mode === "browser-view") {
      expect(result.data).toMatchObject({
        docId: opened.meta.id,
        rev: opened.meta.rev,
        requestedRange: "A1:L20",
        image: {
          docId: opened.meta.id,
          rev: opened.meta.rev,
          requestedRange: "A1:L20",
          viewport: { width: 1180, height: 757 },
          dpr: 1,
          zoom: 1,
          fullyVisible: result.status === "ok",
        },
      });
      expect(bytes.readUInt32BE(16)).toBe(1180);
      expect(bytes.readUInt32BE(20)).toBe(757);
    }
    const image = await loadImage(bytes),
      canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let magenta = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i]! > 240 && pixels[i + 1]! < 15 && pixels[i + 2]! > 240) magenta++;
    expect(magenta).toBeGreaterThan(1000);

    const log = new SessionLog(db, { projections: kernelProjections() });
    log.append("s", "main", [
      { type: "session.created", data: { workspaceId: "w", permissionMode: "standard" } },
      {
        type: "model.output",
        data: {
          stepId: "step",
          toolCalls: [{ id: "render", name: "workbook_render", args: { path: "visual.xlsx" } }],
        },
      },
      {
        type: "tool.result",
        data: { toolCallId: "render", toolName: "workbook_render", status: result.status, result },
      },
    ]);
    const read = () =>
      (
        db.prepare("SELECT item FROM agent_context WHERE session_id=? ORDER BY idx").all("s") as {
          item: string;
        }[]
      ).map((row) => JSON.parse(row.item) as ContextItem);
    const before = read();
    log.rebuild("s");
    expect(read()).toEqual(before);
    let body: Record<string, any> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ error: { message: "synthetic provider stops after receipt" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    for await (const _event of createGateway().step({
      model: {
        profileId: "synthetic",
        provider: "custom-openai-compatible",
        model: "synthetic",
        vision: true,
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "fixture",
        fetch: fetchImpl,
      },
      history: read(),
      signal: AbortSignal.timeout(5000),
    })) {
      /* drain */
    }
    const messages = body!.messages as { role: string; content: any }[];
    const part = messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .find((part) => part.type === "image_url");
    const sent = Buffer.from(part.image_url.url.split(",")[1], "base64");
    expect(createHash("sha256").update(sent).digest("hex")).toBe(hash);
    expect(JSON.stringify(messages.filter((message) => message.role === "tool"))).not.toContain(
      result.images![0]!.data,
    );
    if (mode === "reconstructed") {
      const cropped = await workbookRenderTool(service, renderHeadless).execute(
        { path: "visual.xlsx", range: "A1:AE81", mode: "reconstructed" },
        context,
      );
      expect(cropped.status).toBe("partial");
      expect(cropped.data).toMatchObject({
        requestedRange: "A1:AE81",
        image: { mode: "reconstructed" },
      });
    }
    const afterSha = sourceHash(),
      afterRevisions = revisions(),
      afterBackups = backupRows();
    expect(afterSha).toBe(originalSha);
    expect(afterRevisions).toEqual(originalRevisions);
    expect(afterBackups).toEqual(originalBackups);
    expect(service.headRev(opened.meta.id)).toBe(opened.meta.rev);
    const artifactDir = process.env.EXCELMANUS_CAPTURE_ARTIFACT_DIR;
    if (mode === "browser-view" && artifactDir) {
      if (!isAbsolute(artifactDir))
        throw new Error("EXCELMANUS_CAPTURE_ARTIFACT_DIR must be an absolute QA directory");
      const data = result.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("image" in data) ||
        !data.image ||
        typeof data.image !== "object"
      )
        throw new Error("browser-view result is missing image receipt metadata");
      const visual = data.image as Record<string, unknown>;
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(artifactDir, "capture.png"), bytes, { mode: 0o600, flag: "wx" });
      writeFileSync(
        join(artifactDir, "receipt.json"),
        JSON.stringify(
          {
            mode,
            docId: visual.docId,
            sheetId: visual.sheetId,
            rev: visual.rev,
            sha256: hash,
            byteLength: bytes.length,
            pixelWidth: image.width,
            pixelHeight: image.height,
            status: result.status,
            requestedRange: visual.requestedRange,
            visibleRange: visual.visibleRange,
            fullyVisible: visual.fullyVisible,
            viewport: visual.viewport,
            dpr: visual.dpr,
            zoom: visual.zoom,
            scroll: visual.scroll,
            warnings: visual.warnings,
            source: {
              sha256Before: originalSha,
              sha256After: afterSha,
              sha256Unchanged: afterSha === originalSha,
              revisionsBefore: originalRevisions,
              revisionsAfter: afterRevisions,
              revisionsUnchanged: true,
              backupCountBefore: originalBackups.length,
              backupCountAfter: afterBackups.length,
              backupsUnchanged: true,
            },
            sdkRequestImageSha256: createHash("sha256").update(sent).digest("hex"),
          },
          null,
          2,
        ),
        { mode: 0o600, flag: "wx" },
      );
    }
  } finally {
    try {
      await capture.close();
    } finally {
      try {
        await browserServer?.close();
      } finally {
        await service.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
