import { registerRuntimeDeadline } from "./runtime-watchdog";
import {
  assertUsableChatCompletion,
  chatCompletionGuard,
  ChatCompletionError,
} from "./chat-completion";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { Connection, ConnectionContext } from "agents";

import {
  resolveAgentBehaviorConfig,
  resolveAgentBehaviorInstruction,
  resolveAgentRuntimeConfig,
  toAgentSummary,
  toAgentBehaviorMetadata,
  toAgentRuntimeMetadata,
} from "./agent-records";
import {
  assertCurrentAgentConnectionScope,
  claimsToIdentity,
  verifyAgentConnectionToken,
} from "./agent-connection-token";
import type { AgentConnectionClaims } from "./agent-connection-token";
import { selectAgent } from "./authz-store";
import { resolveThreadAgentInstanceName } from "./chat-agent-connection-context";
import {
  createAgentChatRunStartMirror,
  getOwnedChatThread,
  promoteDraftChatThread,
  updateChatRun,
  updateChatThreadUpstream,
} from "./chat-boundary-store";
import { finishTrace, recordSpan, type RuntimeTraceContext } from "./runtime-traces";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import { resolveModelVisibleTools } from "./model-tools";
import { existingProgrammaticTurnMessageId } from "./thread-chat-idempotency";
import type { AgentRow, Env, WorkerExecutionContext } from "./types";

const getRequiredSecret = (env: Env) => {
  const secret = env.WORKBENCH_AGENT_CONNECTION_SECRET?.trim();
  if (!secret) throw new Error("WORKBENCH_AGENT_CONNECTION_SECRET is not configured");
  return secret;
};

const getTokenFromRequest = (request: Request) =>
  new URL(request.url).searchParams.get("token")?.trim() ?? "";

const getTokenFromBody = (body?: Record<string, unknown>) =>
  typeof body?.token === "string" ? body.token.trim() : "";

const getTraceIdFromBody = (body?: Record<string, unknown>) =>
  typeof body?.traceId === "string" && body.traceId.trim() ? body.traceId.trim() : undefined;

const getClientTurnIdFromBody = (body?: Record<string, unknown>) => {
  const value = typeof body?.clientTurnId === "string" ? body.clientTurnId.trim() : "";
  return value && value.length <= 128 ? value : null;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const sha256Text = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizeProgrammaticMessage = (message: unknown) => {
  if (typeof message !== "string") return null;
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length > 8_000) return null;
  return normalized;
};

const createE2EChatResponse = () => {
  const messageId = `assistant-e2e-${crypto.randomUUID()}`;
  const textId = `text-e2e-${crypto.randomUUID()}`;
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId });
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: "Ready." });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish", finishReason: "stop" });
      },
    }),
  });
};

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ("text" in part && typeof part.text === "string") return part.text;
      if ("content" in part && typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
};

const summarizeMessages = (messages: readonly unknown[]) => {
  const firstUser = messages.find((message) => {
    if (!message || typeof message !== "object") return false;
    const role = "role" in message ? message.role : "type" in message ? message.type : undefined;
    return role === "user" || role === "human";
  });
  const content =
    firstUser && typeof firstUser === "object"
      ? "content" in firstUser
        ? firstUser.content
        : "parts" in firstUser
          ? firstUser.parts
          : ""
      : "";
  const title = textFromContent(content).replace(/\s+/g, " ").trim();
  return {
    messageCount: messages.length,
    title: title ? (title.length > 56 ? `${title.slice(0, 53)}...` : title) : "New chat",
  };
};

type ResolvedAgentChatConfig = {
  cacheKey: string;
  agentRow: AgentRow | null;
  runtimeConfig: ReturnType<typeof resolveAgentRuntimeConfig>;
  behaviorConfig: ReturnType<typeof resolveAgentBehaviorConfig>;
  behaviorInstruction: string;
  agentMetadata: ReturnType<typeof toAgentRuntimeMetadata>;
};

type ConfigResolveResult = ResolvedAgentChatConfig & {
  cacheStatus: "hit" | "miss";
};

export class WorkbenchThreadChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  private agentConfigCache: ResolvedAgentChatConfig | null = null;
  private programmaticSubmitBody: { id: string; body: Record<string, unknown> } | null = null;

  private getEnv() {
    return (this as unknown as { env: Env }).env;
  }
  private waitUntil(promise: Promise<unknown>) {
    (this as unknown as { ctx: WorkerExecutionContext }).ctx.waitUntil(promise);
  }
  private ensureLifecycleFenceTable() {
    void this.sql`CREATE TABLE IF NOT EXISTS workbench_lifecycle_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      job_id TEXT NOT NULL,
      frozen_at TEXT NOT NULL
    )`;
  }
  private lifecycleFence() {
    this.ensureLifecycleFenceTable();
    return this.sql<{ job_id: string; frozen_at: string }>`
      SELECT job_id, frozen_at FROM workbench_lifecycle_fence WHERE singleton = 1 LIMIT 1
    `[0];
  }
  messageConcurrency = "drop" as const;

  private cacheKey(claims: AgentConnectionClaims, row: AgentRow | null) {
    return `${claims.workspaceId}:${claims.agentId}:${claims.agentUpdatedAt ?? row?.updated_at ?? "unknown"}`;
  }

  private async verifyScopedClaims(token: string) {
    const claims = await verifyAgentConnectionToken(getRequiredSecret(this.getEnv()), token);
    const thread = await getOwnedChatThread(
      this.getEnv(),
      { userId: claims.userId, workspaceId: claims.workspaceId },
      claims.threadId,
    );
    if (!thread) throw new Error("Agent token thread not found");
    const activeAgent = await selectAgent(this.getEnv(), claims.agentId, claims.workspaceId);
    assertCurrentAgentConnectionScope(claims, thread, activeAgent, {
      allowedThreadStatuses: ["active", "draft"],
    });
    const expectedInstanceName = await resolveThreadAgentInstanceName(thread);
    if (claims.instanceName !== expectedInstanceName || claims.instanceName !== this.name) {
      throw new Error("Agent token scope mismatch");
    }
    return claims;
  }

  private async resolveChatConfig(claims: AgentConnectionClaims): Promise<ConfigResolveResult> {
    const cached = this.agentConfigCache;
    if (cached) {
      const expectedCacheKey = this.cacheKey(claims, cached.agentRow);
      if (cached.cacheKey === expectedCacheKey) {
        return { ...cached, cacheStatus: "hit" };
      }
    }

    const activeAgent = await selectAgent(this.getEnv(), claims.agentId, claims.workspaceId);
    const runtimeConfig = resolveAgentRuntimeConfig(this.getEnv(), activeAgent);
    const behaviorConfig = resolveAgentBehaviorConfig(activeAgent);
    const resolved = {
      cacheKey: this.cacheKey(claims, activeAgent),
      agentRow: activeAgent,
      runtimeConfig,
      behaviorConfig,
      behaviorInstruction: resolveAgentBehaviorInstruction(activeAgent),
      agentMetadata: toAgentRuntimeMetadata(this.getEnv(), activeAgent, claims.agentId),
    };
    this.agentConfigCache = resolved;
    return { ...resolved, cacheStatus: "miss" };
  }

  private async handleProgrammaticSubmit(request: Request) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const message = normalizeProgrammaticMessage(body.message);
    const clientTurnId = getClientTurnIdFromBody(body);
    if (!message || !clientTurnId) {
      return jsonResponse(
        { ok: false, error: "message and clientTurnId must be non-empty bounded text" },
        400,
      );
    }

    let claims: AgentConnectionClaims;
    try {
      claims = await this.verifyScopedClaims(getTokenFromBody(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent authentication failed";
      return jsonResponse({ ok: false, error: message }, message.includes("scope") ? 403 : 401);
    }
    if (
      (typeof body.threadId === "string" && body.threadId !== claims.threadId) ||
      (typeof body.sessionId === "string" && body.sessionId !== claims.sessionId)
    ) {
      return jsonResponse({ ok: false, error: "Programmatic turn scope mismatch" }, 403);
    }

    const existingMessageId = existingProgrammaticTurnMessageId(this.messages, clientTurnId);
    if (existingMessageId) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        status: "accepted",
        threadId: claims.threadId,
        messageId: existingMessageId,
      });
    }
    if (this.programmaticSubmitBody) {
      if (this.programmaticSubmitBody.body.clientTurnId === clientTurnId) {
        return jsonResponse({
          ok: true,
          duplicate: true,
          status: "accepted",
          threadId: claims.threadId,
          messageId: clientTurnId,
        });
      }
      return jsonResponse({ ok: false, error: "Programmatic turn already in progress" }, 409);
    }

    const submitId = crypto.randomUUID();
    const submitBody = {
      id: submitId,
      body: {
        token: getTokenFromBody(body),
        threadId: claims.threadId,
        sessionId: claims.sessionId,
        traceId: getTraceIdFromBody(body) ?? `trace-${crypto.randomUUID()}`,
        source: "programmatic-materialize-turn",
        clientTurnId,
      },
    };
    const userMessage: UIMessage = {
      id: clientTurnId,
      role: "user",
      parts: [{ type: "text", text: message }],
    };
    const nextMessages = [...this.messages, userMessage];
    this.programmaticSubmitBody = submitBody;
    // Make the accepted user turn durable and visible before returning. Model
    // execution remains detached so a cold/new thread does not turn provider
    // latency into composer latency.
    await this.persistMessages(nextMessages);
    this.waitUntil(
      (async () => {
        try {
          await this.saveMessages(nextMessages);
        } catch (error) {
          console.error(
            "Programmatic chat turn failed after acceptance",
            error instanceof Error ? error.message : "Unknown chat error",
          );
        } finally {
          if (this.programmaticSubmitBody?.id === submitId) {
            this.programmaticSubmitBody = null;
          }
        }
      })(),
    );

    return jsonResponse({
      ok: true,
      status: "accepted",
      threadId: claims.threadId,
      messageId: userMessage.id,
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      (url.pathname === "/internal/lifecycle-export" ||
        url.pathname === "/internal/lifecycle-purge" ||
        url.pathname === "/internal/lifecycle-freeze" ||
        url.pathname === "/internal/lifecycle-unfreeze")
    ) {
      const provided = request.headers.get("x-workbench-lifecycle-secret")?.trim();
      if (!provided || provided !== getRequiredSecret(this.getEnv())) {
        return jsonResponse({ ok: false, error: "Lifecycle authorization failed" }, 401);
      }
      if (url.pathname === "/internal/lifecycle-export") {
        return jsonResponse({ ok: true, messages: this.messages });
      }
      if (url.pathname === "/internal/lifecycle-freeze") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
        if (!jobId) return jsonResponse({ ok: false, error: "Lifecycle job id is required" }, 400);
        const existing = this.lifecycleFence();
        if (existing && existing.job_id !== jobId) {
          return jsonResponse({ ok: false, error: "Thread is frozen by another export" }, 409);
        }
        const snapshotAt = existing?.frozen_at ?? new Date().toISOString();
        if (!existing) {
          void this.sql`
            INSERT INTO workbench_lifecycle_fence (singleton, job_id, frozen_at)
            VALUES (1, ${jobId}, ${snapshotAt})
          `;
        }
        const serializedMessages = JSON.stringify(this.messages);
        return jsonResponse({
          ok: true,
          jobId,
          snapshotAt,
          messageCount: this.messages.length,
          contentSha256: await sha256Text(serializedMessages),
          messages: this.messages,
        });
      }
      if (url.pathname === "/internal/lifecycle-unfreeze") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
        if (!jobId) return jsonResponse({ ok: false, error: "Lifecycle job id is required" }, 400);
        this.ensureLifecycleFenceTable();
        void this
          .sql`DELETE FROM workbench_lifecycle_fence WHERE singleton = 1 AND job_id = ${jobId}`;
        return jsonResponse({ ok: true, jobId, frozen: false });
      }
      // Lifecycle purge is storage maintenance after workspace authority has
      // already been revoked. Persist directly so clearing the transcript
      // cannot start a model turn or require a now-invalid agent token.
      await this.persistMessages([]);
      this.ensureLifecycleFenceTable();
      void this.sql`DELETE FROM workbench_lifecycle_fence WHERE singleton = 1`;
      this.agentConfigCache = null;
      return jsonResponse({ ok: true, purged: true });
    }
    if (this.lifecycleFence() && request.method !== "GET") {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_export_in_progress",
          error: "Workspace writes are briefly paused while an export snapshot is captured.",
        },
        423,
      );
    }
    if (request.method === "POST" && url.pathname === "/internal/programmatic-submit") {
      return this.handleProgrammaticSubmit(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/thread-cancel") {
      const provided = request.headers.get("x-workbench-agent-secret")?.trim();
      if (!provided || provided !== getRequiredSecret(this.getEnv())) {
        return jsonResponse({ ok: false, error: "Agent cancellation authorization failed" }, 401);
      }
      this.resetTurnState();
      this.programmaticSubmitBody = null;
      return jsonResponse({ ok: true, cancelled: true });
    }
    try {
      await this.verifyScopedClaims(getTokenFromRequest(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent authentication failed";
      return new Response(message, { status: message.includes("scope") ? 403 : 401 });
    }
    return super.fetch(request);
  }

  async onConnect(connection: Connection, context: ConnectionContext) {
    try {
      if (this.lifecycleFence()) {
        connection.close(1013, "Workspace export snapshot in progress");
        return;
      }
      const claims = await this.verifyScopedClaims(getTokenFromRequest(context.request));
      await this.resolveChatConfig(claims);
      await super.onConnect(connection, context);
    } catch (error) {
      connection.close(
        1008,
        error instanceof Error ? error.message : "Agent authentication failed",
      );
    }
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    if (this.lifecycleFence()) {
      throw Object.assign(new Error("Workspace export snapshot in progress"), {
        code: "workspace_export_in_progress",
      });
    }
    const requestBody = (options?.body ?? this.programmaticSubmitBody?.body) as
      | Record<string, unknown>
      | undefined;
    const clientTurnId = getClientTurnIdFromBody(requestBody) ?? undefined;
    const tokenVerifyStartedAtMs = Date.now();
    const claims = await this.verifyScopedClaims(getTokenFromBody(requestBody));
    const tokenVerifyEndedAtMs = Date.now();
    if (this.getEnv().WORKBENCH_E2E_MODE === "true") return createE2EChatResponse();
    if (!this.getEnv().OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");

    const identity = claimsToIdentity(claims);
    const requestStartedAtMs = Date.now();
    const trace: RuntimeTraceContext = {
      traceId: getTraceIdFromBody(requestBody) ?? `trace-${crypto.randomUUID()}`,
      kind: "chat.agent.stream",
      rootName: "Cloudflare Agent chat response",
      startedAtMs: requestStartedAtMs,
    };

    let runId: string | null = null;
    let firstTokenAtMs: number | null = null;
    let providerStartedAtMs = 0;
    let terminalState: "open" | "completed" | "failed" = "open";
    const traceWritePromises: Promise<unknown>[] = [];
    const queueTraceWrite = (promise: Promise<unknown>) => {
      const guarded = promise.catch((error) => {
        console.error("Failed to record Agent runtime span", error);
      });
      traceWritePromises.push(guarded);
      this.waitUntil(guarded);
      return guarded;
    };
    const markTerminal = (state: "completed" | "failed") => {
      if (terminalState !== "open") return false;
      terminalState = state;
      return true;
    };

    try {
      const configStartedAtMs = Date.now();
      const {
        runtimeConfig,
        behaviorConfig,
        behaviorInstruction,
        agentMetadata,
        agentRow,
        cacheStatus,
      } = await this.resolveChatConfig(claims);
      const configEndedAtMs = Date.now();
      const firstMessageSummary = summarizeMessages(this.messages);
      const draftPromotion = await promoteDraftChatThread(
        this.getEnv(),
        identity.scope,
        claims.threadId,
        {
          source: "cloudflare-agent-chat",
          runtime: "cloudflare-agent-chat",
          threadId: claims.threadId,
          instanceName: claims.instanceName,
          agent: agentMetadata,
          ...firstMessageSummary,
        },
      );
      if (draftPromotion.promoted && draftPromotion.thread) {
        const activeAgent = agentRow
          ? toAgentSummary(this.getEnv(), agentRow, claims.agentId)
          : null;
        const activeThread = {
          threadId: draftPromotion.thread.thread_id,
          sessionId: draftPromotion.thread.session_id,
          agentId: draftPromotion.thread.agent_id,
          agent: activeAgent,
          status: "active",
          title: firstMessageSummary.title,
          createdAt: draftPromotion.thread.created_at,
          updatedAt: draftPromotion.thread.updated_at,
          lastSeenAt: draftPromotion.thread.last_seen_at,
          isActive: true,
          messageCount: firstMessageSummary.messageCount,
        };
        this.waitUntil(
          dispatchWorkbenchSessionEvent(this.getEnv(), identity, {
            type: "session.thread.created",
            data: {
              activeAgent,
              activeThread,
              thread: activeThread,
              threads: [activeThread],
              transition: { type: "create", startedAt: new Date(requestStartedAtMs).toISOString() },
            },
          }),
        );
        this.waitUntil(
          dispatchWorkbenchSessionEvent(this.getEnv(), identity, {
            type: "admin.summary.invalidated",
            data: {
              reason: "thread-created",
              threadId: claims.threadId,
            },
          }),
        );
      }

      const runStart = await createAgentChatRunStartMirror(this.getEnv(), identity, {
        traceId: trace.traceId,
        traceStartedAtMs: trace.startedAtMs,
        tokenVerifyStartedAtMs,
        tokenVerifyEndedAtMs,
        configResolveStartedAtMs: configStartedAtMs,
        configResolveEndedAtMs: configEndedAtMs,
        configCacheStatus: cacheStatus,
        sessionId: claims.sessionId,
        threadId: claims.threadId,
        requestId: options?.requestId,
        agentMetadata,
        model: runtimeConfig.model,
        runtimeConfig,
        behavior: toAgentBehaviorMetadata(behaviorConfig),
      });
      runId = runStart.runId;
      await registerRuntimeDeadline(this.getEnv(), {
        identity,
        run: { runId },
        deadline: Date.now() + 105_000,
        chat: { threadId: claims.threadId, clientTurnId, traceId: trace.traceId },
      });
      this.waitUntil(
        dispatchWorkbenchSessionEvent(this.getEnv(), identity, {
          type: "chat.run.started",
          data: {
            runtime: "cloudflare-agent-chat",
            status: "running",
            threadId: claims.threadId,
            sessionId: claims.sessionId,
            runId,
            traceId: trace.traceId,
            model: runtimeConfig.model,
            clientTurnId,
          },
        }),
      );
      queueTraceWrite(
        recordSpan(this.getEnv(), identity, {
          traceId: trace.traceId,
          name: "D1 run-start batch",
          layer: "d1",
          startedAtMs: runStart.batchStartedAtMs,
          endedAtMs: runStart.batchEndedAtMs,
          data: {
            intentId: runStart.intentId,
            policyDecisionId: runStart.policyDecisionId,
            runId,
            d1DurationMs: runStart.d1DurationMs,
            wallClockMs: runStart.batchEndedAtMs - runStart.batchStartedAtMs,
          },
        }),
      );

      const toolResolveStartedAtMs = Date.now();
      const modelTools = await resolveModelVisibleTools(this.getEnv(), identity, {
        chatRunId: runId,
        threadId: claims.threadId,
        traceId: trace.traceId,
      });
      queueTraceWrite(
        recordSpan(this.getEnv(), identity, {
          traceId: trace.traceId,
          name: "Model tool exposure resolver",
          layer: "cloudflare",
          startedAtMs: toolResolveStartedAtMs,
          endedAtMs: Date.now(),
          status:
            modelTools.exposure.decision === "allow" || modelTools.exposure.fastPath
              ? "completed"
              : "blocked",
          data: {
            code: modelTools.exposure.code,
            reason: modelTools.exposure.reason,
            fastPath: Boolean(modelTools.exposure.fastPath),
            visibleToolCount: Object.keys(modelTools.tools).length,
          },
        }),
      );

      providerStartedAtMs = Date.now();
      queueTraceWrite(
        recordSpan(this.getEnv(), identity, {
          traceId: trace.traceId,
          name: "OpenRouter request",
          layer: "provider",
          startedAtMs: providerStartedAtMs,
          endedAtMs: providerStartedAtMs,
          spanType: "event",
          isAggregate: false,
          bottleneckCandidate: false,
          data: { model: runtimeConfig.model },
        }),
      );
      const openrouter = createOpenRouter({
        apiKey: this.getEnv().OPENROUTER_API_KEY,
        headers: {
          ...(this.getEnv().OPENROUTER_SITE_URL
            ? { "HTTP-Referer": this.getEnv().OPENROUTER_SITE_URL }
            : {}),
          ...(this.getEnv().OPENROUTER_APP_NAME
            ? { "X-Title": this.getEnv().OPENROUTER_APP_NAME }
            : {}),
        },
      });
      const result = streamText({
        model: openrouter.chat(runtimeConfig.model),
        system: behaviorInstruction,
        messages: await convertToModelMessages(this.messages),
        tools: modelTools.tools,
        stopWhen: stepCountIs(3),
        temperature: runtimeConfig.temperature,
        maxOutputTokens: runtimeConfig.maxTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(90_000),
          ...(options?.abortSignal ? [options.abortSignal] : []),
        ]),
        onAbort: async () => {
          if (markTerminal("failed"))
            await failAgentRun(this.getEnv(), identity, trace, {
              runId,
              error: new Error("Chat was interrupted. Your message is saved; retry when ready."),
              startedAtMs: requestStartedAtMs,
              clientTurnId,
            });
        },
        onChunk: async () => {
          if (firstTokenAtMs !== null) return;
          firstTokenAtMs = Date.now();
          queueTraceWrite(
            recordSpan(this.getEnv(), identity, {
              traceId: trace.traceId,
              name: "OpenRouter first token",
              layer: "provider",
              startedAtMs: providerStartedAtMs,
              endedAtMs: firstTokenAtMs,
              data: { model: runtimeConfig.model },
            }),
          );
        },
        onFinish: async (event) => {
          const endedAtMs = Date.now();
          try {
            await onFinish(event);
            assertUsableChatCompletion(event);
          } catch (error) {
            if (markTerminal("failed")) {
              await failAgentRun(this.getEnv(), identity, trace, {
                runId,
                error,
                startedAtMs: requestStartedAtMs,
                clientTurnId,
              });
            }
            throw error;
          }
          if (!markTerminal("completed")) return;
          this.waitUntil(
            (async () => {
              const completionMirrorStartedAtMs = Date.now();
              if (runId) {
                const completion = await updateChatRun(this.getEnv(), {
                  runId,
                  scope: identity.scope,
                  status: "completed",
                  metadata: {
                    runtime: "cloudflare-agent-chat",
                    model: runtimeConfig.model,
                    behavior: toAgentBehaviorMetadata(behaviorConfig),
                    timings: {
                      firstTokenMs: firstTokenAtMs
                        ? firstTokenAtMs - providerStartedAtMs
                        : undefined,
                      totalMs: endedAtMs - requestStartedAtMs,
                      providerMs: endedAtMs - providerStartedAtMs,
                    },
                  },
                });
                if (!completion.updated) return;
              }
              await updateChatThreadUpstream(this.getEnv(), identity.scope, claims.threadId, {
                source: "cloudflare-agent-chat",
                runtime: "cloudflare-agent-chat",
                threadId: claims.threadId,
                instanceName: claims.instanceName,
                agent: agentMetadata,
                lastRunId: runId,
                ...summarizeMessages(this.messages),
              });
              await recordSpan(this.getEnv(), identity, {
                traceId: trace.traceId,
                name: "Stream duration",
                layer: "provider",
                startedAtMs: firstTokenAtMs ?? providerStartedAtMs,
                endedAtMs,
                data: { model: runtimeConfig.model },
              });
              await recordSpan(this.getEnv(), identity, {
                traceId: trace.traceId,
                name: "D1 completion mirror",
                layer: "d1",
                startedAtMs: completionMirrorStartedAtMs,
                endedAtMs: Date.now(),
                data: { runId },
              });
              await recordSpan(this.getEnv(), identity, {
                traceId: trace.traceId,
                name: "Agent stream lifecycle",
                layer: "durable_object",
                startedAtMs: requestStartedAtMs,
                endedAtMs,
                spanType: "phase",
                isAggregate: true,
                bottleneckCandidate: false,
                data: {
                  note: "Aggregate lifecycle span for the streamed Agent response; not a DO persistence timer.",
                },
              });
              await Promise.allSettled(traceWritePromises);
              await finishTrace(this.getEnv(), identity, trace, {
                status: "completed",
                summary: "Agent chat response completed.",
                data: {
                  runtime: "cloudflare-agent-chat",
                  threadId: claims.threadId,
                  sessionId: claims.sessionId,
                  runId,
                },
                endedAtMs,
              });
              await dispatchWorkbenchSessionEvent(this.getEnv(), identity, {
                type: "chat.run.completed",
                data: {
                  runtime: "cloudflare-agent-chat",
                  status: "completed",
                  threadId: claims.threadId,
                  sessionId: claims.sessionId,
                  runId,
                  traceId: trace.traceId,
                  clientTurnId,
                  timings: {
                    firstTokenMs: firstTokenAtMs ? firstTokenAtMs - providerStartedAtMs : undefined,
                    totalMs: endedAtMs - requestStartedAtMs,
                  },
                },
              });
              await dispatchWorkbenchSessionEvent(this.getEnv(), identity, {
                type: "admin.summary.invalidated",
                data: {
                  reason: "chat-run-completed",
                  threadId: claims.threadId,
                  runId,
                  traceId: trace.traceId,
                },
              });
            })(),
          );
        },
        onError: async ({ error }) => {
          if (markTerminal("failed")) {
            await failAgentRun(this.getEnv(), identity, trace, {
              runId,
              error,
              startedAtMs: requestStartedAtMs,
              clientTurnId,
            });
          }
        },
      });

      return createUIMessageStreamResponse({
        stream: result
          .toUIMessageStream({
            onError: (error) =>
              error instanceof ChatCompletionError
                ? error.message
                : "Chat failed. Your message is saved; retry when ready.",
          })
          .pipeThrough(chatCompletionGuard()),
      });
    } catch (error) {
      if (markTerminal("failed")) {
        await failAgentRun(this.getEnv(), identity, trace, {
          runId,
          error,
          startedAtMs: requestStartedAtMs,
          clientTurnId,
        });
      }
      throw error;
    }
  }
}

const failAgentRun = async (
  env: Env,
  identity: ReturnType<typeof claimsToIdentity>,
  trace: RuntimeTraceContext,
  input: {
    runId: string | null;
    error: unknown;
    startedAtMs: number;
    clientTurnId?: string;
  },
) => {
  const message = input.error instanceof Error ? input.error.message : "Agent chat failed";
  if (input.runId) {
    const failure = await updateChatRun(env, {
      runId: input.runId,
      scope: identity.scope,
      status: "failed",
      error: message,
      metadata: {
        runtime: "cloudflare-agent-chat",
        errorCode: "runtime_failed",
        retryable: true,
      },
    });
    if (!failure.updated) return;
  }
  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Agent chat failed",
    layer: "durable_object",
    status: "failed",
    startedAtMs: input.startedAtMs,
    endedAtMs: Date.now(),
    data: { errorCode: "runtime_failed" },
  });
  await finishTrace(env, identity, trace, {
    status: "failed",
    summary: message,
    data: { runtime: "cloudflare-agent-chat", errorCode: "runtime_failed", retryable: true },
  });
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "chat.run.failed",
    data: {
      runtime: "cloudflare-agent-chat",
      status: "failed",
      runId: input.runId,
      traceId: trace.traceId,
      errorCode: "runtime_failed",
      retryable: true,
      message,
      clientTurnId: input.clientTurnId,
    },
  });
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "admin.summary.invalidated",
    data: {
      reason: "chat-run-failed",
      runId: input.runId,
      traceId: trace.traceId,
    },
  });
};
