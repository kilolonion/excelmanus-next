// 文档同步状态（11 §3.6）：修订号跟踪 + 本端 doc.submit 的待确认集。纯函数，便于单测。

import type { ServerMessage } from "@excelmanus/protocol";

/** 传输层可回放的 Univer mutation（与 kernel 的 DocMutation 结构一致）。 */
export interface DocMutation {
  id: string;
  params: unknown;
}

/** 本端提交的 mutation 及其依据修订：被拒绝后用来展示「你的输入」，选择保留时按原依据重发。 */
export interface SubmittedMutation {
  mutation: DocMutation;
  baseRev: number;
}

export interface DocSyncState {
  rev: number;
  pending: Record<
    string,
    {
      status: "pending" | "acked" | "rejected";
      rev?: number;
      conflict?: unknown;
      /** 仅 pending / rejected 保留；ack 后丢弃。 */
      submitted?: SubmittedMutation;
    }
  >;
}

/** 最新一次被拒绝的提交：冲突条展示与二选一用。 */
export interface DocConflict {
  clientOpId: string;
  code: string;
  message?: string;
  conflicts: Array<{ rev?: number; source?: string; cells: string[] }>;
  /** 被拒绝的本端编辑；服务端没有保存它，只有前端记得。 */
  submitted?: SubmittedMutation;
}

export const initialDocSync = (rev = 0): DocSyncState => ({ rev, pending: {} });

function asConflict(value: unknown): Omit<DocConflict, "clientOpId"> {
  if (!value || typeof value !== "object") return { code: "UNKNOWN", conflicts: [] };
  const raw = value as { code?: unknown; message?: unknown; conflicts?: unknown };
  const details = Array.isArray(raw.conflicts)
    ? raw.conflicts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const detail = item as { rev?: unknown; source?: unknown; cells?: unknown };
        return [
          {
            ...(typeof detail.rev === "number" ? { rev: detail.rev } : {}),
            ...(typeof detail.source === "string" ? { source: detail.source } : {}),
            cells: Array.isArray(detail.cells)
              ? detail.cells.filter((cell): cell is string => typeof cell === "string")
              : [],
          },
        ];
      })
    : [];
  return {
    code: typeof raw.code === "string" ? raw.code : "UNKNOWN",
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    conflicts: details,
  };
}

export function latestDocConflict(state: DocSyncState): DocConflict | null {
  const latest = Object.entries(state.pending)
    .filter(([, item]) => item.status === "rejected")
    .at(-1);
  if (!latest) return null;
  const [clientOpId, item] = latest;
  return {
    clientOpId,
    ...asConflict(item.conflict),
    ...(item.submitted !== undefined ? { submitted: item.submitted } : {}),
  };
}

export function reduceDoc(state: DocSyncState, msg: ServerMessage): DocSyncState {
  switch (msg.type) {
    case "sub.ok":
      return msg.headCursor > state.rev ? { ...state, rev: msg.headCursor } : state;
    case "doc.op":
    case "doc.reload":
      // 分片的各 chunk 携带同一 rev；按 rev 幂等推进
      return msg.rev > state.rev ? { ...state, rev: msg.rev } : state;
    case "doc.ack": {
      const p = state.pending[msg.clientOpId];
      if (p?.status !== "pending") return state;
      return {
        rev: Math.max(state.rev, msg.rev),
        pending: { ...state.pending, [msg.clientOpId]: { status: "acked", rev: msg.rev } },
      };
    }
    case "doc.reject": {
      const p = state.pending[msg.clientOpId];
      if (p?.status !== "pending") return state;
      return {
        ...state,
        pending: {
          ...state.pending,
          [msg.clientOpId]: {
            status: "rejected",
            conflict: msg.conflict,
            ...(p.submitted !== undefined ? { submitted: p.submitted } : {}),
          },
        },
      };
    }
    default:
      return state;
  }
}

export function trackDocSubmit(
  state: DocSyncState,
  clientOpId: string,
  submitted: SubmittedMutation,
): DocSyncState {
  return {
    ...state,
    pending: { ...state.pending, [clientOpId]: { status: "pending", submitted } },
  };
}

/** 断线时没发出去的编辑：标为 offline 拒绝，用户可以在冲突条里重新发送。 */
export function markOffline(
  state: DocSyncState,
  clientOpId: string,
  submitted: SubmittedMutation,
): DocSyncState {
  return {
    ...state,
    pending: {
      ...state.pending,
      [clientOpId]: { status: "rejected", conflict: { code: "offline" }, submitted },
    },
  };
}

export function dropPending(state: DocSyncState, clientOpId: string): DocSyncState {
  if (!state.pending[clientOpId]) return state;
  const pending = { ...state.pending };
  delete pending[clientOpId];
  return { ...state, pending };
}
