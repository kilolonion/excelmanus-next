import type { DatabaseSync } from "node:sqlite";
import { AccessFact, type DirectoryScopeDecision } from "@excelmanus/protocol";
import { turnAccessBinding } from "./turn-access.ts";
export interface AccessFactsReport {
  required: boolean;
  decision: DirectoryScopeDecision;
  originAgentId: string;
  originTurnId: string;
  facts: (AccessFact & { agentId: string })[];
  enumeratedDirectories: string[];
  metadataPaths: string[];
  byteReadPaths: string[];
  documentPaths: string[];
  accessedPaths: string[];
  rejected: (AccessFact & { agentId: string })[];
  unknown: (AccessFact & { agentId: string })[];
  failed: (AccessFact & { agentId: string })[];
  priorUnscopedActivity: boolean;
  pendingProducers: { agentId: string; reason: "active" | "unverified" }[];
  coverage: "complete" | "incomplete";
}
/** Verify the runtime turn and spawn lineage, not an origin tag in an unrelated event. */
function admittedOrigin(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId: unknown,
  originAgentId: string,
  originTurnId: string,
): boolean {
  if (typeof turnId !== "string") return false;
  const binding = turnAccessBinding(db, sessionId, agentId, turnId);
  if (binding?.originAgentId !== originAgentId || binding.originTurnId !== originTurnId)
    return false;
  return trustedOriginLineage(db, sessionId, agentId, originAgentId, originTurnId);
}
function trustedOriginLineage(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  originAgentId: string,
  originTurnId: string,
): boolean {
  const seen = new Set<string>();
  while (agentId !== originAgentId) {
    if (seen.has(agentId)) return false;
    seen.add(agentId);
    const row = db
      .prepare(
        "SELECT l.data,a.parent_id FROM session_log l JOIN agents a ON a.session_id=l.session_id AND a.id=l.agent_id WHERE l.session_id=? AND l.agent_id=? AND l.type='agent.spawned' ORDER BY l.seq DESC LIMIT 1",
      )
      .get(sessionId, agentId) as { data: string; parent_id: string | null } | undefined;
    if (!row) return false;
    const from = (JSON.parse(row.data) as { accessOrigin?: { agentId?: string; turnId?: string } })
      .accessOrigin;
    if (!from?.agentId || !from.turnId || row.parent_id !== from.agentId) return false;
    const parent = turnAccessBinding(db, sessionId, from.agentId, from.turnId);
    if (parent?.originAgentId !== originAgentId || parent.originTurnId !== originTurnId)
      return false;
    agentId = from.agentId;
  }
  return true;
}
function activeDescendantProducers(
  db: DatabaseSync,
  input: { sessionId: string; agentId: string },
  originAgentId: string,
  originTurnId: string,
): AccessFactsReport["pendingProducers"] {
  const agents = db
    .prepare("SELECT id,parent_id,status FROM agents WHERE session_id=?")
    .all(input.sessionId) as { id: string; parent_id: string | null; status: string }[];
  const parents = new Map(agents.map((a) => [a.id, a.parent_id]));
  const descends = (id: string) => {
    const seen = new Set<string>();
    let parent = parents.get(id);
    while (parent) {
      if (parent === input.agentId) return true;
      if (seen.has(parent)) return false;
      seen.add(parent);
      parent = parents.get(parent);
    }
    return false;
  };
  const out: AccessFactsReport["pendingProducers"] = [];
  for (const agent of agents) {
    if (
      agent.id === input.agentId ||
      !descends(agent.id) ||
      !trustedOriginLineage(db, input.sessionId, agent.id, originAgentId, originTurnId)
    )
      continue;
    const turns = db
      .prepare(
        "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq",
      )
      .all(input.sessionId, agent.id) as { data: string }[];
    let unverified = false,
      unfinished = false;
    for (const row of turns) {
      const turn = JSON.parse(row.data) as { turnId?: unknown };
      if (
        typeof turn.turnId !== "string" ||
        !admittedOrigin(db, input.sessionId, agent.id, turn.turnId, originAgentId, originTurnId)
      ) {
        unverified = true;
        continue;
      }
      if (
        !db
          .prepare(
            "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND type IN ('turn.completed','turn.failed','turn.interrupted') AND json_extract(data,'$.turnId')=? LIMIT 1",
          )
          .get(input.sessionId, agent.id, turn.turnId)
      )
        unfinished = true;
    }
    const queued = !!db
      .prepare(
        "SELECT 1 FROM dispatches WHERE session_id=? AND agent_id=? AND status IN ('accepted','queued') LIMIT 1",
      )
      .get(input.sessionId, agent.id);
    if (unverified) out.push({ agentId: agent.id, reason: "unverified" });
    else if (
      unfinished ||
      queued ||
      ["running", "queued", "waiting", "blocked"].includes(agent.status)
    )
      out.push({ agentId: agent.id, reason: "active" });
  }
  return out;
}
export function turnAccessFacts(
  db: DatabaseSync,
  input: { sessionId: string; agentId: string; turnId: string },
): AccessFactsReport {
  const binding = turnAccessBinding(db, input.sessionId, input.agentId, input.turnId);
  const originAgentId = binding?.originAgentId ?? input.agentId,
    originTurnId = binding?.originTurnId ?? input.turnId;
  const rows = db
    .prepare(
      "SELECT agent_id,data,type FROM session_log WHERE session_id=? AND type IN ('access.fact','access.batch','access.unscoped') AND json_extract(data,'$.originAgentId')=? AND json_extract(data,'$.originTurnId')=? ORDER BY seq",
    )
    .all(input.sessionId, originAgentId, originTurnId) as {
    agent_id: string;
    data: string;
    type: string;
  }[];
  const events = new Map<string, AccessFact & { agentId: string }>();
  const batches = new Map<string, string>();
  let priorUnscopedActivity = false;
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (
      !admittedOrigin(db, input.sessionId, row.agent_id, data.turnId, originAgentId, originTurnId)
    )
      continue;
    if (row.type === "access.unscoped") {
      priorUnscopedActivity = true;
      continue;
    }
    if (row.type === "access.batch") {
      batches.set(data.batchId, data.status);
      continue;
    }
    const parsed = AccessFact.safeParse(data);
    if (parsed.success)
      events.set(parsed.data.operationId, { ...parsed.data, agentId: row.agent_id });
  }
  const facts = [...events.values()];
  const succeeded = facts.filter((f) => f.outcome === "succeeded");
  const paths = (k: string[]) =>
    [...new Set(succeeded.filter((f) => k.includes(f.kind)).map((f) => f.path))].sort();
  const unknown = facts.filter((f) => f.outcome === "started");
  const failed = facts.filter((f) => f.outcome === "failed");
  // Unrestricted HTTP context was materialized before the task existed; the ingress owns this bit.
  priorUnscopedActivity ||= (binding?.sourceDispatchIds ?? []).some(
    (id) =>
      !!db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? AND json_extract(data,'$.accessInputOrigin')='user' AND json_extract(data,'$.unscopedContextRead')=1 LIMIT 1",
        )
        .get(input.sessionId, id),
  );
  const pendingProducers = binding?.accessDeliveryRequired
    ? activeDescendantProducers(db, input, originAgentId, originTurnId)
    : [];
  return {
    required: binding?.accessDeliveryRequired ?? false,
    decision: binding?.decision ?? { kind: "unbounded" },
    originAgentId,
    originTurnId,
    facts,
    enumeratedDirectories: paths(["directory-enumeration"]),
    metadataPaths: paths(["file-metadata"]),
    byteReadPaths: paths(["file-bytes"]),
    documentPaths: paths(["document-snapshot", "package-cache-parse"]),
    accessedPaths: [...new Set(succeeded.map((f) => f.path))].sort(),
    rejected: facts.filter((f) => f.outcome === "rejected-before-access"),
    unknown,
    failed,
    priorUnscopedActivity,
    pendingProducers,
    coverage:
      pendingProducers.length ||
      (binding?.accessDeliveryRequired && priorUnscopedActivity) ||
      unknown.length ||
      [...batches.values()].some((s) => s !== "closed")
        ? "incomplete"
        : "complete",
  };
}
export function renderAccessFacts(report: AccessFactsReport): string {
  const display = (paths: string[]) =>
    paths.map((p) => JSON.stringify(p).replace(/[\\`*_{}[\]<>|]/g, "\\$&")).join("、");
  const lines = ["本轮实际访问（宿主记录）："];
  if (report.decision.kind === "files") {
    lines.push(`- 明确允许读取的文件：${display(report.decision.readPaths)}`);
    lines.push(
      `- 允许写入的文件：${display(report.decision.writePaths)}；其余许可文件只读，不授权目录枚举。`,
    );
  }
  const writes = [
    ...new Set(
      report.facts
        .filter((f) => f.kind === "file-write" && f.outcome === "succeeded")
        .map((f) => f.path),
    ),
  ];
  if (writes.length) lines.push(`- 实际写入文件：${display(writes)}`);
  if (report.enumeratedDirectories.length)
    lines.push(`- 枚举目录：${display(report.enumeratedDirectories)}`);
  const lookups = [
    ...new Set(
      report.facts
        .filter((f) => f.outcome === "succeeded" && f.purpose === "path-resolution")
        .map((f) => f.path),
    ),
  ];
  const metadata = [
    ...new Set(
      report.facts
        .filter(
          (f) =>
            f.outcome === "succeeded" &&
            f.kind === "file-metadata" &&
            f.purpose !== "path-resolution",
        )
        .map((f) => f.path),
    ),
  ];
  if (lookups.length) lines.push(`- 路径及必要祖先检查（非目录枚举）：${display(lookups)}`);
  if (metadata.length) lines.push(`- 读取文件元数据：${display(metadata)}`);
  if (report.byteReadPaths.length)
    lines.push(
      `- 读取文件字节（含导入/哈希，非全部单元格重新解码）：${display(report.byteReadPaths)}`,
    );
  if (report.documentPaths.length)
    lines.push(`- 读取工作簿快照或保存包：${display(report.documentPaths)}`);
  if (report.rejected.length)
    lines.push(
      `- 执行前被阻止的路径尝试：${display([...new Set(report.rejected.map((f) => f.path))])}（不计为已读取）`,
    );
  if (!report.accessedPaths.length) lines.push("- 没有记录到成功的工作区资源读取。");
  if (report.failed.length)
    lines.push(
      `- 已开始但最终失败的访问：${display([...new Set(report.failed.map((f) => f.path))])}（可能已有部分读取，不计作未访问）`,
    );
  if (report.priorUnscopedActivity && report.required)
    lines.push(
      "- 本任务在访问限制建立前已发生宿主文件操作，之前的逐项访问记录不完整；不能完成全轮访问核验。",
    );
  if (report.pendingProducers.length)
    lines.push(
      `- 关联子代理尚未结束访问，或其旧轮次缺少可信审计归属：${display(report.pendingProducers.map((p) => p.agentId))}；等待核验前不能完整交付。`,
    );
  if (report.coverage !== "complete")
    lines.push("- 部分访问过程未能确认完整结果，不能据此宣称没有发生访问。");
  const fetched = report.facts.filter(
    (f) => f.kind === "external-target-fetch" && f.outcome === "succeeded",
  );
  if (fetched.length)
    lines.push(`- 外链目标获取：${display([...new Set(fetched.map((f) => f.path))])}`);
  else
    lines.push(
      "- 未记录到成功的外链目标获取；这不否认上列独立文件读取，也不将缓存值视为实时更新。",
    );
  return lines.join("\n");
}
