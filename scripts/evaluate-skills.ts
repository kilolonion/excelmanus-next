// 隔离的真实模型评测；只导出指标/断言和合成输出，不导出凭据、日志或提示词。
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { skillEvalCases } from "../fixtures/skill-evals/cases.ts";
import { parseRange } from "../packages/core/src/index.ts";
import {
  CreateModelProfileBody,
  createApiClient,
  type LogRecord,
  type ServerMessage,
} from "../packages/protocol/src/index.ts";
import { type RunningServer, startServer } from "../packages/server/src/index.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const safePath = (root: string, path: string) => {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("不合法的评测路径");
  return target;
};
function skillHash(dir: string): string {
  const files: string[] = [];
  const walk = (base: string) => {
    for (const e of readdirSync(base, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(base, e.name);
      if (e.isSymbolicLink()) throw new Error("评测资源不能为符号链接");
      if (e.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  return hash(
    files.map((path) => `${path.slice(dir.length)}:${hash(readFileSync(path))}`).join("\n"),
  );
}

const [profileFile, caseId, variant, outputDir] = process.argv.slice(2);
if (profileFile === "--validate") {
  const ids = new Set<string>();
  for (const c of skillEvalCases) {
    if (ids.has(c.id)) throw new Error("评测 ID 重复");
    ids.add(c.id);
    skillHash(join(repo, "assets/skills", c.skill));
    for (const path of Object.keys(c.files)) safePath(repo, path);
    if (c.image && !existsSync(join(repo, "fixtures/skill-evals", c.image)))
      throw new Error("缺少图片夹具");
    for (const output of c.outputs) {
      safePath(repo, output.path);
      for (const cell of output.cells) {
        const ref = parseRange(cell.ref);
        if (!ref.sheet || ref.startRow !== ref.endRow || ref.startCol !== ref.endCol)
          throw new Error("检查需指定单个单元格与工作表");
      }
    }
  }
  console.log(`评测资源检查通过：${ids.size} 个场景；真实模型效果未验证。`);
} else {
  const scenario = skillEvalCases.find((c) => c.id === caseId);
  if (
    !profileFile ||
    !scenario ||
    (variant !== "enabled" && variant !== "disabled") ||
    !outputDir
  ) {
    console.error(
      "usage: node scripts/evaluate-skills.ts <独立模型配置.json> <caseId> <enabled|disabled> <结果目录>\n       node scripts/evaluate-skills.ts --validate",
    );
    process.exitCode = 2;
  } else {
    // 只读取显式传入的评测配置；不读取生产数据目录与环境中的密钥。
    let profile: ReturnType<typeof CreateModelProfileBody.parse>;
    try {
      profile = CreateModelProfileBody.parse(
        JSON.parse(readFileSync(resolve(profileFile), "utf8")),
      );
    } catch {
      console.error("评测配置读取或校验失败；请检查独立配置文件，不要使用生产数据目录。");
      process.exit(2);
    }
    if (profile.accountId) throw new Error("评测不复用生产订阅账号；请使用独立 API 模型配置");
    const resultRoot = resolve(outputDir);
    mkdirSync(resultRoot, { recursive: true, mode: 0o700 });
    const artifactRoot = mkdtempSync(join(resultRoot, `${scenario.id}-${variant}-`));
    const dataDir = mkdtempSync(join(tmpdir(), "excelmanus-skill-eval-"));
    let server: RunningServer | undefined;
    let socket: WebSocket | undefined;
    const started = Date.now();
    const report = {
      createdAt: new Date().toISOString(),
      caseId: scenario.id,
      skill: scenario.skill,
      variant,
      provider: profile.provider,
      model: profile.model,
      skillHash: skillHash(join(repo, "assets/skills", scenario.skill)),
      inputHash: hash(
        JSON.stringify({
          files: scenario.files,
          image: scenario.image
            ? hash(readFileSync(join(repo, "fixtures/skill-evals", scenario.image)))
            : null,
        }),
      ),
      instructionHash: hash(scenario.prompt),
      status: "notRun",
      failureCode: null as string | null,
      elapsedMs: 0,
      toolCalls: 0,
      skillLoads: 0,
      inputTokens: 0,
      outputTokens: 0,
      wsRecords: 0,
      checks: [] as { output: string; ref: string; passed: boolean }[],
      sourcesUnchanged: false,
      outputsSaved: false,
      manualReview: "pending",
      manualItems: scenario.manual,
    };
    try {
      server = await startServer({ dataDir, log: () => {} });
      const api = createApiClient(server.url, server.token);
      const { profile: saved } = await api.createModelProfile(profile);
      for (const skill of (await api.listSkills()).items) {
        // enabled 只启用目标技能，避免其他技能影响归因；disabled 全部禁用。
        await api.setSkillEnabled(
          skill.name,
          variant === "enabled" && skill.name === scenario.skill,
        );
      }
      const original = new Map<string, string>();
      for (const [path, content] of Object.entries(scenario.files)) {
        const target = safePath(server.workspaceRoot, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        original.set(path, hash(content));
      }
      if (scenario.image) {
        // 必须连接产品的真实渲染端；不得用假图片或替身替代我们自己的渲染。
        console.log(`图像场景需要渲染端：请在 60 秒内打开 ${server.url}。`);
        const until = Date.now() + 60_000;
        while (!server.renderAvailable() && Date.now() < until)
          await new Promise((r) => setTimeout(r, 100));
        if (!server.renderAvailable()) {
          report.status = "notRun";
          report.failureCode = "RENDERER_REQUIRED";
          throw new Error("缺少渲染端");
        }
      }
      const { session } = await api.createSession({
        modelProfileId: saved.id,
        permissionMode: "auto",
      });
      const events: ServerMessage[] = [];
      socket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/api/v1/sync?ticket=${(await api.createTicket()).ticket}`,
      );
      socket.addEventListener("message", (event) =>
        events.push(JSON.parse(String(event.data)) as ServerMessage),
      );
      await new Promise<void>((resolveReady, reject) => {
        socket?.addEventListener("open", () => resolveReady(), { once: true });
        socket?.addEventListener("error", reject, { once: true });
      });
      socket.send(JSON.stringify({ type: "sub", topic: `session:${session.id}`, cursor: 0 }));
      const attachments = scenario.image
        ? [
            await api.uploadAttachment({
              name: scenario.image,
              data: new Blob([readFileSync(join(repo, "fixtures/skill-evals", scenario.image))], {
                type: "image/png",
              }),
            }),
          ]
        : undefined;
      await api.sendMessage(session.id, "main", {
        clientMessageId: "eval",
        text: scenario.prompt,
        ...(attachments ? { attachments } : {}),
      });
      const records = new Map<number, LogRecord>();
      const timeout = Date.now() + 180_000;
      report.status = "running";
      while (Date.now() < timeout) {
        for (const e of events.splice(0))
          if (e.type === "rec") {
            records.set(e.record.seq, e.record);
            report.wsRecords += 1;
          }
        for (const record of (await api.getSessionLog(session.id, { limit: 1000 })).items)
          records.set(record.seq, record);
        const all = [...records.values()];
        const failed = all.find((r) => r.agentId === "main" && r.type === "turn.failed");
        if (failed) {
          report.status = "failed";
          report.failureCode = "MODEL_OR_RUNTIME_FAILED";
          break;
        }
        if (all.some((r) => r.agentId === "main" && r.type === "turn.completed")) {
          report.status = "completed";
          break;
        }
        if (
          all.some(
            (r) =>
              r.type === "question.asked" &&
              !all.some(
                (a) => a.type === "question.answered" && a.data.questionId === r.data.questionId,
              ),
          )
        ) {
          report.status = "needsInput";
          report.failureCode = "QUESTION_REQUIRED";
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (report.status === "running") {
        report.status = "timedOut";
        report.failureCode = "TIMEOUT";
      }
      if (report.status !== "completed") await api.stopAll(session.id);
      const all = [...records.values()];
      report.toolCalls = all.filter((r) => r.type === "tool.intent").length;
      report.skillLoads = all.filter(
        (r) => r.type === "tool.intent" && r.data.toolName === "skill",
      ).length;
      for (const record of all.filter((r) => r.type === "usage.updated")) {
        const usage = record.data.usage as
          | { inputTokens?: number; outputTokens?: number }
          | undefined;
        report.inputTokens += usage?.inputTokens ?? 0;
        report.outputTokens += usage?.outputTokens ?? 0;
      }
      if (report.status === "completed") {
        for (const output of scenario.outputs) {
          try {
            const { document } = await api.openDoc(session.workspaceId, { path: output.path });
            const { snapshot } = await api.getDocSnapshot(session.workspaceId, document.id);
            const sheets = Object.values(
              (snapshot.sheets ?? {}) as Record<
                string,
                {
                  name: string;
                  cellData: Record<
                    string,
                    Record<string, { v?: unknown; f?: unknown; s?: unknown }>
                  >;
                }
              >,
            );
            for (const check of output.cells) {
              const ref = parseRange(check.ref);
              const sheet = sheets.find((s) => s.name === ref.sheet);
              const cell = sheet?.cellData?.[ref.startRow - 1]?.[ref.startCol - 1];
              const passed =
                (check.value === undefined ||
                  cell?.v === check.value ||
                  (typeof check.value === "number" &&
                    typeof cell?.v === "number" &&
                    Math.abs(cell.v - check.value) < 1e-8)) &&
                (!check.formula || typeof cell?.f === "string") &&
                (!check.styled || (cell?.s !== undefined && cell.s !== null));
              report.checks.push({ output: output.path, ref: check.ref, passed });
            }
          } catch {
            report.checks.push({ output: output.path, ref: "outputAvailable", passed: false });
          }
        }
        const workspace = server.workspaceRoot;
        report.sourcesUnchanged = [...original].every(
          ([path, digest]) =>
            existsSync(safePath(workspace, path)) &&
            hash(readFileSync(safePath(workspace, path))) === digest,
        );
        report.status =
          report.sourcesUnchanged && report.checks.every((c) => c.passed)
            ? "automaticChecksPassed"
            : "outputMismatch";
      }
      const workspace = server.workspaceRoot;
      socket.close();
      socket = undefined;
      await server.close();
      server = undefined;
      for (const output of scenario.outputs) {
        const source = safePath(workspace, output.path);
        if (existsSync(source)) {
          const target = safePath(artifactRoot, output.path);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(source, target);
        }
      }
      report.outputsSaved = scenario.outputs.every((o) =>
        existsSync(safePath(artifactRoot, o.path)),
      );
      if (report.status === "automaticChecksPassed" && !report.outputsSaved) {
        report.status = "failed";
        report.failureCode = "OUTPUT_NOT_SAVED";
      }
    } catch {
      if (!report.failureCode) {
        report.status = "failed";
        report.failureCode = "EVALUATION_ERROR";
      }
    } finally {
      socket?.close();
      await server?.close();
      rmSync(dataDir, { recursive: true, force: true });
      report.elapsedMs = Date.now() - started;
      writeFileSync(join(artifactRoot, "result.json"), JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      console.log(
        `${scenario.id} ${variant}: ${report.status}；人工复核待完成；结果 ${artifactRoot}`,
      );
      if (report.status !== "automaticChecksPassed") process.exitCode = 1;
    }
  }
}
