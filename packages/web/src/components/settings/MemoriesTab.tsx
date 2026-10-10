// 设置 → 记忆（12 §2）：搜索、新增、编辑、删除。

import type { Memory } from "@excelmanus/protocol";
import { useState } from "react";
import { apiClientOf, useApp } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/controls.tsx";
import { Badge } from "../ui/display.tsx";
import { Field as UiField } from "../ui/field.tsx";
import { useFormGuard, useUnsavedChanges } from "../ui/form-guard.tsx";
import { SearchInput, Textarea } from "../ui/input.tsx";
import { Disclosure } from "../ui/overlay.tsx";
import { SimpleSelect } from "../ui/select.tsx";
import {
  Empty,
  Feedback,
  ItemCard,
  LoadStatus,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

const CATEGORIES = ["preference", "domain", "file", "lesson"] as const;
type Category = (typeof CATEGORIES)[number];

function CategorySelect({ value, onChange }: { value: Category; onChange(v: Category): void }) {
  return (
    <SimpleSelect
      className="w-36"
      ariaLabel={ST.memoryCategoryLabel}
      value={value}
      onChange={onChange}
      options={CATEGORIES.map((c) => ({ value: c, label: ST.memoryCategory[c] ?? c }))}
    />
  );
}

function MemoryItem({ m, onChanged }: { m: Memory; onChanged(): void }) {
  const api = apiClientOf();
  const [edit, setEdit] = useState<{ content: string; category: Category } | null>(null);
  useUnsavedChanges(!!edit && (edit.content !== m.content || edit.category !== m.category));
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  return (
    <ItemCard>
      {edit ? (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={2}
            aria-label={ST.edit}
            value={edit.content}
            onChange={(e) => setEdit({ ...edit, content: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <CategorySelect
              value={edit.category}
              onChange={(category) => setEdit({ ...edit, category })}
            />
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              {ST.cancel}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void act
                  .run(async () => {
                    await api.updateMemory(m.id, edit);
                    onChanged();
                  })
                  .then((ok) => ok && setEdit(null))
              }
            >
              {ST.save}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="read">{ST.memoryCategory[m.category] ?? m.category}</Badge>
            {m.workspaceId && <Badge tone="neutral">{ST.memoryScopeWorkspace}</Badge>}
          </div>
          <p className="text-sm leading-6 whitespace-pre-wrap">{m.content}</p>
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground">
              {new Date(m.updatedAt).toLocaleString()}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEdit({ content: m.content, category: m.category as Category })}
            >
              {ST.edit}
            </Button>
            <Button
              size="sm"
              variant="destructive-ghost"
              onClick={async () => {
                if (await confirmDelete(ST.confirmTitle.deleteMemory))
                  void act.run(async () => {
                    await api.deleteMemory(m.id);
                    onChanged();
                  });
              }}
            >
              {ST.delete}
            </Button>
          </div>
        </>
      )}
      <Feedback msg={act.msg} />
    </ItemCard>
  );
}

export function MemoriesTab() {
  const guard = useFormGuard();
  const api = apiClientOf();
  const workspaceId = useApp((s) => s.workspaceId);
  const [q, setQ] = useState("");
  const list = useLoad(() => api.listMemories(q.trim() || undefined), [q]);
  const [draft, setDraft] = useState({
    content: "",
    category: "preference" as Category,
    workspace: false,
  });
  const act = useAction();
  return (
    <>
      <p className="settings-context-note border-l-2 border-border-strong pl-4 text-xs leading-5 text-muted-foreground">
        {ST.memoryHint}
      </p>
      <Section>
        <SearchInput
          placeholder={ST.memorySearch}
          className="max-w-[420px]"
          aria-label={ST.memorySearch}
          value={q}
          onChange={(e) => {
            const next = e.target.value;
            void guard.confirmLeave().then((ok) => {
              if (ok) setQ(next);
            });
          }}
        />
        <LoadStatus data={list.data} error={list.error} />
        <div className="settings-list flex flex-col gap-3">
          {list.data?.items.length === 0 && <Empty />}
          {list.data?.items.map((m) => (
            <MemoryItem key={`${m.id}-${m.updatedAt}`} m={m} onChanged={list.reload} />
          ))}
        </div>
      </Section>
      <Disclosure
        className="settings-create border-t border-border/70 pt-6"
        summary={ST.addMemory}
        variant="section"
        icon={<Icon name="plus" size="sm" />}
        contentClassName="pt-5"
      >
        <form
          className="settings-form flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act
              .run(async () => {
                await api.createMemory({
                  content: draft.content,
                  category: draft.category,
                  workspaceId: draft.workspace ? workspaceId : null,
                });
                list.reload();
              })
              .then((ok) => ok && setDraft({ ...draft, content: "" }));
          }}
        >
          <Textarea
            rows={2}
            required
            aria-label={ST.memoryPlaceholder}
            placeholder={ST.memoryPlaceholder}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-3">
            <CategorySelect
              value={draft.category}
              onChange={(category) => setDraft({ ...draft, category })}
            />
            <UiField orientation="horizontal" label={ST.memoryScopeWorkspace}>
              <Checkbox
                checked={draft.workspace}
                onCheckedChange={(v) => setDraft({ ...draft, workspace: v === true })}
              />
            </UiField>
            <span className="flex-1" />
            <Button type="submit" loading={act.busy}>
              {ST.addMemory}
            </Button>
          </div>
          <Feedback msg={act.msg} />
        </form>
      </Disclosure>
    </>
  );
}
