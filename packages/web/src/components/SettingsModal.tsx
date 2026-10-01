// 设置中心（02、16 §4）：左侧导航 + 搜索，右侧分页；Esc 关闭，焦点陷阱由 Dialog 提供。

import { useState } from "react";
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
import { SearchInput } from "./ui/input.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { ScrollArea } from "./ui/overlay.tsx";

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
  const initial = useApp((s) => s.settingsTab) as Tab;
  const [tab, setTab] = useState<Tab>(initial in ST.tabs ? initial : "models");
  const [q, setQ] = useState("");
  const profiles = useApp((s) => s.profiles);
  // 导航上的状态值只取已知真实数据（对齐清单 A10）
  const status: Partial<Record<Tab, string>> = {
    ...(profiles.length > 0 ? { models: ST.tabStatus.profiles(profiles.length) } : {}),
  };
  const matches = (t: Tab, needle: string) =>
    needle === "" || `${ST.tabs[t]} ${ST.tabKeywords[t]}`.toLowerCase().includes(needle);
  const tabs = (Object.keys(ST.tabs) as Tab[]).filter((t) => matches(t, q.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(o) => !o && setSettingsOpen(false)}>
      <DialogContent
        aria-describedby="settings-intro"
        className="grid h-[min(780px,calc(100vh-48px))] w-[min(1080px,calc(100vw-48px))] grid-cols-[220px_minmax(0,1fr)] overflow-hidden p-0"
      >
        <nav
          className="flex min-h-0 flex-col gap-3 border-r border-border bg-background"
          aria-label={ST.title}
        >
          <div className="flex flex-col gap-3 px-3 pt-5">
            <DialogTitle className="px-1 text-lg">{ST.title}</DialogTitle>
            <SearchInput
              size="sm"
              placeholder={ST.search}
              aria-label={ST.search}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                const first = (Object.keys(ST.tabs) as Tab[]).find((t) =>
                  matches(t, e.target.value.trim().toLowerCase()),
                );
                if (first) setTab(first);
              }}
            />
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-4 px-3 pb-4">
              {ST.groups.map((g) => {
                const items = g.tabs.filter((t) => tabs.includes(t as Tab)) as Tab[];
                if (items.length === 0) return null;
                return (
                  <div className="flex flex-col gap-0.5" key={g.title}>
                    <SectionLabel className="px-2 pb-1">{g.title}</SectionLabel>
                    {items.map((t) => (
                      <NavItem
                        key={t}
                        current={t === tab}
                        icon={
                          <Icon name={TAB_ICONS[t]} size="sm" className="text-muted-foreground" />
                        }
                        meta={status[t] ? <Badge tone="neutral">{status[t]}</Badge> : undefined}
                        onClick={() => setTab(t)}
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
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 items-start gap-4 border-b border-border px-8 pt-6 pb-5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-xl font-semibold">{ST.tabs[tab]}</h2>
              <DialogDescription id="settings-intro" className="max-w-[680px]">
                {ST.tabIntro[tab]}
              </DialogDescription>
            </div>
            <IconButton
              icon="x"
              size="icon"
              label={S.close}
              tooltip={
                <span className="flex items-center gap-1.5">
                  {S.close}
                  <Kbd inverted>Esc</Kbd>
                </span>
              }
              onClick={() => setSettingsOpen(false)}
            />
          </div>
          <ScrollArea className="flex-1">
            <div className="flex max-w-[860px] scroll-pb-16 flex-col gap-8 px-8 py-6">
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
