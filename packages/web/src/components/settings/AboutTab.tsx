// 设置 → 外观与关于（02 §7）：主题、字号；版本、检查更新（桌面）、快捷键列表、重新打开引导。

import { useState } from "react";
import { desktop } from "../../api.ts";
import { SHORTCUTS } from "../../shortcuts.ts";
import { setOnboardingOpen, setSettingsOpen, useApp } from "../../store.ts";
import { S, ST } from "../../strings.ts";
import { getFontSize, getTheme, setFontSize, setTheme, type ThemePref } from "../../theme.ts";
import { Button } from "../ui/button.tsx";
import { SegmentedControl, Slider } from "../ui/controls.tsx";
import { Card } from "../ui/display.tsx";
import { Label } from "../ui/field.tsx";
import { Kbd, Shortcut } from "../ui/kbd.tsx";
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
        <Card className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-sm">{ST.theme}</span>
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
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <Label className="text-sm font-normal text-foreground">{ST.fontSize}</Label>
            <div className="flex w-64 items-center gap-3">
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
        </Card>
      </Section>
      <Section title={ST.shortcuts}>
        <Card asChild className="flex flex-col divide-y divide-border">
          <dl>
            {SHORTCUTS.map((s) => (
              <div key={s.action} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <dd className="text-sm">{s.label}</dd>
                <dt>
                  <Shortcut keys={s.key.toUpperCase()} />
                </dt>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dd className="text-sm">{ST.escHint}</dd>
              <dt>
                <Kbd>Esc</Kbd>
              </dt>
            </div>
          </dl>
        </Card>
      </Section>
      <Section title={ST.about}>
        <p className="text-sm">
          {S.appName} <span className="font-mono">{version}</span> ·{" "}
          {shape === "desktop" ? ST.shapeDesktop : ST.shapeWeb}
        </p>
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
    </>
  );
}
