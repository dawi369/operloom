import { handleRuntimeDeadlineRequest, recoverRuntimeDeadlines } from "./runtime-watchdog";
import { toAgentSummary } from "./agent-records";
import { upsertActiveAgentPreference } from "./authz";
import { selectAgent } from "./authz-store";
import {
  createChatSession,
  getLatestChatSession,
  getOwnedChatThread,
  touchChatSession,
} from "./chat-boundary-store";
import { switchSessionAgent } from "./session-agent-handoff";
import { handleSessionAgentRequest } from "./session-agent-router";
import {
  createSessionEventStream,
  pruneSessionEvents,
  resolveSessionReplay,
} from "./session-agent-stream";
import type { WorkbenchSessionEvent, WorkbenchSessionEventType } from "./session-event-types";
import {
  createId,
  type AgentRow,
  type ChatThreadRow,
  type DurableObjectState,
  type Env,
} from "./types";
import {
  buildSnapshot,
  createThreadContext,
  listWorkspaceThreads,
  maxMaterializeTurnMessageLength,
  mergeActiveThread,
  normalizeMaterializeMessage,
  responseFromSnapshot,
  sessionContext,
  sseEncoder,
  stagedThreadTtlMs,
  toActiveThreadSummary,
  toThreadSummary,
  workspaceSummary,
} from "./session-agent-model";
import type { CoordinatorRequest, SessionSnapshot } from "./session-agent-model";
import {
  abortThreadChatResponse,
  appendThreadLifecycleEvent,
  clearActiveThread,
  draftExpiryFromThread,
  encodeSse,
  findFallbackActiveThread,
  findReusableDraftThread,
  materializeDraftThread,
  persistThreadMutation,
  safeSnapshotData,
  safeThreadData,
  submitProgrammaticTurn,
  titleFromUpdate,
  transitionForStatus,
} from "./session-agent-transitions";

type ClientTurnReceipt = {
  clientTurnId: string;
  threadId: string;
  sessionId: string;
  agentId: string;
  message: string;
  messageId: string;
  status: "dispatching" | "accepted";
  lifecyclePublished: boolean;
  createdAt: string;
};

type MaterializeTurnResult =
  | Awaited<ReturnType<typeof responseFromSnapshot>>
  | { ok: false; error: string; status: number };

export class WorkbenchSessionAgent {
  private snapshot: SessionSnapshot | null = null;
  private revision = 0;
  private clients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  private events: WorkbenchSessionEvent[] = [];
  private clientTurns: ClientTurnReceipt[] = [];
  private materializations = new Map<string, Promise<MaterializeTurnResult>>();
  private readonly initialized: Promise<void>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.initialized = state.blockConcurrencyWhile(async () => {
      const events = await state.storage.get<WorkbenchSessionEvent[]>("session-event-replay");
      this.events = this.pruneEvents(Array.isArray(events) ? events : []);
      const clientTurns = await state.storage.get<ClientTurnReceipt[]>("client-turn-receipts");
      this.clientTurns = this.pruneClientTurns(Array.isArray(clientTurns) ? clientTurns : []);
      this.revision = this.events.reduce(
        (maximum, event) => Math.max(maximum, event.revision ?? 0),
        0,
      );
    });
  }

  private pruneClientTurns(receipts: ClientTurnReceipt[]) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return receipts.filter((receipt) => Date.parse(receipt.createdAt) >= cutoff).slice(-4_096);
  }

  private async putClientTurn(receipt: ClientTurnReceipt) {
    this.clientTurns = this.pruneClientTurns([
      ...this.clientTurns.filter((candidate) => candidate.clientTurnId !== receipt.clientTurnId),
      receipt,
    ]);
    await this.state.storage.put("client-turn-receipts", this.clientTurns);
  }

  private pruneEvents(events: WorkbenchSessionEvent[]) {
    return pruneSessionEvents(events);
  }

  private recordEvent(event: WorkbenchSessionEvent) {
    this.events = this.pruneEvents([
      ...this.events.filter((candidate) => candidate.id !== event.id),
      event,
    ]);
    this.state.waitUntil(this.state.storage.put("session-event-replay", this.events));
  }

  private nextRevision = () => (this.revision += 1);

  private createEvent(
    type: WorkbenchSessionEventType,
    data: Record<string, unknown>,
    input?: { id?: string; createdAt?: string; revision?: number },
  ): WorkbenchSessionEvent {
    return {
      id: input?.id ?? createId("cf-session-event"),
      type,
      revision: input?.revision ?? this.snapshot?.revision,
      createdAt: input?.createdAt ?? new Date().toISOString(),
      data,
    };
  }

  private sendEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: WorkbenchSessionEvent,
  ) {
    controller.enqueue(sseEncoder.encode(encodeSse(event)));
  }

  private broadcastEvent(event: WorkbenchSessionEvent) {
    this.recordEvent(event);
    for (const [clientId, controller] of this.clients) {
      try {
        this.sendEvent(controller, event);
      } catch {
        this.clients.delete(clientId);
      }
    }
  }

  private async ensureSnapshot(input: CoordinatorRequest) {
    await this.initialized;
    if (!this.snapshot) {
      this.snapshot = await buildSnapshot(this.env, input.identity, {
        revision: this.nextRevision(),
      });
    }
    return this.snapshot;
  }

  private async activeIdentity(input: CoordinatorRequest) {
    const latestSession = await getLatestChatSession(this.env, input.identity.scope);
    const agentId =
      this.snapshot?.activeAgent?.id ?? latestSession?.agent_id ?? input.identity.agentId;
    return {
      identity: { ...input.identity, agentId },
      latestSession,
    };
  }

  async getSession(input: CoordinatorRequest) {
    if (!this.snapshot || input.refresh === "threads") {
      const active = await this.activeIdentity(input);
      this.snapshot = await buildSnapshot(this.env, active.identity, {
        revision: this.nextRevision(),
      });
      if (input.refresh === "threads") {
        this.broadcastEvent(
          this.createEvent("session.threads.refreshed", safeSnapshotData(this.snapshot)),
        );
      }
    }
    return responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: false,
      transition: { type: input.refresh === "threads" ? "initial" : "token_refresh" },
    });
  }

  async listThreads(input: CoordinatorRequest) {
    const latestSession = await getLatestChatSession(this.env, input.identity.scope);
    return {
      ok: true,
      threads: await listWorkspaceThreads(
        this.env,
        input.identity,
        latestSession?.active_thread_id ?? undefined,
        input.status === "archived" ? "archived" : "active",
      ),
    };
  }

  async createThread(input: CoordinatorRequest) {
    const startedAt = new Date().toISOString();
    const active = await this.activeIdentity(input);
    const sessionId =
      this.snapshot?.context?.sessionId ??
      active.latestSession?.session_id ??
      (await createChatSession(this.env, active.identity, { source: "cloudflare-agent-chat" }));
    const created = await createThreadContext(this.env, active.identity, sessionId, input.title);
    const activeIdentity = { ...active.identity, agentId: created.activeAgent.id };
    const activeThread = toActiveThreadSummary(
      this.env,
      created.thread,
      created.activeAgent,
      created.thread.thread_id,
    );
    const context = await sessionContext(activeIdentity, {
      thread: created.thread,
      agent: created.activeAgent,
      accountId: input.identity.accountId,
      accountSource: input.identity.accountSource,
    });
    this.snapshot = {
      revision: this.nextRevision(),
      context,
      workspace:
        this.snapshot?.workspace ??
        (await workspaceSummary(this.env, input.identity.scope.workspaceId)),
      activeAgent: toAgentSummary(this.env, created.activeAgent, created.activeAgent.id),
      activeThread,
      threads: mergeActiveThread(this.snapshot?.threads ?? [], activeThread),
    };
    await appendThreadLifecycleEvent(this.env, activeIdentity, {
      transition: "create",
      threadId: activeThread.threadId,
      activeThreadId: activeThread.threadId,
      nextStatus: activeThread.status,
    });
    this.broadcastEvent(
      this.createEvent("session.thread.created", {
        ...safeSnapshotData(this.snapshot),
        transition: { type: "create", startedAt },
      }),
    );
    this.broadcastEvent(
      this.createEvent("admin.summary.invalidated", {
        reason: "thread-created",
        threadId: activeThread.threadId,
      }),
    );
    return responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      threadsRefreshRecommended: true,
      transition: { type: "create", startedAt },
    });
  }

  async stageThread(input: CoordinatorRequest) {
    const active = await this.activeIdentity(input);
    const latestSession = active.latestSession;
    const sessionId =
      this.snapshot?.context?.sessionId ??
      latestSession?.session_id ??
      (await createChatSession(this.env, active.identity, { source: "cloudflare-agent-chat" }));
    const reusable = await findReusableDraftThread(
      this.env,
      active.identity,
      sessionId,
      this.snapshot?.context?.threadId,
      latestSession?.active_thread_id,
    );
    const draftExpiresAt = reusable
      ? draftExpiryFromThread(reusable)
      : new Date(Date.now() + stagedThreadTtlMs).toISOString();
    const created = reusable
      ? {
          activeAgent: await selectAgent(
            this.env,
            reusable.agent_id,
            input.identity.scope.workspaceId,
          ),
          thread: reusable,
        }
      : await createThreadContext(this.env, active.identity, sessionId, "New chat", {
          status: "draft",
          draftExpiresAt,
        });

    if (!created.activeAgent || created.activeAgent.status !== "active") {
      throw new Error("Agent is not active");
    }

    const activeIdentity = { ...active.identity, agentId: created.activeAgent.id };
    const activeThread = toActiveThreadSummary(
      this.env,
      created.thread,
      created.activeAgent,
      created.thread.thread_id,
    );
    const context = await sessionContext(activeIdentity, {
      thread: created.thread,
      agent: created.activeAgent,
      accountId: input.identity.accountId,
      accountSource: input.identity.accountSource,
    });
    this.snapshot = {
      revision: this.nextRevision(),
      context,
      workspace:
        this.snapshot?.workspace ??
        (await workspaceSummary(this.env, input.identity.scope.workspaceId)),
      activeAgent: toAgentSummary(this.env, created.activeAgent, created.activeAgent.id),
      activeThread,
      threads: (this.snapshot?.threads ?? [])
        .filter((thread) => thread.threadId !== activeThread.threadId)
        .map((thread) => ({ ...thread, isActive: false })),
    };

    return responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      stagedThread: {
        threadId: activeThread.threadId,
        sessionId: activeThread.sessionId,
        expiresAt: draftExpiresAt,
        status: "draft",
      },
    });
  }

  private async publishMaterializedTurn(
    input: CoordinatorRequest,
    receipt: ClientTurnReceipt,
    activeThread: ReturnType<typeof toActiveThreadSummary>,
    startedAt: string,
  ) {
    if (receipt.lifecyclePublished) return receipt;
    const activeIdentity = { ...input.identity, agentId: receipt.agentId };
    await appendThreadLifecycleEvent(this.env, activeIdentity, {
      transition: "create",
      threadId: activeThread.threadId,
      activeThreadId: activeThread.threadId,
      nextStatus: activeThread.status,
    });
    this.broadcastEvent(
      this.createEvent("session.thread.created", {
        ...safeSnapshotData(this.snapshot!),
        transition: { type: "create", startedAt },
      }),
    );
    this.broadcastEvent(
      this.createEvent("admin.summary.invalidated", {
        reason: "thread-created",
        threadId: activeThread.threadId,
      }),
    );
    const published = { ...receipt, lifecyclePublished: true };
    await this.putClientTurn(published);
    return published;
  }

  private async resumeMaterializedTurn(
    input: CoordinatorRequest,
    receipt: ClientTurnReceipt,
  ): Promise<MaterializeTurnResult> {
    if (receipt.status === "accepted") {
      const snapshot = await this.ensureSnapshot(input);
      return responseFromSnapshot(this.env, input.agentHost!, snapshot, {
        partial: true,
        materializedTurn: {
          duplicate: true,
          messageId: receipt.messageId,
          status: "accepted",
          threadId: receipt.threadId,
        },
      });
    }

    const thread = await getOwnedChatThread(this.env, input.identity.scope, receipt.threadId);
    const agent = thread
      ? await selectAgent(this.env, receipt.agentId, input.identity.scope.workspaceId)
      : null;
    if (!thread || thread.status !== "active" || !agent || agent.status !== "active") {
      return { ok: false, error: "Materialized chat turn is no longer active", status: 409 };
    }
    const activeIdentity = { ...input.identity, agentId: agent.id };
    const activeThread = toActiveThreadSummary(this.env, thread, agent, thread.thread_id);
    const context = await sessionContext(activeIdentity, {
      thread,
      agent,
      accountId: input.identity.accountId,
      accountSource: input.identity.accountSource,
    });
    this.snapshot = await buildSnapshot(this.env, activeIdentity, {
      revision: this.nextRevision(),
      activeAgent: agent,
      activeThread: thread,
    });
    const response = await responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      materializedTurn: {
        duplicate: true,
        messageId: receipt.messageId,
        status: "accepted",
        threadId: receipt.threadId,
      },
    });
    const token = response.connection?.token;
    if (!token) {
      return { ok: false, error: "Materialized Agent connection token was missing", status: 500 };
    }
    const submitted = await submitProgrammaticTurn(this.env, {
      clientTurnId: receipt.clientTurnId,
      context,
      token,
      message: receipt.message,
    });
    if (!submitted.ok) {
      return { ok: false, error: submitted.error, status: submitted.status };
    }
    const accepted = {
      ...receipt,
      messageId: submitted.messageId ?? receipt.clientTurnId,
      status: "accepted" as const,
    };
    await this.putClientTurn(accepted);
    await this.publishMaterializedTurn(input, accepted, activeThread, receipt.createdAt);
    response.materializedTurn = {
      duplicate: true,
      messageId: accepted.messageId,
      status: "accepted",
      threadId: accepted.threadId,
    };
    return response;
  }

  private async materializeTurnOnce(input: CoordinatorRequest): Promise<MaterializeTurnResult> {
    const startedAt = new Date().toISOString();
    const message = normalizeMaterializeMessage(input.message);
    const clientTurnId = input.clientTurnId?.trim();
    if (!message || !clientTurnId || clientTurnId.length > 128) {
      return {
        ok: false,
        error: `message and clientTurnId must be bounded non-empty text; message max ${maxMaterializeTurnMessageLength} characters`,
        status: 400,
      };
    }
    const existing = this.clientTurns.find((receipt) => receipt.clientTurnId === clientTurnId);
    if (existing) return this.resumeMaterializedTurn(input, existing);

    const active = await this.activeIdentity(input);
    const sessionId =
      this.snapshot?.context?.sessionId ??
      active.latestSession?.session_id ??
      (await createChatSession(this.env, active.identity, { source: "cloudflare-agent-chat" }));
    const reusable = await findReusableDraftThread(
      this.env,
      active.identity,
      sessionId,
      this.snapshot?.context?.threadId,
      active.latestSession?.active_thread_id,
    );
    const created = reusable
      ? await materializeDraftThread(this.env, input.identity, reusable, message)
      : await createThreadContext(this.env, active.identity, sessionId, message);
    const activeIdentity = { ...active.identity, agentId: created.activeAgent.id };
    const activeThread = toActiveThreadSummary(
      this.env,
      created.thread,
      created.activeAgent,
      created.thread.thread_id,
    );
    const context = await sessionContext(activeIdentity, {
      thread: created.thread,
      agent: created.activeAgent,
      accountId: input.identity.accountId,
      accountSource: input.identity.accountSource,
    });
    this.snapshot = {
      revision: this.nextRevision(),
      context,
      workspace:
        this.snapshot?.workspace ??
        (await workspaceSummary(this.env, input.identity.scope.workspaceId)),
      activeAgent: toAgentSummary(this.env, created.activeAgent, created.activeAgent.id),
      activeThread,
      threads: mergeActiveThread(this.snapshot?.threads ?? [], activeThread),
    };

    const response = await responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      threadsRefreshRecommended: true,
      transition: { type: "create", startedAt },
      materializedTurn: { threadId: activeThread.threadId, status: "accepted" },
    });
    const token = response.connection?.token;
    if (!token) {
      return { ok: false, error: "Materialized Agent connection token was missing", status: 500 };
    }
    let receipt: ClientTurnReceipt = {
      agentId: created.activeAgent.id,
      clientTurnId,
      createdAt: startedAt,
      lifecyclePublished: false,
      message,
      messageId: clientTurnId,
      sessionId,
      status: "dispatching",
      threadId: activeThread.threadId,
    };
    await this.putClientTurn(receipt);
    const submitted = await submitProgrammaticTurn(this.env, {
      clientTurnId,
      context,
      token,
      message,
    });
    if (!submitted.ok) {
      return {
        ok: false,
        error: submitted.error,
        status: submitted.status,
      };
    }
    receipt = {
      ...receipt,
      messageId: submitted.messageId ?? clientTurnId,
      status: "accepted",
    };
    await this.putClientTurn(receipt);
    response.materializedTurn = {
      threadId: activeThread.threadId,
      status: "accepted",
      messageId: receipt.messageId,
    };
    await this.publishMaterializedTurn(input, receipt, activeThread, startedAt);
    return response;
  }

  async materializeTurn(input: CoordinatorRequest): Promise<MaterializeTurnResult> {
    await this.initialized;
    const clientTurnId = input.clientTurnId?.trim();
    if (!clientTurnId || clientTurnId.length > 128) {
      return { ok: false, error: "clientTurnId is required", status: 400 };
    }
    const inFlight = this.materializations.get(clientTurnId);
    if (inFlight) return inFlight;
    const materialization = this.materializeTurnOnce(input);
    this.materializations.set(clientTurnId, materialization);
    try {
      return await materialization;
    } finally {
      if (this.materializations.get(clientTurnId) === materialization) {
        this.materializations.delete(clientTurnId);
      }
    }
  }

  async updateThread(input: CoordinatorRequest) {
    const startedAt = new Date().toISOString();
    const threadId = input.threadId?.trim();
    if (!threadId) return { ok: false, error: "threadId is required", status: 400 };
    if (input.update?.title === undefined && !input.update?.status) {
      return { ok: false, error: "title or status is required", status: 400 };
    }

    const thread = await getOwnedChatThread(this.env, input.identity.scope, threadId);
    if (!thread || thread.status === "deleted") {
      return { ok: false, error: "Thread not found", status: 404 };
    }

    const nextTitle = titleFromUpdate(input.update.title);
    if (nextTitle === null) return { ok: false, error: "title cannot be empty", status: 400 };

    const nextStatus = input.update.status;
    await persistThreadMutation(this.env, input.identity, thread, {
      title: nextTitle,
      status: nextStatus,
    });
    if (nextStatus === "archived" || nextStatus === "deleted") {
      await abortThreadChatResponse(this.env, thread);
    }

    const latestSession = await getLatestChatSession(this.env, input.identity.scope);
    const deactivatedActiveThread =
      latestSession?.active_thread_id === threadId &&
      (nextStatus === "archived" || nextStatus === "deleted");
    let snapshotIdentity = input.identity;
    let activeThread: ChatThreadRow | undefined;
    let activeAgent: AgentRow | undefined;

    if (deactivatedActiveThread) {
      const fallback = await findFallbackActiveThread(this.env, input.identity, threadId);
      if (fallback) {
        const fallbackAgent = await selectAgent(
          this.env,
          fallback.agent_id,
          input.identity.scope.workspaceId,
        );
        if (!fallbackAgent || fallbackAgent.status !== "active") {
          throw new Error("Agent is not active");
        }
        await upsertActiveAgentPreference(this.env, {
          userId: input.identity.scope.userId,
          workspaceId: input.identity.scope.workspaceId,
          agentId: fallbackAgent.id,
          reason: "thread-lifecycle-fallback",
        });
        await touchChatSession(
          this.env,
          input.identity.scope,
          fallback.session_id,
          fallback.thread_id,
        );
        snapshotIdentity = { ...input.identity, agentId: fallbackAgent.id };
        activeThread = fallback;
        activeAgent = fallbackAgent;
      } else {
        if (latestSession?.session_id) {
          await clearActiveThread(this.env, input.identity, latestSession.session_id);
        }
      }
    }

    this.snapshot = await buildSnapshot(this.env, snapshotIdentity, {
      revision: this.nextRevision(),
      activeThread,
      activeAgent,
    });
    const updatedThread =
      (await getOwnedChatThread(this.env, input.identity.scope, threadId)) ?? thread;
    const updatedAgent =
      (await selectAgent(this.env, updatedThread.agent_id, input.identity.scope.workspaceId)) ??
      activeAgent;
    const activeThreadId = this.snapshot.context?.threadId ?? null;
    const activeAgentId = this.snapshot.context?.agentId ?? this.snapshot.activeAgent.id;
    const summarizedThread = updatedAgent
      ? toActiveThreadSummary(this.env, updatedThread, updatedAgent, activeThreadId ?? "")
      : toThreadSummary(this.env, updatedThread, {
          activeThreadId,
          activeAgentId,
        });
    const transition = nextStatus ? transitionForStatus(nextStatus) : "rename";
    await appendThreadLifecycleEvent(this.env, snapshotIdentity, {
      transition,
      threadId,
      activeThreadId: activeThreadId ?? undefined,
      replacementThreadId: deactivatedActiveThread ? (activeThreadId ?? undefined) : undefined,
      previousStatus: thread.status,
      nextStatus: updatedThread.status,
    });

    this.broadcastEvent(
      this.createEvent("session.thread.updated", {
        ...safeThreadData(this.snapshot, summarizedThread),
        transition: { type: transition, startedAt },
      }),
    );
    this.broadcastEvent(
      this.createEvent("admin.summary.invalidated", {
        reason: `thread-${transition}`,
        threadId,
      }),
    );
    return responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      threadsRefreshRecommended: true,
      transition: { type: transition, startedAt },
    });
  }

  async activateThread(input: CoordinatorRequest) {
    const startedAt = new Date().toISOString();
    const threadId = input.threadId?.trim();
    if (!threadId) return { ok: false, error: "threadId is required" };

    const thread = await getOwnedChatThread(this.env, input.identity.scope, threadId);
    if (!thread || thread.status !== "active") {
      return { ok: false, error: "Thread not found", status: 404 };
    }

    const agent = await selectAgent(this.env, thread.agent_id, input.identity.scope.workspaceId);
    if (!agent) return { ok: false, error: "Thread not found", status: 404 };
    if (agent.status !== "active") return { ok: false, error: "Agent is not active", status: 403 };

    await upsertActiveAgentPreference(this.env, {
      userId: input.identity.scope.userId,
      workspaceId: input.identity.scope.workspaceId,
      agentId: agent.id,
      reason: "thread-activated",
    });
    await touchChatSession(this.env, input.identity.scope, thread.session_id, thread.thread_id);

    const activeIdentity = { ...input.identity, agentId: agent.id };
    const activeThread = toActiveThreadSummary(this.env, thread, agent, thread.thread_id);
    const context = await sessionContext(activeIdentity, {
      thread,
      agent,
      accountId: input.identity.accountId,
      accountSource: input.identity.accountSource,
    });
    this.snapshot = {
      revision: this.nextRevision(),
      context,
      workspace:
        this.snapshot?.workspace ??
        (await workspaceSummary(this.env, input.identity.scope.workspaceId)),
      activeAgent: toAgentSummary(this.env, agent, agent.id),
      activeThread,
      threads: mergeActiveThread(this.snapshot?.threads ?? [], activeThread),
    };
    await appendThreadLifecycleEvent(this.env, activeIdentity, {
      transition: "activate",
      threadId: activeThread.threadId,
      activeThreadId: activeThread.threadId,
      nextStatus: activeThread.status,
    });
    this.broadcastEvent(
      this.createEvent("session.thread.activated", {
        ...safeSnapshotData(this.snapshot),
        transition: { type: "activate", startedAt },
      }),
    );
    this.broadcastEvent(
      this.createEvent("admin.summary.invalidated", {
        reason: "thread-activated",
        threadId: activeThread.threadId,
      }),
    );
    return responseFromSnapshot(this.env, input.agentHost!, this.snapshot, {
      partial: true,
      threadsRefreshRecommended: true,
      transition: { type: "activate", startedAt },
    });
  }

  async switchAgent(input: CoordinatorRequest) {
    const switched = await switchSessionAgent({
      env: this.env,
      request: input,
      snapshot: this.snapshot,
      nextRevision: this.nextRevision,
      broadcast: (type, data) => this.broadcastEvent(this.createEvent(type, data)),
    });
    if (switched.snapshot) this.snapshot = switched.snapshot;
    return switched.result;
  }

  async stream(input: CoordinatorRequest) {
    const snapshot = await this.ensureSnapshot(input);
    const initialEvents = resolveSessionReplay({
      after: input.after,
      events: this.events,
      snapshotEvent: this.createEvent("session.snapshot", safeSnapshotData(snapshot), {
        revision: snapshot.revision,
      }),
    });
    return createSessionEventStream({
      clients: this.clients,
      initialEvents,
      sendEvent: (controller, event) => this.sendEvent(controller, event),
    });
  }

  broadcast(input: CoordinatorRequest) {
    if (!input.event?.type) return { ok: false, error: "event.type is required", status: 400 };
    const event = this.createEvent(input.event.type, input.event.data ?? {}, {
      id: input.event.id,
      createdAt: input.event.createdAt,
      revision: input.event.revision,
    });
    this.broadcastEvent(event);
    return { ok: true, eventId: event.id };
  }

  async alarm() {
    await this.initialized;
    await this.state.blockConcurrencyWhile(() =>
      recoverRuntimeDeadlines(this.state.storage, this.env),
    );
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/run-deadline") {
      await this.initialized;
      return handleRuntimeDeadlineRequest(request, this.state);
    }
    return handleSessionAgentRequest(this, request);
  }
}
