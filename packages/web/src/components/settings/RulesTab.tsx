import type { Rule } from "@excelmanus/protocol";
import { Loader2, Plus, ScrollText, ToggleLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { onAppEvent } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

function RuleRow({
  rule,
  onToggle,
  onDelete,
  updating,
}: {
  rule: Rule;
  onToggle: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  updating: string | null;
}) {
  return (
    <div className="em-settings-section flex items-center gap-3 rounded-xl border border-border px-3 py-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-06)] text-[var(--em-primary)]">
        <ScrollText className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] leading-relaxed break-words">{rule.content}</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {rule.enabled ? "已启用" : "已停用"}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <Switch
          checked={rule.enabled}
          onCheckedChange={() => onToggle(rule)}
          disabled={updating === rule.id}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive"
          onClick={() => onDelete(rule)}
          disabled={updating === rule.id}
          aria-label="删除规则"
        >
          {updating === rule.id ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

export function RulesTab({ sessionId: sessionIdProp }: { sessionId?: string } = {}) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionId = sessionIdProp ?? activeSessionId ?? undefined;
  const [rules, setRules] = useState<Rule[]>([]);
  const [totals, setTotals] = useState<{ total: number; max: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [globalInput, setGlobalInput] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [adding, setAdding] = useState<"global" | "session" | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await api().listRules(sessionId);
      setRules(res.items);
      setTotals({ total: res.totalChars, max: res.maxTotalChars });
    } catch (error) {
      toast({ title: "读取规则失败", description: errorMessage(error), tone: "error" });
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    void fetchRules().finally(() => setLoading(false));
  }, [fetchRules]);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "rules.changed") void fetchRules();
      }),
    [fetchRules],
  );

  const globalRules = rules.filter((r) => r.scope === "global");
  const sessionRules = rules.filter((r) => r.scope === "session" && r.sessionId === sessionId);

  const handleAdd = async (scope: "global" | "session") => {
    const content = (scope === "global" ? globalInput : sessionInput).trim();
    if (!content || (scope === "session" && !sessionId)) return;
    setAdding(scope);
    try {
      const { rule } = await api().createRule(
        scope === "session" ? { scope, sessionId, content } : { scope, content },
      );
      setRules((prev) => [...prev.filter((r) => r.id !== rule.id), rule]);
      if (scope === "global") setGlobalInput("");
      else setSessionInput("");
      void fetchRules();
    } catch (error) {
      toast({ title: "添加失败", description: errorMessage(error), tone: "error" });
    } finally {
      setAdding(null);
    }
  };

  const handleToggle = async (rule: Rule) => {
    const snapshot = rules;
    setUpdating(rule.id);
    setRules(snapshot.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    try {
      const { rule: updated } = await api().updateRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
      void fetchRules();
    } catch (error) {
      setRules(snapshot);
      toast({ title: "更新失败", description: errorMessage(error), tone: "error" });
    } finally {
      setUpdating(null);
    }
  };

  const handleDelete = async (rule: Rule) => {
    const ok = await confirmAction({
      title: "删除规则",
      description: "确定删除该规则？",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const snapshot = rules;
    setUpdating(rule.id);
    setRules(snapshot.filter((r) => r.id !== rule.id));
    try {
      await api().deleteRule(rule.id);
      void fetchRules();
    } catch (error) {
      setRules(snapshot);
      toast({ title: "删除失败", description: errorMessage(error), tone: "error" });
    } finally {
      setUpdating(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const overLimit = totals ? totals.total > totals.max : false;

  return (
    <div className="space-y-3">
      <section className="em-plugin-panel space-y-3 rounded-xl border p-3">
        <div className="flex items-start gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
            <Plus className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-medium">添加规则</h4>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              用一句明确的话描述 Agent 必须遵守的行为。
            </p>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={globalInput}
            onChange={(e) => setGlobalInput(e.target.value)}
            className="h-9 text-xs flex-1"
            placeholder="例如：修改前先保留原始数据列"
            data-coach-id="coach-settings-rule-input"
            onKeyDown={(e) => e.key === "Enter" && void handleAdd("global")}
          />
          <Button
            size="sm"
            className="h-9 text-xs gap-1 text-white shrink-0"
            style={{ backgroundColor: "var(--em-primary)" }}
            disabled={adding === "global" || !globalInput.trim()}
            onClick={() => void handleAdd("global")}
            data-coach-id="coach-settings-rule-add-btn"
          >
            {adding === "global" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            添加规则
          </Button>
        </div>
        {totals && (
          <p className={`text-[10px] ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
            已启用规则共 {totals.total} / {totals.max} 字{overLimit ? "，超出部分不会注入模型" : ""}
          </p>
        )}
      </section>

      <section
        className="em-plugin-panel space-y-3 rounded-xl border p-3"
        data-coach-id="coach-settings-rules-list"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-[var(--em-primary)]" />
            <div>
              <h4 className="text-sm font-medium">全局规则</h4>
              <p className="text-[10px] text-muted-foreground">每个新任务都会加载</p>
            </div>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
            {globalRules.length} 条
          </span>
        </div>

        <div className="space-y-2">
          {globalRules.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center">
              <ScrollText className="mx-auto h-7 w-7 text-muted-foreground/30" />
              <p className="mt-2 text-xs font-medium text-muted-foreground">还没有全局规则</p>
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                在上方添加后，可随时单独启停
              </p>
            </div>
          ) : (
            globalRules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                onToggle={handleToggle}
                onDelete={handleDelete}
                updating={updating}
              />
            ))
          )}
        </div>
      </section>

      {sessionId && (
        <section className="em-plugin-panel space-y-3 rounded-xl border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
              <div>
                <h4 className="text-sm font-medium">会话规则</h4>
                <p className="text-[10px] text-muted-foreground">仅覆盖当前任务</p>
              </div>
            </div>
            <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
              {sessionRules.length} 条
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              className="h-9 text-xs flex-1"
              placeholder="输入仅用于当前任务的规则..."
              onKeyDown={(e) => e.key === "Enter" && void handleAdd("session")}
            />
            <Button
              size="sm"
              className="h-9 text-xs gap-1 text-white shrink-0"
              style={{ backgroundColor: "var(--em-primary)" }}
              disabled={adding === "session" || !sessionInput.trim()}
              onClick={() => void handleAdd("session")}
            >
              {adding === "session" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              添加规则
            </Button>
          </div>

          <div className="space-y-2">
            {sessionRules.length === 0 ? (
              <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">
                当前任务没有专属规则
              </p>
            ) : (
              sessionRules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  updating={updating}
                />
              ))
            )}
          </div>
        </section>
      )}
    </div>
  );
}
