// 设置中心（02、16 §4）：左侧导航 + 搜索，右侧分页；Esc 关闭，焦点陷阱由 Dialog 提供。

import { useEffect, useState } from "react";
import { setSettingsOpen, useApp } from "../store.ts";
import { S, ST } from "../strings.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { AboutTab } from "./settings/AboutTab.tsx";
import { AccountsTab } from "./settings/AccountsTab.tsx";
import { FilesTab } from "./settings/FilesTab.tsx";
import { GeneralTab } from "./settings/GeneralTab.tsx";
import { McpTab } from "./settings/McpTab.tsx";
import { MemoriesTab } from "./settings/MemoriesTab.tsx";
import { ModelsTab } from "./settings/ModelsTab.tsx";
import { RulesTab } from "./settings/RulesTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";
import { IconButton } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Badge, EmptyState, NavItem, SectionLabel } from "./ui/display.tsx";
import { FormGuard, useFormGuard } from "./ui/form-guard.tsx";
import { SearchInput } from "./ui/input.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { ScrollArea } from "./ui/overlay.tsx";
import { PageHeader } from "./ui/page-layout.tsx";

type Tab = keyof typeof ST.tabs;

const TAB_ICONS: Record<Tab, IconName> = {
  models: "cpu",
  accounts: "user",
  general: "sliders",
  rules: "rules",
  memories: "brain",
  skills: "book",
  mcp: "plug",
  files: "folder",
  about: "info",
};

export function SettingsModal() {
  return (
    <FormGuard>
      <SettingsContent />
    </FormGuard>
  );
}

function SettingsContent() {
  const guard = useFormGuard();
  const close = async () => {
    if (await guard.confirmLeave()) setSettingsOpen(false);
  };
  const open = useApp((s) => s.settingsOpen);
  const initial = useApp((s) => s.settingsTab) as Tab;
  const [tab, setTab] = useState<Tab>(initial in ST.tabs ? initial : "models");
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) {
      setTab(initial in ST.tabs ? initial : "models");
      setQ("");
    }
  }, [open, initial]);
  const profiles = useApp((s) => s.profiles);
  // 导航上的状态值只取已知真实数据（对齐清单 A10）
  const status: Partial<Record<Tab, string>> = {
    ...(profiles.length > 0 ? { models: ST.tabStatus.profiles(profiles.length) } : {}),
  };
  const matches = (t: Tab, needle: string) =>
    needle === "" || `${ST.tabs[t]} ${ST.tabKeywords[t]}`.toLowerCase().includes(needle);
  const tabs = (Object.keys(ST.tabs) as Tab[]).filter((t) => matches(t, q.trim().toLowerCase()));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) void close();
      }}
    >
      <DialogContent
        aria-describedby="settings-intro"
        className="settings-shell grid h-[min(920px,calc(100dvh-40px))] w-[min(1360px,calc(100vw-40px))] grid-cols-[228px_minmax(0,1fr)] overflow-hidden p-0 max-[900px]:grid-cols-[196px_minmax(0,1fr)] max-[700px]:h-[calc(100dvh-24px)] max-[700px]:w-[calc(100vw-24px)] max-[700px]:grid-cols-1 max-[700px]:grid-rows-[auto_minmax(0,1fr)]"
      >
        <nav
          className="settings-nav flex min-h-0 flex-col gap-7 border-r border-border/70 bg-muted/60 max-[700px]:gap-3 max-[700px]:border-r-0 max-[700px]:border-b"
          aria-label={ST.title}
        >
          <div className="flex flex-col gap-6 px-5 pt-8 max-[700px]:flex-row max-[700px]:items-center max-[700px]:gap-4 max-[700px]:pt-5">
            <DialogTitle className="settings-nav-title px-1 text-lg font-semibold tracking-tight max-[700px]:shrink-0">
              {ST.title}
            </DialogTitle>
            <SearchInput
              size="sm"
              className="settings-search min-w-0 max-[700px]:flex-1 [&>input]:border-border/70 [&>input]:bg-card/65 [&>input]:shadow-none"
              placeholder={ST.search}
              aria-label={ST.search}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
            />
          </div>
          <ScrollArea
            className="flex-1 max-[700px]:flex-none"
            viewportClassName="max-[700px]:overflow-x-auto!"
          >
            <div className="flex flex-col gap-7 px-4 pb-6 max-[700px]:w-max max-[700px]:flex-row max-[700px]:gap-1 max-[700px]:px-4 max-[700px]:pb-3">
              {ST.groups.map((g) => {
                const items = g.tabs.filter((t) => tabs.includes(t as Tab)) as Tab[];
                if (items.length === 0) return null;
                return (
                  <div
                    className="settings-nav-group flex flex-col gap-1 max-[700px]:flex-row"
                    key={g.title}
                  >
                    <SectionLabel className="px-2.5 pb-2 max-[700px]:hidden">
                      {g.title}
                    </SectionLabel>
                    {items.map((t) => (
                      <NavItem
                        key={t}
                        className="settings-nav-item h-10 max-[700px]:h-9"
                        current={t === tab}
                        icon={
                          <Icon
                            name={TAB_ICONS[t]}
                            size="sm"
                            className={t === tab ? "text-foreground" : "text-muted-foreground"}
                          />
                        }
                        meta={status[t] ? <Badge tone="neutral">{status[t]}</Badge> : undefined}
                        onClick={() => {
                          if (t === tab) return;
                          void guard.confirmLeave().then((ok) => {
                            if (ok) setTab(t);
                          });
                        }}
                      >
                        {ST.tabs[t]}
                      </NavItem>
                    ))}
                  </div>
                );
              })}
              {tabs.length === 0 && <EmptyState size="inline" title={ST.empty} />}
            </div>
          </ScrollArea>
        </nav>
        <div className="settings-page @container flex min-h-0 min-w-0 flex-col">
          <PageHeader
            className="settings-page-header"
            title={ST.tabs[tab]}
            description={
              <DialogDescription id="settings-intro">{ST.tabIntro[tab]}</DialogDescription>
            }
            actions={
              <IconButton
                icon="x"
                size="icon"
                label={S.close}
                tooltip={
                  <span>
                    {S.close} <Kbd inverted>Esc</Kbd>
                  </span>
                }
                onClick={() => void close()}
              />
            }
          />
          <ScrollArea key={tab} className="flex-1">
            <div className="settings-body flex w-full scroll-pb-20 flex-col gap-9 px-10 py-7 @max-[600px]:gap-7 @max-[600px]:px-6 @max-[600px]:py-6">
              {tab === "models" && <ModelsTab />}
              {tab === "accounts" && <AccountsTab />}
              {tab === "general" && <GeneralTab />}
              {tab === "rules" && <RulesTab />}
              {tab === "memories" && <MemoriesTab />}
              {tab === "skills" && <SkillsTab />}
              {tab === "mcp" && <McpTab />}
              {tab === "files" && <FilesTab />}
              {tab === "about" && <AboutTab />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
