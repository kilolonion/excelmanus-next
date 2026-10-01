// ToolDefinition 与 CapabilityModule（06 §2.1 全字段、03 §4.3）。

import type { DatabaseSync } from "node:sqlite";
import { MAX_C, MAX_R, parseRange, type RangeRef } from "@excelmanus/core";
import type {
  AgentRole,
  ApprovalEffect,
  FileIntentMeta,
  ReplayKind,
  ToolResult,
} from "@excelmanus/protocol";
import type { z } from "zod";
import type { BoundBackupService } from "./backup.ts";
import type { Migration } from "./db.ts";
import type { LeaseService } from "./leases.ts";
import type { Projection } from "./session-log.ts";

export type ToolEffect =
  | "read"
  | "write"
  | "destructive"
  | "external"
  | "interactive"
  | "agent"
  | "state";

/**
 * 读集中的一个区域：坐标处于读取时修订 `rev` 的坐标系。
 * `sheetName` 仅出现在从会话上下文重建的条目上（sheetId 为 "*"，由文档能力按名解析）。
 */
export interface ReadRange extends RangeRef {
  rev: number;
  sheetName?: string;
  /** 超出条目上限后折叠成的整表粗粒度条目：参与冲突判定，但不作为"已重读"证据。 */
  coarse?: boolean;
}

export interface ReadRecord {
  docId: string;
  ranges: Array<RangeRef & { sheetName?: string }>;
  rev: number;
}

/**
 * 每代理一份的读集表（07 §10、03 §6.1）：每个区域记录各自的读取修订。
 * 内存表；actor 首次使用时由 seed 从会话上下文的读取类结果重建（10 §3.4，近似）。
 * 不同修订的条目坐标系不同，重读不覆盖旧条目：冲突判定时，较新读取覆盖到的单元格视为已知（见文档服务）。
 * 同修订的条目被新区域包含时替换；超出上限时最旧条目折叠为整表粗粒度条目（保守，不丢保护）。
 */
export interface ReadTable {
  record(docId: string, ranges: RangeRef[], rev: number): void;
  get(docId: string): { ranges: ReadRange[]; minRev: number; maxRev: number } | undefined;
}

/** 每文档最多保留的精确读集条目。 */
const MAX_READ_ENTRIES = 1000;

const sameSheet = (a: ReadRange, b: RangeRef & { sheetName?: string }) =>
  a.sheetId === b.sheetId && a.sheetName === b.sheetName;
const contains = (a: RangeRef, b: RangeRef) =>
  a.r0 <= b.r0 && a.c0 <= b.c0 && a.r1 >= b.r1 && a.c1 >= b.c1;

export function createReadTable(seed?: () => Iterable<ReadRecord>): ReadTable {
  const map = new Map<string, ReadRange[]>();
  let seeded = seed === undefined;
  const add = (docId: string, ranges: Array<RangeRef & { sheetName?: string }>, rev: number) => {
    let list = map.get(docId) ?? [];
    for (const r of ranges) {
      if (list.some((e) => !e.coarse && e.rev === rev && sameSheet(e, r) && contains(e, r)))
        continue;
      list = list.filter((e) => e.coarse || e.rev !== rev || !sameSheet(e, r) || !contains(r, e));
      list.push({
        sheetId: r.sheetId,
        r0: r.r0,
        c0: r.c0,
        r1: r.r1,
        c1: r.c1,
        rev,
        ...(r.sheetName !== undefined ? { sheetName: r.sheetName } : {}),
      });
    }
    const exact = list.filter((e) => !e.coarse);
    if (exact.length > MAX_READ_ENTRIES) {
      // 折叠最旧条目：每张表一条整表条目，修订取被折叠条目的最小值（只会多报冲突，不会漏报）
      const fold = new Set(exact.slice(0, exact.length - MAX_READ_ENTRIES));
      const coarse = list.filter((e) => e.coarse);
      for (const e of fold) {
        const c = coarse.find((x) => sameSheet(x, e));
        if (c) c.rev = Math.min(c.rev, e.rev);
        else
          coarse.push({
            sheetId: e.sheetId,
            r0: 0,
            c0: 0,
            r1: MAX_R,
            c1: MAX_C,
            rev: e.rev,
            coarse: true,
            ...(e.sheetName !== undefined ? { sheetName: e.sheetName } : {}),
          });
      }
      list = [...coarse, ...exact.filter((e) => !fold.has(e))];
    }
    map.set(docId, list);
  };
  const ensure = () => {
    if (seeded) return;
    seeded = true;
    try {
      for (const r of seed?.() ?? []) add(r.docId, r.ranges, r.rev);
    } catch {
      // 重建只是近似：上下文损坏时以空读集继续
    }
  };
  return {
    record(docId, ranges, rev) {
      ensure();
      add(docId, ranges, rev);
    },
    get(docId) {
      ensure();
      const list = map.get(docId);
      if (!list || list.length === 0) return undefined;
      let minRev = Number.POSITIVE_INFINITY;
      let maxRev = 0;
      for (const e of list) {
        minRev = Math.min(minRev, e.rev);
        maxRev = Math.max(maxRev, e.rev);
      }
      return { ranges: list.map((e) => ({ ...e })), minRev, maxRev };
    },
  };
}

/**
 * 从代理上下文（含已被压缩替换的条目）中的读取类工具结果重建读集（10 §3.4）：
 * 结果带 docId 与该文档修订号，区域取 range 模式的 `range`、search 的命中 `ref`、
 * 写入结果的 `changes.ranges`（A1，表名待文档能力解析）。
 */
export function persistedReads(db: DatabaseSync, sessionId: string, agentId: string): ReadRecord[] {
  const rows = db
    .prepare("SELECT item FROM agent_context WHERE session_id = ? AND agent_id = ? ORDER BY idx")
    .all(sessionId, agentId) as { item: string }[];
  const out: ReadRecord[] = [];
  for (const row of rows) {
    let item: { kind?: unknown; output?: unknown };
    try {
      item = JSON.parse(row.item) as typeof item;
    } catch {
      continue;
    }
    if (item.kind !== "toolResult") continue;
    const output = item.output as
      | { status?: unknown; docRevs?: Record<string, unknown>; data?: unknown }
      | undefined;
    if (output?.status !== "ok" && output?.status !== "partial") continue;
    const data = output.data as
      | {
          docId?: unknown;
          docRevs?: Record<string, unknown>;
          mode?: unknown;
          range?: unknown;
          matches?: unknown;
          changes?: { ranges?: unknown };
          dryRun?: unknown;
        }
      | undefined;
    if (typeof data?.docId !== "string" || data.dryRun === true) continue;
    const rev = output.docRevs?.[data.docId] ?? data.docRevs?.[data.docId];
    if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) continue;
    const refs: unknown[] = [];
    if (data.mode === "range") refs.push(data.range);
    if (data.mode === "search" && Array.isArray(data.matches))
      for (const m of data.matches) refs.push((m as { ref?: unknown } | null)?.ref);
    if (Array.isArray(data.changes?.ranges)) refs.push(...data.changes.ranges);
    const ranges: ReadRecord["ranges"] = [];
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      try {
        const p = parseRange(ref);
        ranges.push({
          sheetId: "*",
          r0: p.startRow - 1,
          c0: p.startCol - 1,
          r1: p.endRow - 1,
          c1: p.endCol - 1,
          ...(p.sheet !== undefined ? { sheetName: p.sheet } : {}),
        });
      } catch {
        // 单个引用解析失败不影响其他区域
      }
    }
    if (ranges.length > 0) out.push({ docId: data.docId, ranges, rev });
  }
  return out;
}

export interface ToolContext {
  /** 会话所属工作区 id（workspaces 表）。 */
  workspaceId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  /** 当前调用所属的轮次与步骤，供可恢复交互工具持久化 continuation。 */
  turnId?: string;
  stepId?: string;
  /** 调用方代理角色（06 §8）：写类能力据此做只读限制（reader）。 */
  role: AgentRole;
  /** 本代理的文档读集（写工具提交后也应并入写集，代理读过自己写的）。 */
  reads: ReadTable;
  backups: BoundBackupService;
  /** 写入执行前的文件租约检查（M3）；未装配时保持 M2 行为。 */
  leases?: LeaseService;
  /**
   * 只由运行时审批门注入：destructive 调用已放行（批准 / auto / 会话自动批准）；
   * approval:"publish" 工具中表示"重启后的已批准恢复"。
   */
  destructiveApproved?: boolean;
  /** 会话内代理团队协调器；仅 agent_* 工具使用。 */
  agents?: AgentCoordinator;
  /** 未经 input schema 裁剪的原始参数（审批恢复等场景需要读取审批时注入的字段）。 */
  rawArgs?: unknown;
  /** 非文件资源（`skill://<名称>/<路径>`，12 §1.2）；由装配层注入，模块之间不直接依赖。 */
  resolveResource?(uri: string): { text: string } | { error: ToolResult };
  /**
   * 发布时审批（08 §6，approval:"publish" 的工具由执行器注入）：工具在真正产生
   * 副作用前自行调用；denied 时工具自行收口为 APPROVAL_DENIED，中止期间被取消由
   * 工具按 ctx.signal 判定为 CANCELLED。
   */
  requestApproval?(req: {
    targets: string[];
    args: unknown;
    effect: ApprovalEffect;
  }): Promise<{ decision: "approved" | "denied"; reason?: string }>;
}

/** 运行时注入的团队协调能力，保持工具层不依赖 server。 */
export interface AgentCoordinator {
  spawn(args: {
    sessionId: string;
    parentAgentId: string;
    name: string;
    role: AgentRole;
    task: string;
    files?: string[];
    modelProfileId?: string;
    budget?: Record<string, unknown>;
  }): { agentId: string; name: string; status: string } | { error: ToolResult };
  send(args: {
    sessionId: string;
    fromAgentId: string;
    to: string[];
    message: string;
    urgent?: boolean;
  }): { messageIds: string[] } | { error: ToolResult };
  status(
    sessionId: string,
    requesterAgentId: string,
    agentId?: string,
    include?: "summary" | "final_reply" | "transcript_tail",
  ): unknown;
  control(args: {
    sessionId: string;
    requesterAgentId: string;
    agentId: string;
    action: "pause" | "resume" | "close" | "release_lease";
  }): { ok: true } | { error: ToolResult };
  wait(args: {
    sessionId: string;
    requesterAgentId: string;
    for: "any_message" | "messages_from" | "all_idle";
    agents?: string[];
    timeoutSeconds: number;
    signal: AbortSignal;
  }): Promise<ToolResult>;
}

export interface ToolDefinition<A = unknown> {
  /** 小写蛇形。 */
  name: string;
  /** 中文显示名（工具卡片）。 */
  title: string;
  /** 发给模型的说明（06 §2.2）。 */
  description: string;
  input: z.ZodType<A>;
  /** 外部来源（MCP）直接给出的 JSON Schema；存在时发给模型的是它而不是 input 的转换结果。 */
  inputJsonSchema?: Record<string, unknown>;
  output: z.ZodType;
  /** 需要视觉能力：模型不支持视觉时不出现在工具列表（09 §6）。 */
  requiresVision?: boolean;
  /** 工具级自动批准名单（12 §4.2 MCP 设置）；为真时跳过审批，仍写 intent/result。 */
  autoApproved?(): boolean;
  // 回调参数标 never：使 ToolDefinition<具体参数> 可赋给异构集合 ToolDefinition<unknown>；
  // 作者如需读 args 可自行标注具体类型（never 可赋给一切参数类型）。
  effect: ToolEffect | ((args: never) => ToolEffect);
  /** 审批时机：默认执行前按 effect 判定；"publish" 表示发布前由工具经 ctx.requestApproval 自请（08 §6）。 */
  approval?: "publish";
  /** 本次调用会读/写哪些路径，用于审批展示与目标高亮。 */
  targets(args: A): string[];
  /**
   * 工作簿活动（11 §3.4 `workbook_activity` 瞬时增量）：执行期间告诉界面代理正在读/写哪些区域。
   * ranges 为空表示整个文档。只用于显示，不入日志。
   */
  activity?(args: A): WorkbookActivity | null;
  /** 中断后能否安全重放。 */
  replay: ReplayKind | ((args: never) => ReplayKind);
  timeoutMs: number;
  roles: AgentRole[];
  execute(args: A, ctx: ToolContext): Promise<ToolResult> | ToolResult;
  /**
   * 04 §8.2 恢复钩子：进程中断后 open_intents 里的未决调用——有副作用的
   * 工具用它判断该调用是否已在别处落库（返回其结果）；返回 undefined = not_executed。
   */
  intentMeta?(args: A, ctx: ToolContext): FileIntentMeta;
  recover?(info: {
    sessionId: string;
    agentId: string;
    toolCallId: string;
    args: unknown;
    intentMeta?: FileIntentMeta;
  }): ToolResult | undefined;
}

export interface WorkbookActivity {
  kind: "read" | "write";
  docId?: string;
  path?: string;
  ranges: string[];
}

export interface CapabilityModule {
  id: string;
  tools?: ToolDefinition[];
  migrations?: Migration[];
  projections?: Projection[];
}

/** 模块数据库访问别名（避免重复 import node:sqlite 类型）。 */
export type { DatabaseSync };
