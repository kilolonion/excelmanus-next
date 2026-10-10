// 设置 → MCP 服务器（12 §4）：增删改、启用、测试、状态（经 app 主题实时刷新）、工具级自动批准。

import type { McpServer } from "@excelmanus/protocol";
import { useEffect, useId, useState } from "react";
import { apiClientOf, onAppEvent } from "../../store.ts";
import { ST } from "../../strings.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/controls.tsx";
import { Alert, Badge, Separator, statusTone } from "../ui/display.tsx";
import { Label } from "../ui/field.tsx";
import { useFormGuard } from "../ui/form-guard.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { Disclosure } from "../ui/overlay.tsx";
import { ResourceBrowser } from "../ui/resource-browser.tsx";
import { SimpleSelect } from "../ui/select.tsx";
import {
  Feedback,
  Field,
  formatPairs,
  ItemCard,
  LoadStatus,
  parsePairs,
  Section,
  useAction,
  useConfirmDelete,
  useLoad,
} from "./common.tsx";

interface Draft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  timeout: string;
}

const emptyDraft: Draft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  timeout: "",
};

function toDraft(s: McpServer): Draft {
  return {
    name: s.name,
    transport: s.transport,
    command: s.config.command ?? "",
    args: (s.config.args ?? []).join("\n"),
    env: formatPairs(s.config.env, "="),
    url: s.config.url ?? "",
    headers: formatPairs(s.config.headers, ":"),
    timeout: s.config.callTimeoutSeconds ? String(s.config.callTimeoutSeconds) : "",
  };
}

function toConfig(d: Draft) {
  const timeout = d.timeout.trim() === "" ? undefined : Number(d.timeout);
  return d.transport === "stdio"
    ? {
        command: d.command.trim(),
        args: d.args
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
        ...(d.env.trim() ? { env: parsePairs(d.env, "=") } : {}),
        ...(timeout ? { callTimeoutSeconds: timeout } : {}),
      }
    : {
        url: d.url.trim(),
        ...(d.headers.trim() ? { headers: parsePairs(d.headers, ":") } : {}),
        ...(timeout ? { callTimeoutSeconds: timeout } : {}),
      };
}

function ServerForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial: Draft;
  onSubmit(d: Draft): Promise<unknown>;
  submitLabel: string;
}) {
  const [d, setD] = useState(initial);
  const act = useAction();
  return (
    <form
      className="settings-form flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(() => onSubmit(d))
          .then((ok) => ok && initial === emptyDraft && setD(emptyDraft));
      }}
    >
      <div className="grid grid-cols-1 gap-4 @min-[500px]:grid-cols-2">
        <Field label={ST.mcpName}>
          <Input
            mono
            value={d.name}
            required
            pattern="[A-Za-z0-9_\-]{1,32}"
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </Field>
        <Field label={ST.mcpTransport}>
          <SimpleSelect
            value={d.transport}
            onChange={(v) => setD({ ...d, transport: v })}
            options={(["stdio", "http"] as const).map((t) => ({
              value: t,
              label: ST.mcpTransportLabel[t] ?? t,
            }))}
          />
        </Field>
      </div>
      {d.transport === "stdio" ? (
        <>
          <Field label={ST.mcpCommand}>
            <Input
              mono
              value={d.command}
              required
              placeholder="npx"
              onChange={(e) => setD({ ...d, command: e.target.value })}
            />
          </Field>
          <Field label={ST.mcpArgs}>
            <Textarea
              mono
              rows={3}
              value={d.args}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              onChange={(e) => setD({ ...d, args: e.target.value })}
            />
          </Field>
          <Field label={ST.mcpEnv}>
            <Textarea
              mono
              rows={2}
              value={d.env}
              onChange={(e) => setD({ ...d, env: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={ST.mcpUrl}>
            <Input
              mono
              value={d.url}
              required
              placeholder="https://example.com/mcp"
              onChange={(e) => setD({ ...d, url: e.target.value })}
            />
          </Field>
          <Field label={ST.mcpHeaders}>
            <Textarea
              mono
              rows={2}
              value={d.headers}
              onChange={(e) => setD({ ...d, headers: e.target.value })}
            />
          </Field>
        </>
      )}
      <Field label={ST.mcpTimeout} className="max-w-48">
        <Input
          mono
          inputMode="numeric"
          value={d.timeout}
          placeholder="60"
          onChange={(e) => setD({ ...d, timeout: e.target.value })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={act.busy}>
          {submitLabel}
        </Button>
        <Feedback msg={act.msg} />
      </div>
    </form>
  );
}

function ToolAutoApprove({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }) {
  const id = useId();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id}>{ST.mcpAutoApprove}</Label>
    </span>
  );
}

function ServerItem({ s, onChanged }: { s: McpServer; onChanged(): void }) {
  const guard = useFormGuard();
  const api = apiClientOf();
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const confirmDelete = useConfirmDelete();
  const enabledId = useId();
  return (
    <ItemCard className="settings-mcp-server gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground-secondary">
            <Icon name="plug" size="sm" />
          </span>
          <strong className="font-mono text-sm font-semibold">{s.name}</strong>
          <span className="font-mono text-2xs text-muted-foreground">{s.transport}</span>
          <Badge tone={statusTone(s.status)}>{ST.mcpStatus[s.status] ?? s.status}</Badge>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <Switch
            id={enabledId}
            size="sm"
            checked={s.enabled}
            onCheckedChange={(v) =>
              void act.run(async () => {
                await api.updateMcpServer(s.id, { enabled: v });
                onChanged();
              })
            }
          />
          <Label htmlFor={enabledId}>{s.enabled ? ST.enabled : ST.disabled}</Label>
        </span>
      </div>
      {s.error && (
        <Alert tone="err" layout="inline">
          {s.error}
        </Alert>
      )}
      {s.tools.length > 0 && (
        <Disclosure summary={ST.mcpTools(s.tools.length)} contentClassName="pt-4">
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {s.tools.map((t) => (
              <li key={t.name} className="flex flex-wrap items-start gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-xs">{t.qualifiedName}</code>
                    {t.readOnly && <Badge tone="ok">{ST.mcpReadOnly}</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </div>
                {!t.readOnly && (
                  <ToolAutoApprove
                    checked={t.autoApprove}
                    onChange={(v) => {
                      const auto = s.tools
                        .filter((x) => (x.name === t.name ? v : x.autoApprove))
                        .map((x) => x.name);
                      void act.run(async () => {
                        await api.updateMcpServer(s.id, { autoApprove: auto });
                        onChanged();
                      });
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <div className="-mx-1.5 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              const r = await api.testMcpServer(s.id);
              if (!r.ok) throw new Error(r.error ?? ST.connectFailed);
              return r;
            }, ST.connectOk)
          }
        >
          {ST.mcpTest}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (!editing || (await guard.confirmLeave())) setEditing(!editing);
          }}
        >
          {editing ? ST.cancel : ST.edit}
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="destructive-ghost"
          onClick={async () => {
            if (await confirmDelete(ST.confirmTitle.deleteMcp(s.name)))
              void act.run(async () => {
                await api.deleteMcpServer(s.id);
                onChanged();
              });
          }}
        >
          {ST.delete}
        </Button>
      </div>
      <Feedback msg={act.msg} />
      {editing && (
        <>
          <Separator />
          <ServerForm
            initial={toDraft(s)}
            submitLabel={ST.save}
            onSubmit={async (d) => {
              await api.updateMcpServer(s.id, {
                name: d.name,
                transport: d.transport,
                config: toConfig(d),
              });
              setEditing(false);
              onChanged();
            }}
          />
        </>
      )}
    </ItemCard>
  );
}

export function McpTab() {
  const api = apiClientOf();
  const list = useLoad(() => api.listMcpServers(), []);
  const act = useAction();
  // 12 §4.2：连接状态经 app 主题推送，设置页实时刷新
  useEffect(() => onAppEvent((e) => e.type === "mcp.status" && list.reload()), [list.reload]);
  return (
    <>
      <Section
        hint={ST.mcpHint}
        actions={
          <Button
            size="sm"
            variant="ghost"
            loading={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api.reloadMcpServers();
                list.reload();
              })
            }
          >
            <Icon name="restore" size="xs" />
            {ST.mcpReload}
          </Button>
        }
      >
        <LoadStatus data={list.data} error={list.error} />
        <Feedback msg={act.msg} />
        {list.data && (
          <ResourceBrowser
            items={list.data.items}
            id={(server) => server.id}
            title={(server) => server.name}
            subtitle={(server) => server.transport}
            icon={() => <Icon name="plug" size="sm" />}
            label={ST.tabs.mcp}
            emptyText={ST.empty}
            detail={(server) => <ServerItem s={server} onChanged={list.reload} />}
          />
        )}
      </Section>
      <Disclosure
        className="settings-create border-t border-border/70 pt-6"
        summary={ST.addMcpServer}
        variant="section"
        icon={<Icon name="plus" size="sm" />}
        contentClassName="pt-5"
      >
        <ServerForm
          initial={emptyDraft}
          submitLabel={ST.addMcpServer}
          onSubmit={async (d) => {
            await api.createMcpServer({
              name: d.name,
              transport: d.transport,
              config: toConfig(d),
            });
            list.reload();
          }}
        />
      </Disclosure>
    </>
  );
}
