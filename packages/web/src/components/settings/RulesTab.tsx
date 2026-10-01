// 设置 → 规则（12 §3）：全局规则与当前会话规则；单条 ≤ 2000 字，总量 ≤ 8000 字。

import { RULE_MAX_CHARS, type Rule } from "@excelmanus/protocol";
import { useId, useState } from "react";
import { apiClientOf, useApp } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Switch } from "../ui/controls.tsx";
import { Label } from "../ui/field.tsx";
import { Textarea } from "../ui/input.tsx";
import { SimpleSelect } from "../ui/select.tsx";
import {
  Empty,
  Feedback,
  ItemCard,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

function RuleItem({ rule, onChanged }: { rule: Rule; onChanged(): void }) {
  const api = apiClientOf();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.content);
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  const id = useId();
  return (
    <ItemCard>
      {editing ? (
        <Textarea
          rows={3}
          aria-label={ST.edit}
          maxLength={RULE_MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className={cn("text-sm whitespace-pre-wrap", !rule.enabled && "text-muted-foreground")}>
          {rule.content}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5">
          <Switch
            id={id}
            size="sm"
            checked={rule.enabled}
            onCheckedChange={(v) =>
              void act.run(async () => {
                await api.updateRule(rule.id, { enabled: v });
                onChanged();
              })
            }
          />
          <Label htmlFor={id}>{rule.enabled ? ST.enabled : ST.disabled}</Label>
        </span>
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {text.length} / {RULE_MAX_CHARS}
        </span>
        <span className="flex-1" />
        {editing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {ST.cancel}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void act
                  .run(async () => {
                    await api.updateRule(rule.id, { content: text });
                    onChanged();
                  })
                  .then((ok) => ok && setEditing(false))
              }
            >
              {ST.save}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {ST.edit}
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive-ghost"
          onClick={async () => {
            if (await confirmDelete(ST.confirmTitle.deleteRule))
              void act.run(async () => {
                await api.deleteRule(rule.id);
                onChanged();
              });
          }}
        >
          {ST.delete}
        </Button>
      </div>
      <Feedback msg={act.msg} />
    </ItemCard>
  );
}

export function RulesTab() {
  const api = apiClientOf();
  const sessionId = useApp((s) => s.sessionId);
  const rules = useLoad(() => api.listRules(sessionId ?? undefined), [sessionId]);
  const [draft, setDraft] = useState({ content: "", scope: "global" as "global" | "session" });
  const act = useAction();
  const items = rules.data?.items ?? [];
  const over = (rules.data?.totalChars ?? 0) > (rules.data?.maxTotalChars ?? Infinity);
  const group = (scope: "global" | "session", title: string) => (
    <Section title={title}>
      <div className="flex flex-col gap-2">
        {items.filter((r) => r.scope === scope).length === 0 && <Empty />}
        {items
          .filter((r) => r.scope === scope)
          .map((r) => (
            <RuleItem key={`${r.id}-${r.updatedAt}`} rule={r} onChanged={rules.reload} />
          ))}
      </div>
    </Section>
  );
  return (
    <>
      <div className="-mt-2 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{ST.ruleHint}</p>
        {rules.data && (
          <p className={cn("text-xs", over ? "text-destructive" : "text-muted-foreground")}>
            {ST.ruleTotal(rules.data.totalChars, rules.data.maxTotalChars)}
            {over ? ` · ${ST.ruleOver}` : ""}
          </p>
        )}
      </div>
      {group("global", ST.ruleGlobal)}
      {sessionId && group("session", ST.ruleSession)}
      <Section title={ST.add}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act
              .run(async () => {
                await api.createRule({
                  content: draft.content,
                  scope: draft.scope,
                  ...(draft.scope === "session" && sessionId ? { sessionId } : {}),
                });
                rules.reload();
              })
              .then((ok) => ok && setDraft({ ...draft, content: "" }));
          }}
        >
          <Textarea
            rows={3}
            required
            aria-label={ST.rulePlaceholder}
            maxLength={RULE_MAX_CHARS}
            placeholder={ST.rulePlaceholder}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <SimpleSelect
              className="w-40"
              ariaLabel={ST.ruleGlobal}
              value={draft.scope}
              onChange={(v) => setDraft({ ...draft, scope: v })}
              options={[
                { value: "global" as const, label: ST.ruleGlobal },
                ...(sessionId ? [{ value: "session" as const, label: ST.ruleSession }] : []),
              ]}
            />
            <Button type="submit" loading={act.busy}>
              {ST.add}
            </Button>
          </div>
          <Feedback msg={act.msg} />
        </form>
      </Section>
    </>
  );
}
