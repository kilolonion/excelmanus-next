// 代理团队（02 §5）：会话名册里的主代理与子代理，按派生顺序；给每个代理一个稳定的颜色。

import { useMemo } from "react";
import { MAIN_AGENT, subAgents } from "@/lib/session/reducer";
import type { AgentEntry } from "@/lib/session/types";
import { useChatStore } from "@/stores/chat-store";

/** 主代理用主色；子代理依次取其余颜色（应用 token + 固定补充色）。 */
const AGENT_COLORS = [
  "var(--em-primary)",
  "var(--em-cyan)",
  "var(--em-gold)",
  "#8b5cf6",
  "#e8590c",
  "#d6336c",
] as const;

export interface TeamMember {
  agent: AgentEntry;
  /** CSS 颜色（取自应用 token）。 */
  color: string;
  isMain: boolean;
}

const ACTIVE = new Set(["running", "waiting", "blocked", "queued"]);

export function isAgentActive(status: string): boolean {
  return ACTIVE.has(status);
}

export function useAgentTeam() {
  const session = useChatStore((s) => s.session);
  return useMemo(() => {
    const main = session.roster[MAIN_AGENT];
    const subs = subAgents(session);
    const members: TeamMember[] = [
      ...(main ? [{ agent: main, color: AGENT_COLORS[0], isMain: true }] : []),
      ...subs.map((agent, i) => ({
        agent,
        color: AGENT_COLORS[1 + (i % (AGENT_COLORS.length - 1))],
        isMain: false,
      })),
    ];
    return {
      members,
      subCount: subs.length,
      activeCount: subs.filter((a) => isAgentActive(a.status)).length,
      blockedCount: subs.filter((a) => a.status === "blocked").length,
    };
  }, [session]);
}
