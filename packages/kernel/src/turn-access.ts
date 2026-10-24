import type { DatabaseSync } from "node:sqlite";
import { type DirectoryScopeDecision, TurnAccessBinding } from "@excelmanus/protocol";
import {
  deriveUserAccessScope,
  isAccessContinuation,
  narrowDirectoryScope,
  newUserDirectoryScope,
} from "./access-scope.ts";

function dataRows(db: DatabaseSync, sessionId: string, agentId: string, types: string[]) {
  return (
    db
      .prepare(
        `SELECT type, data FROM session_log WHERE session_id=? AND agent_id=? AND type IN (${types.map(() => "?").join(",")}) ORDER BY seq DESC`,
      )
      .all(sessionId, agentId, ...types) as { type: string; data: string }[]
  ).map((row) => ({ ...JSON.parse(row.data), recordType: row.type }) as Record<string, unknown>);
}
function turnBindingRows(db: DatabaseSync, sessionId: string, agentId: string) {
  // Fixed event literals let SQLite use the authorization-only partial covering index.
  return (
    db
      .prepare(
        "SELECT type, data FROM session_log WHERE session_id=? AND agent_id=? AND type IN ('turn.started', 'turn.access.updated') ORDER BY seq DESC",
      )
      .all(sessionId, agentId) as { type: string; data: string }[]
  ).map((row) => ({ ...JSON.parse(row.data), recordType: row.type }) as Record<string, unknown>);
}
function bindingOf(data: Record<string, unknown> | undefined): TurnAccessBinding | undefined {
  const parsed = TurnAccessBinding.safeParse(data?.accessBinding);
  return parsed.success ? parsed.data : undefined;
}
export function turnAccessBinding(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId: string,
): TurnAccessBinding | undefined {
  const records = turnBindingRows(db, sessionId, agentId);
  const ownRecord = records.find((row) => row.turnId === turnId);
  const own = bindingOf(ownRecord);
  if (!own)
    return ownRecord?.accessBinding === undefined && ownRecord?.recordType !== "turn.access.updated"
      ? undefined
      : {
          originAgentId: agentId,
          originTurnId: turnId,
          sourceDispatchIds: [],
          ruleVersion: 2,
          decision: { kind: "unresolved", reason: "持久访问范围记录无法解析，请另发明确的新任务" },
          accessDeliveryRequired: true,
        };
  const origins =
    own.originAgentId === agentId
      ? records
      : turnBindingRows(db, sessionId, own.originAgentId);
  const originTurns = new Set([own.originTurnId]);
  for (const row of origins) {
    if (row.recordType !== "turn.started" || typeof row.turnId !== "string") continue;
    const start = bindingOf(row);
    if (start?.originAgentId === own.originAgentId && start.originTurnId === own.originTurnId)
      originTurns.add(row.turnId);
  }
  const latestRecord = origins.find(
    (row) => typeof row.turnId === "string" && originTurns.has(row.turnId),
  );
  if (!latestRecord) return own;
  const latest = bindingOf(latestRecord);
  if (!latest)
    return {
      ...own,
      decision: { kind: "unresolved", reason: "持久访问范围记录无法解析，请另发明确的新任务" },
      accessDeliveryRequired: true,
    };
  return {
    ...own,
    decision: narrowDirectoryScope(own.decision, latest.decision),
    accessDeliveryRequired: own.accessDeliveryRequired || latest.accessDeliveryRequired,
  };
}
function latestBinding(db: DatabaseSync, sessionId: string, agentId: string) {
  const last = dataRows(db, sessionId, agentId, ["turn.started"])[0];
  return typeof last?.turnId === "string"
    ? turnAccessBinding(db, sessionId, agentId, last.turnId)
    : undefined;
}
function dispatchData(db: DatabaseSync, sessionId: string, agentId: string, id: string) {
  const row = db
    .prepare(
      "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId, agentId, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as { text?: string; accessInputOrigin?: string }) : undefined;
}
export function createTurnAccessBinding(
  db: DatabaseSync,
  input: {
    sessionId: string;
    agentId: string;
    turnId: string;
    dispatchIds: string[];
    resume?: boolean;
  },
): TurnAccessBinding {
  const { sessionId, agentId, turnId, dispatchIds } = input;
  const prior = latestBinding(db, sessionId, agentId);
  const spawn = dataRows(db, sessionId, agentId, ["agent.spawned"])[0];
  const origin = spawn?.accessOrigin as { agentId?: string; turnId?: string } | undefined;
  const inherited =
    origin?.agentId && origin.turnId
      ? turnAccessBinding(db, sessionId, origin.agentId, origin.turnId)
      : undefined;
  const first = dispatchIds[0] ? dispatchData(db, sessionId, agentId, dispatchIds[0]) : undefined;
  const continuation =
    first?.accessInputOrigin === "user" && isAccessContinuation(first.text ?? "");
  let binding: TurnAccessBinding;
  if (inherited || ((input.resume || !dispatchIds.length || continuation) && prior)) {
    binding = {
      ...(inherited ?? prior!),
      sourceDispatchIds: [...(inherited ?? prior!).sourceDispatchIds],
    };
  } else {
    const decision =
      origin && !inherited
        ? { kind: "unresolved" as const, reason: "无法恢复父任务的可信目录范围" }
        : first?.accessInputOrigin === "user"
          ? newUserDirectoryScope(first.text ?? "", prior?.decision)
          : { kind: "unbounded" as const };
    binding = {
      originAgentId: agentId,
      originTurnId: turnId,
      sourceDispatchIds: [],
      ruleVersion: 2,
      decision,
      accessDeliveryRequired: decision.kind !== "unbounded",
    };
  }
  for (let i = 0; i < dispatchIds.length; i++) {
    const id = dispatchIds[i]!;
    const item = dispatchData(db, sessionId, agentId, id);
    if (item?.accessInputOrigin !== "user") continue;
    if (!binding.sourceDispatchIds.includes(id)) binding.sourceDispatchIds.push(id);
    if (i > 0 || inherited)
      binding.decision = narrowDirectoryScope(
        binding.decision,
        deriveUserAccessScope(item.text ?? ""),
      );
  }
  binding.accessDeliveryRequired ||= binding.decision.kind !== "unbounded";
  return binding;
}
export function steeredTurnAccessBinding(
  db: DatabaseSync,
  input: { sessionId: string; agentId: string; turnId: string; dispatchIds: string[] },
): TurnAccessBinding {
  let binding = turnAccessBinding(db, input.sessionId, input.agentId, input.turnId) ?? {
    originAgentId: input.agentId,
    originTurnId: input.turnId,
    sourceDispatchIds: [],
    ruleVersion: 2 as const,
    decision: { kind: "unbounded" as const },
    accessDeliveryRequired: false,
  };
  binding = { ...binding, sourceDispatchIds: [...binding.sourceDispatchIds] };
  for (const id of input.dispatchIds) {
    const item = dispatchData(db, input.sessionId, input.agentId, id);
    if (item?.accessInputOrigin !== "user") continue;
    binding.decision = narrowDirectoryScope(
      binding.decision,
      deriveUserAccessScope(item.text ?? ""),
    );
    if (!binding.sourceDispatchIds.includes(id)) binding.sourceDispatchIds.push(id);
  }
  binding.accessDeliveryRequired ||= binding.decision.kind !== "unbounded";
  return binding;
}
export function effectiveIngressAccess(
  db: DatabaseSync,
  input: { sessionId: string; agentId: string; text: string; mode: string; running?: boolean },
): DirectoryScopeDecision {
  const next = deriveUserAccessScope(input.text);
  const prior = latestBinding(db, input.sessionId, input.agentId);
  let effective =
    prior && (isAccessContinuation(input.text) || (input.running && input.mode === "steer"))
      ? narrowDirectoryScope(prior.decision, next)
      : newUserDirectoryScope(input.text, prior?.decision);
  // A steer accepted before its batch starts must not materialize context outside an earlier limit.
  if (input.mode === "steer") {
    const pending = db
      .prepare(
        "SELECT l.data,d.mode FROM dispatches d JOIN session_log l ON l.session_id=d.session_id AND l.agent_id=d.agent_id AND l.type='user.message' AND json_extract(l.data,'$.dispatchId')=d.id WHERE d.session_id=? AND d.agent_id=? AND d.status IN ('accepted','queued') ORDER BY l.seq",
      )
      .all(input.sessionId, input.agentId) as { data: string; mode: string }[];
    const relevant = pending.filter(
      (row, index) => row.mode === "steer" || (!input.running && index === 0),
    );
    if (relevant.length) {
      let batch: DirectoryScopeDecision =
        input.running && prior ? prior.decision : { kind: "unbounded" };
      for (let i = 0; i < relevant.length; i++) {
        const data = JSON.parse(relevant[i]!.data) as { text?: string; accessInputOrigin?: string };
        if (data.accessInputOrigin !== "user") continue;
        const decision =
          !input.running && i === 0 && prior && isAccessContinuation(data.text ?? "")
            ? prior.decision
            : deriveUserAccessScope(data.text ?? "");
        batch = narrowDirectoryScope(batch, decision);
      }
      effective = narrowDirectoryScope(batch, next);
    }
  }
  return effective;
}
export function accessDeliveryRequired(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId: string,
): boolean {
  return turnAccessBinding(db, sessionId, agentId, turnId)?.accessDeliveryRequired === true;
}
export const ACCESS_DELIVERY_GUIDANCE =
  "本轮有明确文件或目录限制。只能访问许可资源；有限文件任务的源文件只读、另存目标可读写，不得枚举父目录或查找其他文件。范围不明确时停止文件操作。先用 deliver 的 inspect 获取当前授权下可见的读取证据与访问事实，再用 finalize 受控交付；使用 inspect 返回的当前交付句柄，访问清单由宿主生成。不得自由声称未访问文件、手写证据指针或用 note 绕过。无法完成时只能采用宿主 allowedOutcomes 允许的 partial 或 blocked；改写措辞不能绕过 unverified、待修复或访问限制。";
