// 查看子代理对话时（02 §5）：对话区顶部说明正在看谁，一键回到主代理。

import { ArrowLeft } from "lucide-react";
import { MAIN_AGENT } from "@/lib/session/reducer";
import { setViewAgent, useChatStore } from "@/stores/chat-store";
import { AGENT_ROLE_LABEL, AGENT_STATUS } from "./SubagentBlock";
import { useAgentTeam } from "./use-background-tasks";

export function AgentViewBanner() {
  const viewAgentId = useChatStore((s) => s.viewAgentId);
  const { members } = useAgentTeam();
  if (viewAgentId === MAIN_AGENT) return null;
  const member = members.find((m) => m.agent.id === viewAgentId);
  const agent = member?.agent;
  const status = agent ? AGENT_STATUS[agent.status] : undefined;
  return (
    <div className="em-agent-view-banner">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: member?.color ?? "var(--em-muted)" }}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        正在查看 <strong>{agent?.name ?? viewAgentId}</strong> 的对话
      </span>
      {agent?.role && (
        <span className="em-agent-view-tag">{AGENT_ROLE_LABEL[agent.role] ?? agent.role}</span>
      )}
      {status && <span className={`text-[11px] ${status.cls}`}>{status.text}</span>}
      <button type="button" className="em-agent-view-back" onClick={() => setViewAgent(MAIN_AGENT)}>
        <ArrowLeft className="h-3 w-3" aria-hidden="true" />
        返回主代理
      </button>
    </div>
  );
}
