import { useEffect, useState } from "react";
import { reasoningOptions } from "../reasoning.ts";
import { apiClientOf, refreshProfiles, switchModel, useApp } from "../store.ts";
import { S, ST } from "../strings.ts";
import { Icon } from "./Icon.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { ChoiceItem, RadioGroup, Slider } from "./ui/controls.tsx";
import { Popover, PopoverContent, PopoverTrigger, toast } from "./ui/overlay.tsx";

const levels = reasoningOptions.filter((option) => option.value !== "provider-default");

export function ModelReasoningControl() {
  const profiles = useApp((s) => s.profiles);
  const sessionId = useApp((s) => s.sessionId);
  const agentId = useApp((s) => s.agentId);
  const modelId = useApp((s) => s.session.roster[s.agentId]?.modelProfileId);
  const profile = profiles.find((p) => p.id === modelId) ?? profiles.find((p) => p.isDefault);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"models" | "reasoning">("models");
  const [saving, setSaving] = useState(false);
  const [level, setLevel] = useState(profile?.reasoning ?? "provider-default");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换档案时也重置尚未提交的滑条值
  useEffect(
    () => setLevel(profile?.reasoning ?? "provider-default"),
    [profile?.reasoning, profile?.id],
  );
  // 切换会话/代理时关闭菜单，避免操作旧的档案。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话/代理变化时关闭旧档案的弹层
  useEffect(() => {
    setOpen(false);
  }, [sessionId, agentId]);
  const label = (value: typeof level) =>
    value === "minimal" ? ST.savedMinimalReasoning : ST.thinkingLabel[value];
  const saveLevel = async (value: typeof level) => {
    if (!profile || saving) return;
    setSaving(true);
    try {
      await apiClientOf().updateModelProfile(profile.id, { reasoning: value });
      await refreshProfiles();
    } catch (error) {
      if (useApp.getState().sessionId === sessionId && useApp.getState().agentId === agentId) {
        setLevel(profile.reasoning ?? "provider-default");
      }
      toast({ tone: "err", title: error instanceof Error ? error.message : ST.saveFailed });
    } finally {
      setSaving(false);
    }
  };
  const index = levels.findIndex((option) => option.value === level);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label={S.modelSelectHint}
          disabled={!profile || saving}
          className="composer-model-control min-w-0 max-w-[calc(100%_-_44px)] gap-1.5 rounded-full px-3 text-sm font-normal data-[state=open]:bg-muted"
          onClick={() => setPage("models")}
        >
          <span className="truncate">{profile?.name ?? S.modelOptionsTitle}</span>
          <span className="shrink-0 text-muted-foreground">
            {label(profile?.reasoning ?? "provider-default")}
          </span>
          <Icon name="chevronDown" size="sm" className="shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="composer-model-popover w-80 rounded-3xl p-2.5"
      >
        {page === "models" ? (
          <>
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1">
              <span className="text-sm font-medium text-muted-foreground">
                {S.modelOptionsTitle}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={saving}
                onClick={() => setPage("reasoning")}
              >
                {S.reasoningLevel}
                <Icon name="chevronRight" size="xs" />
              </Button>
            </div>
            <span className="block px-3 pb-1 text-xs text-muted-foreground">
              {S.modelConfigured}
            </span>
            <RadioGroup
              aria-label={S.modelOptionsTitle}
              value={profile?.id ?? ""}
              className="max-h-[min(360px,55vh)] gap-0.5 overflow-y-auto"
              onValueChange={(id) => {
                if (saving) return;
                setSaving(true);
                void switchModel(id)
                  .then(() => setOpen(false))
                  .catch((error: unknown) => {
                    toast({
                      tone: "err",
                      title: error instanceof Error ? error.message : S.modelSwitchFailed,
                    });
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {profiles.map((p) => (
                <ChoiceItem
                  key={p.id}
                  value={p.id}
                  disabled={saving}
                  className="min-h-11 rounded-2xl px-3"
                >
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.isDefault && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {ST.thinkingLabel["provider-default"]}
                    </span>
                  )}
                </ChoiceItem>
              ))}
            </RadioGroup>
          </>
        ) : (
          <div className="flex flex-col gap-3 px-2 pb-2 pt-1">
            <div className="grid grid-cols-[32px_1fr_32px] items-center gap-2">
              <Icon name="zap" size="lg" className="text-muted-foreground" />
              <div className="text-center text-lg font-medium text-[#387ef7]" aria-live="polite">
                {label(level)}
              </div>
              <IconButton
                icon="history"
                label={S.reasoningReset}
                disabled={saving}
                onClick={() => void saveLevel("provider-default")}
              />
            </div>
            <Button
              variant="ghost"
              className="h-auto min-w-0 gap-1 pb-2 pt-0 font-normal text-muted-foreground"
              aria-label={S.reasoningModel}
              onClick={() => setPage("models")}
            >
              <span className="truncate">{profile?.name}</span>
              <Icon name="chevronRight" size="sm" />
            </Button>
            <div className="reasoning-scale relative" data-unset={index < 0 || undefined}>
              <Slider
                value={Math.max(0, index)}
                min={0}
                max={levels.length - 1}
                ariaLabel={S.reasoningLevel}
                valueText={label(level)}
                disabled={saving}
                className="reasoning-slider h-10"
                onChange={(value) => {
                  const next = levels[value];
                  if (next) setLevel(next.value);
                }}
                onCommit={(value) => {
                  const next = levels[value];
                  if (next) void saveLevel(next.value);
                }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-4 inset-y-0 flex items-center justify-between"
              >
                {levels.map((option) => (
                  <span key={option.value} className="size-1.5 rounded-full bg-foreground/25" />
                ))}
              </div>
            </div>
            <p className="text-center text-2xs leading-relaxed text-muted-foreground">
              {profile ? S.reasoningHint(profile.name) : S.needModelTitle}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
