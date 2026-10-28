import type { Memory, MemoryCategory } from "@excelmanus/protocol";
import { Brain, Check, ChevronRight, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { createDateLabels } from "@/lib/date-labels";
import { onAppEvent, refreshSettings, updateSettings, useAppStore } from "@/stores/app-store";
import { GlassSelect } from "./model/form-widgets";

const CATEGORIES: MemoryCategory[] = ["preference", "domain", "file", "lesson"];

const CATEGORY_LABELS: Record<string, string> = {
  all: "全部",
  preference: "用户偏好",
  domain: "业务知识",
  file: "文件结构",
  lesson: "经验教训",
};

const CATEGORY_COLORS: Record<string, string> = {
  preference: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  domain: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  file: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  lesson: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

const CONTENT_PREVIEW_LEN = 100;

export function MemoryInjectionToggle() {
  const settings = useAppStore((s) => s.settings);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt explicitly retries the settings request
  useEffect(() => {
    if (settings) return;
    let active = true;
    setLoadError("");
    void refreshSettings().catch((error) => {
      if (active) setLoadError(errorMessage(error, "无法读取记忆设置"));
    });
    return () => {
      active = false;
    };
  }, [settings, loadAttempt]);
  return (
    <section className="em-plugin-panel flex items-center justify-between gap-3 rounded-xl border p-3">
      <div className="min-w-0">
        <label htmlFor="memory-injection" className="text-sm font-medium">
          在新任务中使用记忆
        </label>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          开启后，Agent 会参考记忆库中的相关条目，并在任务中记录新的跨任务信息。
        </p>
      </div>
      {!settings ? (
        <div
          className="flex shrink-0 flex-col items-end gap-2 text-xs"
          role={loadError ? "alert" : "status"}
        >
          {loadError ? (
            <>
              <span className="text-destructive">{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>
                重新读取
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取记忆设置…
            </span>
          )}
        </div>
      ) : (
        <Switch
          id="memory-injection"
          checked={settings.memoryInjection}
          disabled={saving}
          onCheckedChange={async (checked) => {
            setSaving(true);
            try {
              await updateSettings({ memoryInjection: checked });
            } catch (error) {
              toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </section>
  );
}

export function MemoryTab() {
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w.name])),
    [workspaces],
  );
  const formatTimestamp = createDateLabels({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const [entries, setEntries] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>("preference");
  const [adding, setAdding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const readRequest = useRef(0);
  const waitingForList = loading && entries.length === 0;

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: entries.length };
    for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
    return counts;
  }, [entries]);

  const fetchEntries = useCallback(async (q: string) => {
    const request = ++readRequest.current;
    setLoadError(null);
    setLoading(true);
    try {
      const { items } = await api().listMemories(q.trim() || undefined);
      if (request !== readRequest.current) return;
      setEntries(items);
    } catch (error) {
      if (request !== readRequest.current) return;
      setEntries([]);
      setLoadError(errorMessage(error, "读取记忆失败"));
    } finally {
      if (request === readRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchEntries(query), query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      readRequest.current += 1;
    };
  }, [fetchEntries, query]);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "memories.changed") void fetchEntries(query);
      }),
    [fetchEntries, query],
  );

  const workspaceName = (id: string | null) => (id ? (workspaceNames.get(id) ?? null) : null);

  const handleAdd = async () => {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      const { memory } = await api().createMemory({ content, category: draftCategory });
      setEntries((prev) => [memory, ...prev]);
      setDraft("");
    } catch (error) {
      toast({ title: "添加失败", description: errorMessage(error), tone: "error" });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    const content = editing.content.trim();
    if (!content) return;
    setBusyId(editing.id);
    try {
      const { memory } = await api().updateMemory(editing.id, { content });
      setEntries((prev) => prev.map((e) => (e.id === memory.id ? memory : e)));
      setEditing(null);
    } catch (error) {
      toast({ title: "保存失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmAction({
      title: "删除记忆",
      description: "确定删除这条记忆？",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const snapshot = entries;
    setBusyId(id);
    setEntries(snapshot.filter((ent) => ent.id !== id));
    if (expandedId === id) setExpandedId(null);
    try {
      await api().deleteMemory(id);
    } catch (error) {
      setEntries(snapshot);
      toast({ title: "删除失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const filteredEntries = useMemo(
    () => (categoryFilter ? entries.filter((e) => e.category === categoryFilter) : entries),
    [entries, categoryFilter],
  );
  const groupedByCategory = useMemo(
    () =>
      filteredEntries.reduce<Record<string, Memory[]>>((acc, e) => {
        if (!acc[e.category]) acc[e.category] = [];
        acc[e.category].push(e);
        return acc;
      }, {}),
    [filteredEntries],
  );
  const orderedCategories = categoryFilter
    ? [categoryFilter]
    : CATEGORIES.filter((c) => groupedByCategory[c]?.length);

  return (
    <div className="space-y-3">
      <MemoryInjectionToggle />

      <section className="em-plugin-panel space-y-3 rounded-xl border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
              <Brain className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">记忆库</h4>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {loadError
                  ? "记忆列表读取失败"
                  : waitingForList
                    ? "正在读取记忆列表…"
                    : `Agent 已保留 ${entries.length} 条跨任务信息`}
              </p>
            </div>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
            {waitingForList ? "读取中" : loadError ? "读取失败" : `${filteredEntries.length} 条`}
          </span>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
            placeholder="搜索记忆…"
          />
        </div>

        <div
          className="flex items-center gap-1 overflow-x-auto scrollbar-none"
          data-coach-id="coach-settings-memory-filters"
        >
          {([null, ...CATEGORIES] as const).map((cat) => {
            const key = cat ?? "all";
            const isActive = categoryFilter === cat;
            const count = cat ? categoryCounts[cat] || 0 : categoryCounts.all;
            if (cat && count === 0) return null;
            return (
              <button
                key={key}
                type="button"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap border ${
                  isActive
                    ? "text-white border-transparent"
                    : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
                style={isActive ? { backgroundColor: "var(--em-primary)" } : undefined}
                onClick={() => setCategoryFilter(cat)}
              >
                {CATEGORY_LABELS[key] ?? key}
                <span
                  className={`text-[10px] ${isActive ? "text-white/70" : "text-muted-foreground/60"}`}
                >
                  {waitingForList || loadError ? "…" : count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleAdd()}
            className="h-9 flex-1 text-xs"
            placeholder="手动添加一条记忆，例如：金额列统一保留两位小数"
            maxLength={2000}
          />
          <div className="sm:w-32">
            <GlassSelect
              ariaLabel="记忆分类"
              value={draftCategory}
              options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
              onChange={(value) => setDraftCategory(value as MemoryCategory)}
            />
          </div>
          <Button
            size="sm"
            className="h-9 shrink-0 gap-1 text-xs text-white"
            style={{ backgroundColor: "var(--em-primary)" }}
            disabled={adding || !draft.trim()}
            onClick={() => void handleAdd()}
          >
            {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            添加
          </Button>
        </div>
      </section>

      <section
        className="em-plugin-panel space-y-3 rounded-xl border p-3"
        data-coach-id="coach-settings-memory-list"
      >
        <div className="px-0.5">
          <h4 className="text-sm font-medium">记忆条目</h4>
          <p className="text-[10px] text-muted-foreground">
            点击条目查看完整内容，或修改、清理不再准确的信息
          </p>
        </div>
        {waitingForList ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : loadError ? (
          <div role="alert" className="flex items-center gap-2 py-4 text-xs text-destructive">
            <span className="min-w-0 flex-1">{loadError}</span>
            <Button size="sm" variant="outline" onClick={() => void fetchEntries(query)}>
              重新读取
            </Button>
          </div>
        ) : orderedCategories.length === 0 ? (
          <div className="rounded-xl border border-dashed text-center py-10">
            <Brain className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              {query.trim()
                ? "没有匹配的记忆"
                : categoryFilter
                  ? `暂无「${CATEGORY_LABELS[categoryFilter]}」类记忆`
                  : "Agent 尚未记录任何记忆"}
            </p>
          </div>
        ) : null}
        {orderedCategories.map((cat) => (
          <div key={cat} className="space-y-1.5">
            {!categoryFilter && (
              <div className="flex items-center gap-1.5 px-0.5 pt-1">
                <Badge
                  className={`text-[10px] px-1.5 py-0 border-0 ${CATEGORY_COLORS[cat] ?? "bg-muted text-muted-foreground"}`}
                  variant="secondary"
                >
                  {CATEGORY_LABELS[cat] ?? cat}
                </Badge>
                <span className="text-[10px] text-muted-foreground/60">
                  {groupedByCategory[cat]?.length ?? 0}
                </span>
              </div>
            )}
            {(groupedByCategory[cat] ?? []).map((entry) => {
              const isExpanded = expandedId === entry.id;
              const isEditing = editing?.id === entry.id;
              const isLong = entry.content.length > CONTENT_PREVIEW_LEN;
              const preview = isLong
                ? `${entry.content.slice(0, CONTENT_PREVIEW_LEN)}…`
                : entry.content;
              const wsName = workspaceName(entry.workspaceId);
              return (
                <div key={entry.id} className="rounded-lg border border-border overflow-hidden">
                  <div
                    className="flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() =>
                      !isEditing && setExpandedId((prev) => (prev === entry.id ? null : entry.id))
                    }
                  >
                    <span
                      className="text-muted-foreground transition-transform flex-shrink-0 mt-0.5"
                      style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                    <Brain
                      className="h-3.5 w-3.5 flex-shrink-0 mt-0.5"
                      style={{ color: "var(--em-primary)" }}
                    />
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <Textarea
                          autoFocus
                          value={editing.content}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditing({ id: entry.id, content: e.target.value })}
                          className="min-h-[72px] text-[13px]"
                          maxLength={2000}
                        />
                      ) : (
                        <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap break-words">
                          {isExpanded ? entry.content : preview}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/70">
                          {formatTimestamp(entry.updatedAt)}
                        </span>
                        {categoryFilter && (
                          <Badge
                            className={`text-[9px] px-1.5 py-0 border-0 ${CATEGORY_COLORS[entry.category] ?? "bg-muted text-muted-foreground"}`}
                            variant="secondary"
                          >
                            {CATEGORY_LABELS[entry.category] ?? entry.category}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground/50">
                          {wsName ? `工作区：${wsName}` : "全局"}
                        </span>
                        {entry.lastUsedAt && (
                          <span className="text-[10px] text-muted-foreground/50">
                            最近使用 {formatTimestamp(entry.lastUsedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className="flex flex-shrink-0 gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {busyId === entry.id ? (
                        <Loader2 className="m-1.5 h-3 w-3 animate-spin text-muted-foreground" />
                      ) : isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label="保存"
                            onClick={() => void handleSaveEdit()}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label="取消"
                            onClick={() => setEditing(null)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label="编辑"
                            onClick={() => setEditing({ id: entry.id, content: entry.content })}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive"
                            aria-label="删除"
                            onClick={() => void handleDelete(entry.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </div>
  );
}
