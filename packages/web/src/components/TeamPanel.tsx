import { useMemo } from "react";
import type { RosterEntry } from "../reduce.ts";
import {
  controlAgent,
  resumeInterruptedAgents,
  selectAgent,
  stopAgent,
  stopAllAgents,
  useApp,
} from "../store.ts";
import { agentRoleLabel, agentStatusLabel, S, toolTitle } from "../strings.ts";
import { ProviderLogo } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/cn.ts";
import { Alert, Badge, SectionLabel, StatusDot, statusTone } from "./ui/display.tsx";
import { Disclosure } from "./ui/overlay.tsx";
import { Tip } from "./ui/tooltip.tsx";

interface TeamRow {
  agent: RosterEntry;
  depth: number;
}

/** 按 parentId 组装的 DFS 树（02 §5）：main 在顶，子代理按派生关系缩进。 */
function buildTree(roster: Record<string, RosterEntry>): TeamRow[] {
  const children = new Map<string | null, RosterEntry[]>();
  for (const a of Object.values(roster)) {
    const key = a.parentId ?? null;
    const list = children.get(key) ?? [];
    list.push(a);
    children.set(key, list);
  }
  const rows: TeamRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const a of children.get(parentId) ?? []) {
      rows.push({ agent: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  // 防御：环或缺失父节点的条目附在末尾
  const seen = new Set(rows.map((r) => r.agent.id));
  for (const a of Object.values(roster)) {
    if (!seen.has(a.id)) rows.push({ agent: a, depth: 0 });
  }
  return rows;
}

function RowActions({ agent }: { agent: RosterEntry }) {
  const status = agent.status;
  const isMain = agent.parentId === null;
  const canPause = status === "running" || status === "waiting" || status === "blocked";
  const canResume = status === "paused" || status === "interrupted";
  const canClose = status !== "closed" && status !== "failed";
  const act = (action: "pause" | "resume" | "close") =>
    void controlAgent(agent.id, action).catch(() => {});
  return (
    <span className="flex shrink-0 items-center opacity-0 group-focus-within/agent:opacity-100 group-hover/agent:opacity-100">
      {isMain ? (
        status === "running" && (
          <Button
            size="xs"
            variant="destructive-ghost"
            onClick={() => void stopAgent().catch(() => {})}
          >
            {S.stop}
          </Button>
        )
      ) : (
        <>
          {canPause && (
            <Button size="xs" variant="ghost" onClick={() => act("pause")}>
              {S.agentPause}
            </Button>
          )}
          {canResume && (
            <Button size="xs" variant="ghost" onClick={() => act("resume")}>
              {S.agentResume}
            </Button>
          )}
          {canClose && (
            <Button size="xs" variant="destructive-ghost" onClick={() => act("close")}>
              {S.agentClose}
            </Button>
          )}
        </>
      )}
    </span>
  );
}

export function TeamPanel({ onSelect }: { onSelect?: () => void } = {}) {
  const roster = useApp((s) => s.session.roster);
  const profiles = useApp((s) => s.profiles);
  const messages = useApp((s) => s.session.messages);
  const agentId = useApp((s) => s.agentId);
  const rows = useMemo(() => buildTree(roster), [roster]);
  const interrupted = rows.filter((r) => r.agent.status === "interrupted");
  const running = rows.filter((r) => r.agent.status === "running").length;
  const internal = messages.filter((m) => m.role === "internal");
  const rosterName = (id: string) => roster[id]?.name ?? id;

  // 02 §2.1：会话有子代理时才出现「代理团队」
  if (!rows.some((r) => r.agent.parentId !== null)) return null;
  return (
    <div className="team-panel flex flex-col gap-1">
      <div className="flex h-7 items-center gap-1.5 px-2">
        <SectionLabel>{S.teamView}</SectionLabel>
        {running > 0 && <Badge tone="read">{S.runningCount(running)}</Badge>}
        <span className="flex-1" />
        <Button
          size="xs"
          variant="destructive-ghost"
          onClick={() => void stopAllAgents().catch(() => {})}
        >
          {S.stopAll}
        </Button>
      </div>
      {interrupted.length > 0 && (
        <Alert layout="inline" tone="warn" className="mx-1">
          <span>{S.interruptedBanner(interrupted.length)}</span>
          <span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void resumeInterruptedAgents().catch(() => {})}
            >
              {S.resumeAll}
            </Button>
          </span>
        </Alert>
      )}
      {rows.map(({ agent, depth }) => {
        const active = agent.id === agentId;
        const profile = profiles.find((p) => p.id === agent.modelProfileId);
        return (
          <div
            className={cn(
              "group/agent flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-1 transition-colors",
              active ? "bg-card shadow-xs ring-1 ring-border" : "hover:bg-accent",
            )}
            key={agent.id}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <StatusDot
              tone={statusTone(agent.status)}
              pulse={agent.status === "running"}
              label={agentStatusLabel(agent.status)}
            />
            {profile && <ProviderLogo provider={profile.provider} size="sm" />}
            <div className="flex min-w-0 flex-1 flex-col">
              <Tip content={agent.id} side="right">
                <button
                  type="button"
                  className="min-w-0 truncate rounded-sm text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    selectAgent(agent.id);
                    onSelect?.();
                  }}
                >
                  {agent.name ?? agent.id}
                </button>
              </Tip>
              <span className="truncate text-2xs text-muted-foreground">
                {[
                  agentStatusLabel(agent.status),
                  agentRoleLabel(agent.role),
                  agent.lastTool ? toolTitle(agent.lastTool) : "",
                  typeof agent.tokens === "number" ? S.tokenCount(agent.tokens) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <RowActions agent={agent} />
          </div>
        );
      })}
      {internal.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 px-2">
          <SectionLabel>{S.teamMessages}</SectionLabel>
          {internal.map((m) => (
            <Disclosure
              key={m.id}
              summary={
                <>
                  {m.internal
                    ? S.internalLine(
                        rosterName(m.internal.from),
                        rosterName(m.internal.to),
                        m.internal.kind,
                      )
                    : m.id}
                  <span className="text-muted-foreground"> {m.text.slice(0, 80)}</span>
                </>
              }
            >
              <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {m.text}
              </pre>
            </Disclosure>
          ))}
        </div>
      )}
    </div>
  );
}
