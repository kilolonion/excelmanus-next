// 输入框候选（02 §3.3、对齐清单 C5）：`@` 引用文件 / 已打开工作簿的工作表 / 技能，`/` 列出命令与可调用技能。
// 候选只来自真实数据：工作区文件列表、当前文档快照、技能列表。

import type { Skill } from "@excelmanus/protocol";
import { useEffect, useMemo, useState } from "react";
import { COMPOSER_SUGGEST_ID } from "../dom-ids.ts";
import { apiClientOf, pinRange, useApp } from "../store.ts";
import { S } from "../strings.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { CommandFooter, CommandItem, CommandList } from "./ui/command.tsx";
import { Kbd } from "./ui/kbd.tsx";

export { triggerAt } from "../trigger.ts";

import type { triggerAt } from "../trigger.ts";

export interface SuggestItem {
  key: string;
  icon: IconName;
  label: string;
  hint: string;
  /** 选中后替换触发词的文本。 */
  insert: string;
  /** 选中时的附加动作（如把工作表区域钉为上下文）。 */
  apply?: () => void;
  /** 技能调用只认消息开头的 /技能名（12 §1.4）：选中后加到开头。 */
  prefix?: string;
}

let skillCache: Skill[] | null = null;

function useSkills(enabled: boolean): Skill[] {
  const [skills, setSkills] = useState<Skill[]>(skillCache ?? []);
  useEffect(() => {
    if (!enabled || skillCache) return;
    apiClientOf()
      .listSkills()
      .then((r) => {
        skillCache = r.items;
        setSkills(r.items);
      })
      .catch(() => undefined);
  }, [enabled]);
  return skills;
}

type Snapshot = {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string; cellData?: Record<string, Record<string, unknown>> }>;
};

/** 工作表已用区域（按快照里的非空单元格），用于 `@工作表` 钉成上下文。 */
function usedRange(sheet: NonNullable<Snapshot["sheets"]>[string]): string | null {
  let r1 = -1;
  let c1 = -1;
  for (const [r, row] of Object.entries(sheet.cellData ?? {})) {
    for (const c of Object.keys(row)) {
      r1 = Math.max(r1, Number(r));
      c1 = Math.max(c1, Number(c));
    }
  }
  if (r1 < 0) return null;
  let col = "";
  for (let n = c1 + 1; n > 0; n = Math.floor((n - 1) / 26))
    col = String.fromCharCode(65 + ((n - 1) % 26)) + col;
  return `A1:${col}${r1 + 1}`;
}

export function useSuggestions(trigger: ReturnType<typeof triggerAt>): SuggestItem[] {
  const files = useApp((s) => s.files);
  const doc = useApp((s) => s.doc);
  const skills = useSkills(trigger !== null);
  return useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    const match = (s: string) => q === "" || s.toLowerCase().includes(q);
    const invocable = skills.filter((k) => k.enabled && k.available && k.userInvocable);
    if (trigger.kind === "/") {
      const commands: SuggestItem[] = [
        {
          key: "cmd:compact",
          icon: "history",
          label: "/compact",
          hint: S.cmdCompact,
          insert: "/compact",
        },
        {
          key: "cmd:resume",
          icon: "chevronRight",
          label: "/resume",
          hint: S.cmdResume,
          insert: "/resume",
        },
        { key: "cmd:model", icon: "cpu", label: "/model", hint: S.cmdModel, insert: "/model " },
      ];
      return [
        ...commands.filter((c) => match(c.label)),
        ...invocable
          .filter((k) => match(k.name))
          .map((k) => ({
            key: `skill:${k.name}`,
            icon: "book" as const,
            label: `/${k.name}`,
            hint: k.description,
            insert: `/${k.name} `,
          })),
      ].slice(0, 8);
    }
    const out: SuggestItem[] = [];
    const snap = doc?.snapshot as Snapshot | undefined;
    if (doc && snap?.sheets) {
      for (const id of snap.sheetOrder ?? Object.keys(snap.sheets)) {
        const sh = snap.sheets[id];
        const name = sh?.name ?? id;
        const range = sh ? usedRange(sh) : null;
        if (!range || !match(name)) continue;
        const full = `${name}!${range}`;
        out.push({
          key: `sheet:${id}`,
          icon: "sheet",
          label: name,
          hint: S.suggestSheet(full),
          insert: "",
          apply: () => pinRange(doc.docId, full),
        });
      }
    }
    for (const f of files) {
      if (f.kind === "dir" || !match(f.name)) continue;
      out.push({
        key: `file:${f.path}`,
        icon: "file",
        label: f.name,
        hint: S.suggestFile,
        insert: `@${f.path} `,
      });
    }
    for (const k of invocable) {
      if (!match(k.name)) continue;
      out.push({
        key: `skill:${k.name}`,
        icon: "book",
        label: k.name,
        hint: k.description,
        insert: "",
        prefix: `/${k.name} `,
      });
    }
    return out.slice(0, 8);
  }, [trigger, files, doc, skills]);
}

export function suggestOptionId(i: number): string {
  return `${COMPOSER_SUGGEST_ID}-${i}`;
}

export function SuggestList({
  items,
  active,
  onPick,
  onHover,
}: {
  items: SuggestItem[];
  active: number;
  onPick: (item: SuggestItem) => void;
  onHover?: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-popover">
      <CommandList id={COMPOSER_SUGGEST_ID} aria-label={S.suggestLabel} className="max-h-72">
        {items.map((it, i) => (
          <CommandItem
            key={it.key}
            id={suggestOptionId(i)}
            active={i === active}
            onPick={() => onPick(it)}
            onHover={() => onHover?.(i)}
          >
            <Icon name={it.icon} size="sm" className="text-muted-foreground" />
            <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-foreground">
              {it.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{it.hint}</span>
          </CommandItem>
        ))}
      </CommandList>
      <CommandFooter>
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {S.suggestKeyNav}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {S.suggestKeyPick}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>
          {S.suggestKeyClose}
        </span>
      </CommandFooter>
    </div>
  );
}
