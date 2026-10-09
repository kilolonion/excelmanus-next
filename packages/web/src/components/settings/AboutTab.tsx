// 设置 → 外观与关于（02 §7）：主题、字号；版本、检查更新（桌面）、快捷键列表、重新打开引导。

import { useState } from "react";
import userGuide from "../../../../../docs/user-guide.md?raw";
import { desktop } from "../../api.ts";
import { renderMarkdown } from "../../md.ts";
import { SHORTCUTS } from "../../shortcuts.ts";
import { setOnboardingOpen, setSettingsOpen, useApp } from "../../store.ts";
import { S, ST } from "../../strings.ts";
import { getFontSize, getTheme, setFontSize, setTheme, type ThemePref } from "../../theme.ts";
import { Button } from "../ui/button.tsx";
import { SegmentedControl, Slider } from "../ui/controls.tsx";
import { Label } from "../ui/field.tsx";
import { Kbd, Shortcut } from "../ui/kbd.tsx";
import { Disclosure } from "../ui/overlay.tsx";
import { Feedback, Section, useAction } from "./common.tsx";

export function AboutTab() {
  const version = useApp((s) => s.appVersion);
  const shape = useApp((s) => s.shape);
  const [theme, setThemeState] = useState<ThemePref>(getTheme());
  const [font, setFont] = useState(getFontSize());
  const act = useAction();
  const d = desktop();
  return (
    <>
      <Section title={ST.appearance}>
        <div className="settings-rows flex flex-col divide-y divide-border/65">
          <div className="settings-row flex flex-wrap items-center justify-between gap-4 pb-5">
            <span className="text-sm font-medium">{ST.theme}</span>
            <SegmentedControl
              value={theme}
              ariaLabel={ST.theme}
              onChange={(t) => {
                setTheme(t);
                setThemeState(t);
              }}
              options={[
                { value: "system", label: ST.themeSystem, icon: "monitor" },
                { value: "light", label: ST.themeLight, icon: "sun" },
                { value: "dark", label: ST.themeDark, icon: "moon" },
              ]}
            />
          </div>
          <div className="settings-row flex flex-wrap items-center justify-between gap-4 pt-5">
            <Label className="text-sm font-medium text-foreground">{ST.fontSize}</Label>
            <div className="flex w-64 max-w-full items-center gap-3">
              <Slider
                value={font}
                min={12}
                max={18}
                ariaLabel={ST.fontSize}
                valueText={S.fontSizeValue(font)}
                onChange={(n) => {
                  setFontSize(n);
                  setFont(n);
                }}
              />
              <span className="w-10 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {font}px
              </span>
            </div>
          </div>
        </div>
      </Section>
      <Section title={ST.shortcuts}>
        <dl className="settings-shortcuts grid grid-cols-1 gap-x-9 @min-[640px]:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <div
              key={s.action}
              className="flex items-center justify-between gap-4 border-b border-border/60 py-3"
            >
              <dt className="text-xs text-foreground-secondary">{s.label}</dt>
              <dd>
                <Shortcut keys={s.key.toUpperCase()} />
              </dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 border-b border-border/60 py-3">
            <dt className="text-xs text-foreground-secondary">{ST.escHint}</dt>
            <dd>
              <Kbd>Esc</Kbd>
            </dd>
          </div>
        </dl>
      </Section>
      <Section title={ST.about}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <strong className="text-lg font-semibold tracking-tight">{S.appName}</strong>
          <span className="font-mono text-xs text-muted-foreground">{version}</span>
          <span className="text-xs text-muted-foreground">
            {shape === "desktop" ? ST.shapeDesktop : ST.shapeWeb}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {d && (
            <Button
              size="sm"
              variant="outline"
              loading={act.busy}
              onClick={() =>
                void act.run(async () => {
                  const r = await d.checkForUpdates();
                  if (r.status === "error" || r.status === "unavailable")
                    throw new Error(r.message ?? ST.updateUnavailable);
                  return r;
                }, ST.updateChecked)
              }
            >
              {ST.checkUpdates}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSettingsOpen(false);
              setOnboardingOpen(true);
            }}
          >
            {ST.reopenOnboarding}
          </Button>
        </div>
        <Feedback msg={act.msg} />
        <p className="text-xs text-muted-foreground">{ST.privacyNote}</p>
      </Section>
      <Section title={ST.userGuide}>
        <Disclosure summary={ST.userGuideRead}>
          <div
            className="md text-sm"
            ref={(el) => {
              if (el && !el.hasChildNodes()) el.innerHTML = renderMarkdown(userGuide);
            }}
          />
        </Disclosure>
      </Section>
    </>
  );
}
