"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentEffectTargetResponse,
  AgentSettingsResponse,
  RuntimeQueryDescriptor,
  WebhookDelivery,
  WebhookEndpoint,
} from "@operloom/client";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createBrowserRuntimeClient,
  type BrowserRuntimeClient,
} from "@/lib/workbench/browser-runtime-client";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";

type Target = "simulation" | "external";
type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed";

/** Loads when `key` changes (a null `load` stays idle); `reload` re-runs the latest request. */
const useLoaded = <T,>(load: (() => Promise<T>) | null, key: string): Loaded<T> => {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: false,
  });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  const enabled = load !== null;
  useEffect(() => {
    const request = latest.current;
    if (!enabled || !request) return;
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    request().then(
      (data) => active && setState({ data, error: null, loading: false }),
      (error: unknown) =>
        active && setState({ data: null, error: messageOf(error), loading: false }),
    );
    return () => {
      active = false;
    };
  }, [enabled, key, nonce]);
  return { ...state, reload: () => setNonce((value) => value + 1) };
};

const inputClass =
  "border-border bg-background focus-visible:ring-ring h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-2";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Status({ loaded, empty }: { loaded: Loaded<unknown>; empty?: boolean }) {
  if (loaded.loading)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2Icon className="size-3 animate-spin" /> Loading
      </p>
    );
  if (loaded.error)
    return (
      <p role="alert" className="text-destructive text-xs">
        {loaded.error}
      </p>
    );
  return empty ? <p className="text-muted-foreground text-xs">Nothing yet.</p> : null;
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Reload({ loaded }: { loaded: Loaded<unknown> }) {
  return (
    <Button variant="ghost" size="sm" onClick={loaded.reload} aria-label="Reload">
      <RefreshCwIcon className="size-3.5" />
    </Button>
  );
}

type PropertySchema = {
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
};

function SettingField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: PropertySchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `setting-${name}`;
  let control: ReactNode;
  if (schema.enum)
    control = (
      <select
        id={id}
        className={inputClass}
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  else if (schema.type === "boolean")
    control = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  else if (schema.type === "number" || schema.type === "integer")
    control = (
      <input
        id={id}
        type="number"
        className={inputClass}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : "any"}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    );
  else
    control = (
      <textarea
        id={id}
        rows={(schema.maxLength ?? 0) > 200 ? 5 : 1}
        className="border-border bg-background focus-visible:ring-ring min-h-8 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
        maxLength={schema.maxLength}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <label htmlFor={id} className="grid gap-1 text-xs">
      <span className="font-medium">{name}</span>
      {control}
      {schema.description ? (
        <span className="text-muted-foreground">{schema.description}</span>
      ) : null}
    </label>
  );
}

function AgentTab({ client, agentId }: { client: BrowserRuntimeClient; agentId: string }) {
  const target = useLoaded<AgentEffectTargetResponse>(
    () => client.admin.effectTarget(agentId),
    `target:${agentId}`,
  );
  const settings = useLoaded<AgentSettingsResponse>(
    () => client.admin.settings(agentId),
    `settings:${agentId}`,
  );
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings.data?.values ?? {}), [settings.data]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      setNotice(success);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const switchTarget = (next: Target) =>
    target.data &&
    run(async () => {
      await client.admin.setEffectTarget(agentId, {
        effectTarget: next,
        expectedRevision: target.data!.runtimeRevision,
      });
      target.reload();
    }, `Effect target is now ${next}.`);
  const saveSettings = () =>
    settings.data &&
    run(async () => {
      const values = Object.fromEntries(
        settings
          .data!.editable.filter((key) => draft[key] !== undefined)
          .map((key) => [key, draft[key]]),
      );
      await client.admin.updateSettings(agentId, {
        values,
        expectedVersion: settings.data!.version,
      });
      settings.reload();
    }, "Settings saved.");
  const properties =
    (settings.data?.schema as { properties?: Record<string, PropertySchema> } | undefined)
      ?.properties ?? {};

  return (
    <div className="space-y-5">
      <Section title="Effect target" action={<Reload loaded={target} />}>
        <Status loaded={target} />
        {target.data ? (
          <div className="flex items-center gap-2">
            {(["simulation", "external"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={target.data!.effectTarget === option ? "default" : "outline"}
                disabled={busy || target.data!.effectTarget === option}
                onClick={() => void switchTarget(option)}
              >
                {option}
              </Button>
            ))}
            <span className="text-muted-foreground text-xs">
              Revision {target.data.runtimeRevision}
            </span>
          </div>
        ) : null}
      </Section>
      <Section title="Settings" action={<Reload loaded={settings} />}>
        <Status loaded={settings} empty={settings.data?.editable.length === 0} />
        {settings.data?.editable.length ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSettings();
            }}
          >
            {settings.data.editable.map((key) => (
              <SettingField
                key={key}
                name={key}
                schema={properties[key] ?? {}}
                value={draft[key]}
                onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
              />
            ))}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                Save settings
              </Button>
              <span className="text-muted-foreground text-xs">Version {settings.data.version}</span>
            </div>
          </form>
        ) : null}
      </Section>
      {notice ? (
        <p role="status" className="text-muted-foreground text-xs">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function DecisionsTab({ client, target }: { client: BrowserRuntimeClient; target: Target }) {
  const [type, setType] = useState<"decision" | "effect">("decision");
  const entries = useLoaded(
    () => client.state.entries({ target, type, limit: 50 }),
    `entries:${target}:${type}`,
  );
  return (
    <Section
      title={`Entries (${target})`}
      action={
        <div className="flex items-center gap-1">
          <select
            aria-label="Entry type"
            className={inputClass}
            value={type}
            onChange={(event) => setType(event.target.value as "decision" | "effect")}
          >
            <option value="decision">Decisions</option>
            <option value="effect">Effects</option>
          </select>
          <Reload loaded={entries} />
        </div>
      }
    >
      <Status loaded={entries} empty={entries.data?.entries.length === 0} />
      <ul className="space-y-2">
        {entries.data?.entries.map((entry) => (
          <li key={entry.id} className="border-border rounded-md border p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="font-medium">
                {String(entry.data.outcome ?? entry.data.workflow ?? entry.key)}
              </span>
              <time className="text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </div>
            {typeof entry.data.explanation === "string" ? (
              <p className="text-muted-foreground mt-1 text-xs">{entry.data.explanation}</p>
            ) : null}
            <details className="mt-1">
              <summary className="text-muted-foreground cursor-pointer text-[11px]">Data</summary>
              <Json value={entry.data} />
            </details>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function StateTab({ client, target }: { client: BrowserRuntimeClient; target: Target }) {
  const [namespace, setNamespace] = useState("");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState<{ namespace: string; kind: string } | null>(null);
  const records = useLoaded(
    query ? () => client.state.records({ target, ...query, limit: 50 }) : null,
    `records:${target}:${query?.namespace}:${query?.kind}`,
  );
  return (
    <Section title={`Records (${target})`}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (namespace && kind) setQuery({ namespace, kind });
        }}
      >
        <input
          aria-label="Namespace"
          placeholder="namespace"
          className={inputClass}
          value={namespace}
          onChange={(event) => setNamespace(event.target.value.trim())}
        />
        <input
          aria-label="Kind"
          placeholder="kind"
          className={inputClass}
          value={kind}
          onChange={(event) => setKind(event.target.value.trim())}
        />
        <Button type="submit" size="sm" disabled={!namespace || !kind}>
          Load
        </Button>
      </form>
      {query ? <Status loaded={records} empty={records.data?.records.length === 0} /> : null}
      <ul className="space-y-2">
        {records.data?.records.map((record) => (
          <li key={record.id} className="border-border rounded-md border p-2">
            <div className="flex justify-between gap-2 text-xs">
              <span className="font-medium">{record.key}</span>
              <span className="text-muted-foreground">v{record.version}</span>
            </div>
            <Json value={record.data} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function QueriesTab({ client, agentId }: { client: BrowserRuntimeClient; agentId: string }) {
  const queries = useLoaded(() => client.queries.list(), `queries:${agentId}`);
  const [selected, setSelected] = useState<RuntimeQueryDescriptor | null>(null);
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState<{ output?: unknown; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!selected) return;
    setBusy(true);
    setResult(null);
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      setResult({ output: (await client.queries.run(selected.id, parsed)).output });
    } catch (error) {
      setResult({ error: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Package queries" action={<Reload loaded={queries} />}>
      <Status loaded={queries} empty={queries.data?.queries.length === 0} />
      <div className="flex flex-wrap gap-1">
        {queries.data?.queries.map((query) => (
          <Button
            key={query.id}
            size="sm"
            variant={selected?.id === query.id ? "default" : "outline"}
            onClick={() => {
              setSelected(query);
              setResult(null);
            }}
          >
            {query.id}
          </Button>
        ))}
      </div>
      {selected ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{selected.description}</p>
          <textarea
            aria-label="Query input"
            rows={3}
            className="border-border bg-background w-full rounded-md border p-2 font-mono text-xs"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            Run query
          </Button>
          {result?.error ? (
            <p role="alert" className="text-destructive text-xs">
              {result.error}
            </p>
          ) : null}
          {result?.output !== undefined ? <Json value={result.output} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

function ActionsTab({ client, agentId }: { client: BrowserRuntimeClient; agentId: string }) {
  const actions = useLoaded(() => client.admin.actions({ limit: 25 }), `actions:${agentId}`);
  const [notice, setNotice] = useState<string | null>(null);
  const reconcile = async (proposalId: string) => {
    setNotice(null);
    try {
      const result = await client.admin.reconcileAction(proposalId);
      setNotice(`Reconciled: ${String((result as { status?: string }).status ?? "done")}`);
      actions.reload();
    } catch (error) {
      setNotice(messageOf(error));
    }
  };
  const requestExecution = async (proposalId: string) => {
    setNotice(null);
    try {
      await client.admin.requestAction(proposalId);
      setNotice("Approval requested. Approve it in Admin → Controls.");
      actions.reload();
    } catch (error) {
      setNotice(messageOf(error));
    }
  };
  return (
    <Section title="Action proposals" action={<Reload loaded={actions} />}>
      <Status loaded={actions} empty={actions.data?.proposals.length === 0} />
      {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
      <ul className="space-y-2">
        {actions.data?.proposals.map((proposal) => (
          <li key={proposal.id} className="border-border rounded-md border p-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{proposal.summary}</span>
              <span className="text-muted-foreground">{proposal.status}</span>
            </div>
            <p className="text-muted-foreground mt-1">
              {proposal.toolId} · {proposal.actionType}
              {proposal.providerOperation
                ? ` · operation ${proposal.providerOperation.status}`
                : ""}
            </p>
            {proposal.status === "proposed" ? (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void requestExecution(proposal.id)}
              >
                Request execution
              </Button>
            ) : null}
            {proposal.providerOperation?.status === "outcome_unknown" ? (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void reconcile(proposal.id)}
              >
                Reconcile
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function WebhookDeliveries({
  client,
  endpoint,
}: {
  client: BrowserRuntimeClient;
  endpoint: WebhookEndpoint;
}) {
  const deliveries = useLoaded(
    () => client.webhooks.deliveries(endpoint.id, { limit: 20 }),
    `deliveries:${endpoint.id}`,
  );
  const retry = async (delivery: WebhookDelivery) => {
    await client.webhooks.retry(endpoint.id, delivery.id).catch(() => undefined);
    deliveries.reload();
  };
  return (
    <div className="mt-2 space-y-1">
      <Status loaded={deliveries} empty={deliveries.data?.deliveries.length === 0} />
      {deliveries.data?.deliveries.map((delivery) => (
        <div key={delivery.id} className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {delivery.eventType} · {delivery.status} · {delivery.attempts} attempt
            {delivery.attempts === 1 ? "" : "s"}
            {delivery.lastErrorCode ? ` · ${delivery.lastErrorCode}` : ""}
          </span>
          {delivery.status === "failed" && endpoint.status === "active" ? (
            <Button size="sm" variant="outline" onClick={() => void retry(delivery)}>
              Retry
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function WebhooksTab({ client, agentId }: { client: BrowserRuntimeClient; agentId: string }) {
  const endpoints = useLoaded(() => client.webhooks.list(), `webhooks:${agentId}`);
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState("*");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    setSecret(null);
    try {
      const created = await client.webhooks.create({
        url,
        eventTypes: eventTypes
          .split(",")
          .map((type) => type.trim())
          .filter(Boolean),
      });
      setSecret(created.secret);
      setUrl("");
      endpoints.reload();
    } catch (createError) {
      setError(messageOf(createError));
    }
  };
  const disable = async (id: string) => {
    await client.webhooks
      .disable(id)
      .catch((disableError: unknown) => setError(messageOf(disableError)));
    endpoints.reload();
  };
  return (
    <div className="space-y-5">
      <Section title="New webhook">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            aria-label="Webhook URL"
            placeholder="https://hooks.example.com/operloom"
            className={inputClass}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <input
            aria-label="Event types"
            placeholder="run.*, agent.settings.changed"
            className={inputClass}
            value={eventTypes}
            onChange={(event) => setEventTypes(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!url}>
            Add webhook
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        {secret ? (
          <p role="status" className="text-xs">
            Signing secret (shown once): <code className="font-mono break-all">{secret}</code>
          </p>
        ) : null}
      </Section>
      <Section title="Webhooks" action={<Reload loaded={endpoints} />}>
        <Status loaded={endpoints} empty={endpoints.data?.endpoints.length === 0} />
        <ul className="space-y-2">
          {endpoints.data?.endpoints.map((endpoint) => (
            <li key={endpoint.id} className="border-border rounded-md border p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium break-all">{endpoint.url}</span>
                <span className="text-muted-foreground">{endpoint.status}</span>
              </div>
              <p className="text-muted-foreground">{endpoint.eventTypes.join(", ")}</p>
              <div className="mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpanded(expanded === endpoint.id ? null : endpoint.id)}
                >
                  Deliveries
                </Button>
                {endpoint.status === "active" ? (
                  <Button size="sm" variant="ghost" onClick={() => void disable(endpoint.id)}>
                    Disable
                  </Button>
                ) : null}
              </div>
              {expanded === endpoint.id ? (
                <WebhookDeliveries client={client} endpoint={endpoint} />
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function WorkbenchOperationsPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { session } = useWorkbenchAgentConnection();
  const agentId = session?.activeAgent?.id ?? null;
  const client = useMemo(() => (open ? createBrowserRuntimeClient() : null), [open]);
  const [target, setTarget] = useState<Target>("simulation");
  const loadTarget = useCallback(async () => {
    if (!client || !agentId) return;
    const current = await client.admin.effectTarget(agentId).catch(() => null);
    if (current) setTarget(current.effectTarget);
  }, [agentId, client]);
  useEffect(() => {
    void loadTarget();
  }, [loadTarget]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[min(84vh,44rem)] w-[min(96vw,48rem)] max-w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,48rem)]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="border-border border-b px-4 py-3 text-left">
          <DialogTitle>Operations</DialogTitle>
          <DialogDescription>
            {session?.activeAgent?.name ?? "Active agent"} · {target}
          </DialogDescription>
        </DialogHeader>
        {client && agentId ? (
          <Tabs
            defaultValue="agent"
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]"
            onValueChange={(value) => value === "agent" || void loadTarget()}
          >
            <div className="border-border overflow-x-auto border-b px-3 py-2">
              <TabsList aria-label="Operations views">
                <TabsTrigger value="agent">Agent</TabsTrigger>
                <TabsTrigger value="decisions">Decisions</TabsTrigger>
                <TabsTrigger value="state">State</TabsTrigger>
                <TabsTrigger value="queries">Queries</TabsTrigger>
                <TabsTrigger value="actions">Actions</TabsTrigger>
                <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 overflow-y-auto p-4">
              <TabsContent value="agent">
                <AgentTab client={client} agentId={agentId} />
              </TabsContent>
              <TabsContent value="decisions">
                <DecisionsTab client={client} target={target} />
              </TabsContent>
              <TabsContent value="state">
                <StateTab client={client} target={target} />
              </TabsContent>
              <TabsContent value="queries">
                <QueriesTab client={client} agentId={agentId} />
              </TabsContent>
              <TabsContent value="actions">
                <ActionsTab client={client} agentId={agentId} />
              </TabsContent>
              <TabsContent value="webhooks">
                <WebhooksTab client={client} agentId={agentId} />
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          <p className="text-muted-foreground p-4 text-sm">Sign in to inspect the active agent.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
