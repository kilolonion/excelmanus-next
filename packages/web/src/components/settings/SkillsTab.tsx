import type { Skill, SkillDetail, SkillSource } from "@excelmanus/protocol";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Code,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Github,
  Loader2,
  Package,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsEntityCard } from "@/components/settings/SettingsEntityCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { api, desktop, errorMessage } from "@/lib/backend/api";
import { onAppEvent } from "@/stores/app-store";

const SOURCE_COLORS: Record<string, string> = {
  builtin: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  user: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  workspace: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const SOURCE_LABELS: Record<string, string> = {
  all: "全部",
  builtin: "内置",
  user: "用户",
  workspace: "工作区",
};

type ImportMethod = "file" | "github";
type SourceFilter = "all" | SkillSource;

export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillDetails, setSkillDetails] = useState<Record<string, SkillDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const detailGeneration = useRef(0);
  const waitingForList = loading && skills.length === 0;

  const [showImport, setShowImport] = useState(false);
  const [importMethod, setImportMethod] = useState<ImportMethod>("file");
  const [importSource, setImportSource] = useState("");
  const [importing, setImporting] = useState<"preview" | "import" | null>(null);
  const [preview, setPreview] = useState<SkillDetail[] | null>(null);

  const filteredSkills = useMemo(
    () => (sourceFilter === "all" ? skills : skills.filter((s) => s.source === sourceFilter)),
    [skills, sourceFilter],
  );

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: skills.length,
      builtin: 0,
      user: 0,
      workspace: 0,
    };
    for (const s of skills) counts[s.source] = (counts[s.source] || 0) + 1;
    return counts;
  }, [skills]);

  const fetchSkills = useCallback(async () => {
    const request = ++listRequest.current;
    setLoadError(null);
    setLoading(true);
    try {
      const { items } = await api().listSkills();
      if (request !== listRequest.current) return;
      setSkills(items);
    } catch (error) {
      if (request !== listRequest.current) return;
      setLoadError(errorMessage(error, "读取技能失败"));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSkills();
    return () => {
      listRequest.current += 1;
      detailGeneration.current += 1;
    };
  }, [fetchSkills]);

  const fetchDetail = useCallback(async (name: string) => {
    const generation = detailGeneration.current;
    try {
      const { skill } = await api().getSkill(name);
      if (generation !== detailGeneration.current) return;
      setSkillDetails((prev) => ({ ...prev, [name]: skill }));
    } catch (error) {
      if (generation !== detailGeneration.current) return;
      toast({ title: "读取技能详情失败", description: errorMessage(error), tone: "error" });
      setExpandedSkill((cur) => (cur === name ? null : cur));
    }
  }, []);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "skills.changed") {
          detailGeneration.current += 1;
          setSkillDetails({});
          void fetchSkills();
          if (expandedSkill) void fetchDetail(expandedSkill);
        }
      }),
    [fetchSkills, fetchDetail, expandedSkill],
  );

  const toggleExpand = (name: string) => {
    if (expandedSkill === name) {
      setExpandedSkill(null);
      return;
    }
    setExpandedSkill(name);
    if (!skillDetails[name]) void fetchDetail(name);
  };

  const handleToggle = async (skill: Skill, enabled: boolean) => {
    setBusy(skill.name);
    setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled } : s)));
    try {
      await api().setSkillEnabled(skill.name, enabled);
    } catch (error) {
      setSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? { ...s, enabled: skill.enabled } : s)),
      );
      toast({ title: "更新失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirmAction({
      title: "删除技能",
      description: `确定删除技能「${name}」？此操作会删除导入的技能文件。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const snapshot = skills;
    setSkills((prev) => prev.filter((s) => s.name !== name));
    try {
      await api().deleteSkill(name);
    } catch (error) {
      setSkills(snapshot);
      toast({ title: "删除失败", description: errorMessage(error), tone: "error" });
    }
  };

  const resetImportState = () => {
    setShowImport(false);
    setImportSource("");
    setPreview(null);
    setImporting(null);
  };

  const runImport = async (previewOnly: boolean) => {
    const source = importSource.trim();
    if (!source) return;
    setImporting(previewOnly ? "preview" : "import");
    try {
      const res = await api().importSkill(source, previewOnly);
      if (previewOnly) {
        setPreview(res.skills);
      } else {
        toast({ title: `已导入 ${res.skills.map((s) => s.name).join("、")}`, tone: "success" });
        resetImportState();
        void fetchSkills();
      }
    } catch (error) {
      toast({
        title: previewOnly ? "解析失败" : "导入失败",
        description: errorMessage(error),
        tone: "error",
      });
    } finally {
      setImporting(null);
    }
  };

  const chooseFolder = async () => {
    const dir = await desktop()?.chooseDirectory();
    if (dir) {
      setImportSource(dir);
      setPreview(null);
    }
  };

  return (
    <div className="space-y-3">
      <section className="em-plugin-panel space-y-3 rounded-xl border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
              <Package className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">技能仓库</h4>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {loadError
                  ? "技能列表读取失败"
                  : waitingForList
                    ? "正在读取技能列表…"
                    : `已加载 ${skills.length} 个技能包，可按来源筛选`}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5 shrink-0"
            onClick={() => {
              resetImportState();
              setShowImport(true);
              setImportMethod("file");
            }}
          >
            <Plus className="h-3 w-3" />
            导入技能
          </Button>
        </div>

        <div className="min-w-0 overflow-x-auto scrollbar-none">
          <div className="flex items-center gap-1 sm:gap-1.5">
            {(["all", "builtin", "user", "workspace"] as const).map((src) => {
              const isActive = sourceFilter === src;
              const count = sourceCounts[src] || 0;
              if (src !== "all" && count === 0) return null;
              return (
                <button
                  key={src}
                  type="button"
                  className={`inline-flex items-center gap-1 px-2 py-1 sm:py-0.5 rounded-full text-[11px] font-medium transition-colors whitespace-nowrap border flex-shrink-0 ${
                    isActive
                      ? "border-[var(--em-primary)] bg-[var(--em-primary-alpha-10)]"
                      : "border-border text-muted-foreground hover:bg-muted/60"
                  }`}
                  style={isActive ? { color: "var(--em-primary)" } : undefined}
                  onClick={() => setSourceFilter(src)}
                >
                  {SOURCE_LABELS[src]}
                  <span
                    className={`text-[10px] ${isActive ? "opacity-70" : "text-muted-foreground/60"}`}
                  >
                    {waitingForList || loadError ? "…" : count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {showImport && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="rounded-lg border border-dashed border-border p-3 space-y-3 overflow-hidden"
        >
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
            {[
              { key: "file" as const, label: "本地目录", icon: <FolderOpen className="h-3 w-3" /> },
              { key: "github" as const, label: "GitHub", icon: <Github className="h-3 w-3" /> },
            ].map((tab) => {
              const isActive = importMethod === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap border ${
                    isActive
                      ? "text-white border-transparent"
                      : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                  style={isActive ? { backgroundColor: "var(--em-primary)" } : undefined}
                  onClick={() => {
                    setImportMethod(tab.key);
                    setImportSource("");
                    setPreview(null);
                  }}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              );
            })}
          </div>

          {importMethod === "file" ? (
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                技能目录（本地绝对路径，目录内含 SKILL.md）
              </label>
              <div className="flex gap-2">
                <Input
                  value={importSource}
                  onChange={(e) => {
                    setImportSource(e.target.value);
                    setPreview(null);
                  }}
                  className="h-8 text-xs font-mono flex-1"
                  placeholder="/path/to/my-skill"
                />
                {desktop() && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => void chooseFolder()}
                  >
                    选择…
                  </Button>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                同目录下的附属文件（scripts/、references/
                等）会一并导入；目录下有多个技能时全部导入。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">GitHub 仓库或目录地址</label>
              <Input
                value={importSource}
                onChange={(e) => {
                  setImportSource(e.target.value);
                  setPreview(null);
                }}
                className="h-8 text-xs font-mono"
                placeholder="https://github.com/org/repo/tree/main/skills/my-skill"
              />
              <p className="text-[10px] text-muted-foreground">
                将下载仓库内的 SKILL.md 及附属文件，经网络代理设置访问。
              </p>
            </div>
          )}

          {preview && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                将导入 {preview.length} 个技能：
              </p>
              {preview.map((skill) => (
                <div
                  key={skill.name}
                  className="rounded-md border border-border/60 bg-muted/20 p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium">{skill.name}</span>
                    {skill.version && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                        v{skill.version}
                      </Badge>
                    )}
                    {skill.overrides.length > 0 && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                        覆盖同名{SOURCE_LABELS[skill.overrides[0]] ?? ""}技能
                      </Badge>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-1 text-[10px] text-muted-foreground">{skill.description}</p>
                  )}
                  {skill.missingTools.length > 0 && (
                    <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                      缺少工具：{skill.missingTools.join("、")}
                    </p>
                  )}
                  {skill.resources.length > 0 && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {skill.resources.length} 个附属文件
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 sm:h-7 text-xs gap-1"
              onClick={resetImportState}
            >
              <X className="h-3 w-3" /> 取消
            </Button>
            {!preview ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 sm:h-7 text-xs gap-1"
                disabled={importing !== null || !importSource.trim()}
                onClick={() => void runImport(true)}
              >
                {importing === "preview" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}{" "}
                预览
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 sm:h-7 text-xs gap-1 text-white"
                style={{ backgroundColor: "var(--em-primary)" }}
                disabled={importing !== null}
                onClick={() => void runImport(false)}
              >
                {importing === "import" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}{" "}
                导入
              </Button>
            )}
          </div>
        </motion.div>
      )}

      <section
        className="em-plugin-panel space-y-2 rounded-xl border p-3"
        data-coach-id="coach-settings-skills-list"
      >
        <div className="flex items-center justify-between gap-2 px-0.5">
          <div>
            <h4 className="text-sm font-medium">已安装技能</h4>
            <p className="text-[10px] text-muted-foreground">
              点击卡片查看指令与资源；关闭后 Agent 不再使用该技能
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
            {waitingForList ? "读取中" : loadError ? "读取失败" : `${filteredSkills.length} 个`}
          </span>
        </div>
        {waitingForList ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : loadError ? (
          <div role="alert" className="flex items-center gap-2 py-4 text-xs text-destructive">
            <span className="min-w-0 flex-1">{loadError}</span>
            <Button size="sm" variant="outline" onClick={() => void fetchSkills()}>
              重新读取
            </Button>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="rounded-xl border border-dashed text-center py-10">
            <Sparkles className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              {sourceFilter === "all"
                ? "暂无已加载的技能包"
                : `暂无${SOURCE_LABELS[sourceFilter]}技能`}
            </p>
          </div>
        ) : null}
        {filteredSkills.map((skill) => {
          const isExpanded = expandedSkill === skill.name;
          const detail = skillDetails[skill.name];
          return (
            <SettingsEntityCard
              key={skill.name}
              expandable
              expanded={isExpanded}
              onClick={() => toggleExpand(skill.name)}
              icon={<Package className="h-3.5 w-3.5" style={{ color: "var(--em-primary)" }} />}
              name={skill.name}
              badges={
                <>
                  <Badge
                    className={`text-[9px] px-1.5 py-0 shrink-0 border-0 ${SOURCE_COLORS[skill.source] || "bg-muted text-muted-foreground"}`}
                    variant="secondary"
                  >
                    {SOURCE_LABELS[skill.source] || skill.source}
                  </Badge>
                  {!skill.available && (
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 shrink-0 text-amber-700 dark:text-amber-400"
                      title={`缺少工具：${skill.missingTools.join("、")}`}
                    >
                      不可用
                    </Badge>
                  )}
                  {skill.userInvocable && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 font-mono">
                      /{skill.name}
                    </Badge>
                  )}
                </>
              }
              description={skill.description}
              actions={
                <>
                  <Switch
                    checked={skill.enabled}
                    disabled={busy === skill.name}
                    onCheckedChange={(checked) => void handleToggle(skill, checked)}
                    aria-label={skill.enabled ? "停用技能" : "启用技能"}
                  />
                  {skill.source === "user" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive"
                      title="删除"
                      onClick={() => void handleDelete(skill.name)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </>
              }
            >
              {isExpanded && (
                <div className="border-t border-border/50 px-4 py-3 space-y-2.5 bg-muted/20">
                  {detail ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.version && (
                          <Badge variant="outline" className="text-[10px] gap-0.5">
                            <Code className="h-2.5 w-2.5" />v{detail.version}
                          </Badge>
                        )}
                        {!detail.modelInvocable && (
                          <Badge variant="secondary" className="text-[10px]">
                            仅手动调用
                          </Badge>
                        )}
                        {detail.overrides.map((src) => (
                          <Badge key={src} variant="secondary" className="text-[10px]">
                            覆盖{SOURCE_LABELS[src] ?? src}同名技能
                          </Badge>
                        ))}
                      </div>
                      {detail.missingTools.length > 0 && (
                        <p className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" />
                          缺少工具：{detail.missingTools.join("、")}
                        </p>
                      )}
                      {detail.body && (
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <FileText className="h-3 w-3 text-muted-foreground" />
                            <span className="text-[10px] font-medium text-muted-foreground">
                              指令
                            </span>
                          </div>
                          <pre className="text-[11px] font-mono bg-background rounded-md p-2.5 max-h-36 overflow-auto whitespace-pre-wrap break-words border border-border/50 leading-relaxed">
                            {detail.body}
                          </pre>
                        </div>
                      )}
                      {detail.resources.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <FolderOpen className="h-3 w-3 text-muted-foreground" />
                            <span className="text-[10px] font-medium text-muted-foreground">
                              附属文件（{detail.resources.length}）
                            </span>
                          </div>
                          <div className="rounded-md border border-border/50 bg-background divide-y divide-border/30">
                            {detail.resources.map((r) => (
                              <div
                                key={r}
                                className="px-2.5 py-1.5 text-[11px] font-mono text-muted-foreground truncate"
                              >
                                {r}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-2 py-3 justify-center">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">加载详情...</span>
                    </div>
                  )}
                </div>
              )}
            </SettingsEntityCard>
          );
        })}
      </section>
    </div>
  );
}
