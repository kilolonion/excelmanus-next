// Offline validation is the default. Real provider calls require explicit profile files.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v1EvalCases } from "../fixtures/v1-evals/cases.ts";
import { CreateModelProfileBody } from "../packages/protocol/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--validate") {
  if (v1EvalCases.length !== 40 || new Set(v1EvalCases.map((c) => c.id)).size !== 40)
    throw new Error("V1 评测集必须恰好包含40个唯一任务");
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/evaluate-skills.ts"), "--v1", "--validate"],
    { cwd: root, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} else if (args[0] === "--run" && args.length === 5) {
  const [, output, ...profiles] = args;
  if (!output || !isAbsolute(output) || profiles.some((path) => !isAbsolute(path)))
    throw new Error("结果目录与三个独立评测配置必须使用绝对路径");
  // Validate all profiles before spending on any model. Never print profile contents.
  try {
    const parsed = profiles.map((path) =>
      CreateModelProfileBody.parse(JSON.parse(readFileSync(path, "utf8"))),
    );
    if (parsed.some((p) => p.accountId)) throw new Error("subscription");
    if (new Set(parsed.map((p) => `${p.provider}/${p.model}`)).size !== 3)
      throw new Error("distinct");
  } catch {
    throw new Error("需要三个不同模型的独立 API 评测配置；不复用订阅账号。配置内容不会写入报告。");
  }
  const out = resolve(output);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const runs: { modelIndex: number; caseId: string; exitCode: number | null }[] = [];
  for (const [index, profile] of profiles.entries()) {
    for (const scenario of v1EvalCases) {
      const result = spawnSync(
        process.execPath,
        [
          join(root, "scripts/evaluate-skills.ts"),
          "--v1",
          profile,
          scenario.id,
          "enabled",
          join(out, `model-${index + 1}`),
        ],
        { cwd: root, stdio: "inherit" },
      );
      runs.push({ modelIndex: index + 1, caseId: scenario.id, exitCode: result.status });
      writeFileSync(
        join(out, "matrix.json"),
        JSON.stringify(
          { createdAt: new Date().toISOString(), expectedRuns: 120, runs, manualReview: "pending" },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      if (result.signal || result.error) {
        process.exitCode = 1;
        break;
      }
    }
    if (process.exitCode) break;
  }
  if (runs.length !== 120 || runs.some((run) => run.exitCode !== 0)) process.exitCode = 1;
} else {
  console.error(
    "usage: node scripts/evaluate-v1.ts --validate\n       node scripts/evaluate-v1.ts --run <结果绝对路径> <旗舰配置.json> <国产配置.json> <低成本配置.json>\n--run 会产生真实模型费用；图像任务需要真实浏览器渲染端。不会自动执行。",
  );
  process.exitCode = 2;
}
