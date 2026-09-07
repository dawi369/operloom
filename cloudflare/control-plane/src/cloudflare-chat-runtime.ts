import {
  createAllowedChatRunBoundary,
  createChatIntent,
  createChatPolicyDecision,
  createChatSession,
  getLatestChatSession,
  getLatestRunningChatRun,
  isChatRunClaimConflict,
  storeChatThread,
  touchChatSession,
  updateChatRun,
  updateChatThreadUpstream,
} from "./chat-boundary-store";
import {
  resolveAgentBehaviorConfig,
  resolveAgentBehaviorInstruction,
  resolveAgentRuntimeConfig,
  toAgentRuntimeMetadata,
  type AgentBehaviorConfig,
  type AgentRuntimeConfig,
} from "./agent-records";
import { selectAgent } from "./authz-store";
import {
  deriveChatExecutionMode,
  evaluateChatRunPolicy,
  runningChatRunPolicy,
} from "./chat-policy";
import { appendControlPlaneEvent } from "./control-plane-events";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import {
  finishTrace,
  recordIncomingRequestSpans,
  recordSpan,
  startTrace,
  type IncomingRuntimeTrace,
  type RuntimeTraceContext,
} from "./runtime-traces";
import {
  createId,
  type AgentIdentity,
  type ChatThreadRow,
  type Env,
  type WorkerExecutionContext,
} from "./types";

type StoredMessage = {
  id: string;
  type: "system" | "human" | "ai";
  content: string;
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
};

type ChatRuntimeErrorCode =
  | "unsupported_assistant"
  | "missing_model_secret"
  | "upstream_failed"
  | "runtime_failed";

type ChatRunTimingInput = {
  facadeEnteredAtMs?: number;
  bodyReadAtMs?: number;
};

type ChatRunTimingSnapshot = {
  preStreamMs?: number;
  firstTokenMs?: number;
  providerMs?: number;
  totalMs: number;
  stageMarks: Record<string, number>;
};

class ChatRuntimeError extends Error {
  constructor(
    message: string,
    readonly errorCode: ChatRuntimeErrorCode,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ChatRuntimeError";
  }
}

const modelProvider = "openrouter";

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

const textEncoder = new TextEncoder();

const sse = (event: string, data: unknown) =>
  textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const safeWaitUntil = (
  ctx: WorkerExecutionContext | undefined,
  promise: Promise<unknown>,
  label: string,
) => {
  if (!ctx) {
    void promise.catch((error) => {
      console.error(label, error);
    });
    return;
  }
  ctx.waitUntil(
    promise.catch((error) => {
      console.error(label, error);
    }),
  );
};

const createChatRunTiming = (input?: ChatRunTimingInput) => {
  const startedAtMs = input?.facadeEnteredAtMs ?? Date.now();
  const stageMarks: Record<string, number> = {
    facadeEntered: 0,
  };
  let providerStartedAtMs: number | null = null;
  let providerCompletedAtMs: number | null = null;
  let firstTokenMs: number | undefined;
  let firstMessageChunkEmitted = false;

  const elapsed = (value = Date.now()) => Math.max(0, value - startedAtMs);
  const mark = (stage: string, atMs = Date.now()) => {
    stageMarks[stage] = elapsed(atMs);
    return stageMarks[stage];
  };

  if (input?.bodyReadAtMs) mark("bodyRead", input.bodyReadAtMs);

  return {
    mark,
    markProviderStarted() {
      providerStartedAtMs = Date.now();
      mark("openRouterRequestStarted", providerStartedAtMs);
    },
    markProviderCompleted() {
      if (providerCompletedAtMs !== null) return;
      providerCompletedAtMs = Date.now();
      mark("openRouterStreamCompleted", providerCompletedAtMs);
    },
    markFirstToken() {
      if (firstTokenMs !== undefined) return;
      firstTokenMs = mark("firstProviderChunk");
    },
    markFirstMessageChunkEmitted() {
      if (firstMessageChunkEmitted) return;
      firstMessageChunkEmitted = true;
      mark("firstMessageChunkEmitted");
    },
    snapshot(): ChatRunTimingSnapshot {
      const now = Date.now();
      const providerEnd = providerCompletedAtMs ?? now;
      return {
        preStreamMs: stageMarks.streamResponsePrepared,
        firstTokenMs,
        providerMs:
          providerStartedAtMs === null ? undefined : Math.max(0, providerEnd - providerStartedAtMs),
        totalMs: elapsed(now),
        stageMarks: { ...stageMarks },
      };
    },
  };
};

const truncate = (value: string, max = 1200) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const safeTrace = (promise: Promise<unknown> | undefined, label: string) => {
  if (!promise) return;
  void promise.catch((error) => {
    console.error(label, error);
  });
};

const finishRuntimeTrace = (
  env: Env,
  identity: AgentIdentity,
  trace: RuntimeTraceContext | null,
  input: Parameters<typeof finishTrace>[3],
) => {
  if (!trace) return;
  safeTrace(finishTrace(env, identity, trace, input), "Failed to finish runtime trace");
};

const asTextContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const toStoredMessage = (value: unknown): StoredMessage | null => {
  if (!isRecord(value)) return null;
  const rawType = typeof value.type === "string" ? value.type : value.role;
  const type =
    rawType === "human" || rawType === "user"
      ? "human"
      : rawType === "ai" || rawType === "assistant"
        ? "ai"
        : rawType === "system"
          ? "system"
          : null;
  const content = asTextContent(value.content);
  if (!type || !content) return null;
  const id = typeof value.id === "string" ? value.id : createId(`cf-msg-${type}`);
  return { id, type, content };
};

const dedupeMessages = (messages: StoredMessage[]) => {
  const seen = new Set<string>();
  const result: StoredMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result;
};

const messagesFromThread = (thread: ChatThreadRow) => {
  const upstream = parseDataJson(thread.upstream_json);
  const rawMessages = Array.isArray(upstream.messages) ? upstream.messages : [];
  return rawMessages.map(toStoredMessage).filter((message) => message !== null);
};

const conversationMessages = (messages: StoredMessage[]) =>
  messages.filter((message) => message.type !== "system");

const threadUpstream = (input: {
  source: string;
  runtime: string;
  messages: StoredMessage[];
  model?: string;
  runtimeConfig?: AgentRuntimeConfig;
  behaviorConfig?: AgentBehaviorConfig;
  updatedAt?: string;
}) => ({
  source: input.source,
  runtime: input.runtime,
  modelProvider,
  model: input.model,
  runtimeConfig: input.runtimeConfig,
  behaviorConfig: input.behaviorConfig,
  messages: input.messages,
  updatedAt: input.updatedAt ?? new Date().toISOString(),
});

const messagesWithBehavior = (
  behaviorConfig: AgentBehaviorConfig,
  behaviorInstruction: string,
  messages: StoredMessage[],
) => [
  {
    id: `cf-system-${behaviorConfig.instructionId}`,
    type: "system" as const,
    content: behaviorInstruction,
  },
  ...conversationMessages(messages),
];

const openRouterMessages = (messages: StoredMessage[]) =>
  messages.map((message) => ({
    role: message.type === "human" ? "user" : message.type === "ai" ? "assistant" : message.type,
    content: message.content,
  }));

const extractInputMessages = (body: unknown) => {
  if (!isRecord(body) || !isRecord(body.input) || !Array.isArray(body.input.messages)) return [];
  return body.input.messages.map(toStoredMessage).filter((message) => message !== null);
};

const openRouterHeaders = (env: Env) => ({
  authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ""}`,
  "content-type": "application/json",
  "http-referer": env.OPENROUTER_SITE_URL ?? "https://assistant-mk1.vercel.app",
  "x-title": env.OPENROUTER_APP_NAME ?? "operloom-cloudflare-chat",
});

const readOpenRouterError = async (response: Response) => {
  const text = await response.text().catch(() => "");
  const parsed = parseJson(text);
  const message =
    isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
      ? parsed.error.message
      : text || `${response.status} ${response.statusText}`;
  return `${response.status} ${response.statusText}: ${truncate(message)}`;
};

const parseOpenRouterChunk = (block: string) => {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data || data === "[DONE]") return { done: data === "[DONE]", content: "" };

  const parsed = parseJson(data);
  const choice =
    isRecord(parsed) && Array.isArray(parsed.choices) && isRecord(parsed.choices[0])
      ? parsed.choices[0]
      : null;
  const delta = isRecord(choice?.delta) ? choice.delta : null;
  return {
    done: false,
    content: typeof delta?.content === "string" ? delta.content : "",
  };
};

export const handleCloudflareCreateThread = async (
  env: Env,
  identity: AgentIdentity,
  incomingTrace?: IncomingRuntimeTrace,
) => {
  const trace = await startTrace(env, identity, {
    traceId: incomingTrace?.traceId,
    kind: "chat.thread.create",
    rootName: "Create chat thread",
    summary: "Create a fresh Cloudflare-owned chat thread.",
    startedAtMs: incomingTrace?.authzStartedAtMs,
    data: { runtime: "cloudflare-simple-chat" },
  });
  await recordIncomingRequestSpans(env, identity, trace, incomingTrace);

  try {
    const resolveStartedAtMs = Date.now();
    const activeAgent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
    const runtimeConfig = resolveAgentRuntimeConfig(env, activeAgent);
    const behaviorConfig = resolveAgentBehaviorConfig(activeAgent);
    const agentMetadata = toAgentRuntimeMetadata(env, activeAgent, identity.agentId);
    const existingSession = await getLatestChatSession(env, identity.scope);
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Agent and session resolve",
      layer: "d1",
      startedAtMs: resolveStartedAtMs,
      data: {
        agentId: identity.agentId,
        reusedSession: Boolean(existingSession && existingSession.agent_id === identity.agentId),
      },
    });

    const createdSession = !existingSession || existingSession.agent_id !== identity.agentId;
    const sessionStartedAtMs = Date.now();
    const sessionId =
      !createdSession && existingSession
        ? existingSession.session_id
        : await createChatSession(env, identity, {
            source: "cloudflare-chat-runtime",
            agent: agentMetadata,
          });

    if (createdSession) {
      await appendControlPlaneEvent(env, identity, {
        type: "chat.session.created",
        summary: "Created Cloudflare-owned chat session.",
        targetType: "chat_session",
        targetId: sessionId,
        data: { source: "cloudflare-chat-runtime", agent: agentMetadata },
      });
    }
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Session write",
      layer: "d1",
      startedAtMs: sessionStartedAtMs,
      data: { createdSession, sessionId },
    });

    const threadId = createId("cf-thread");
    const threadStartedAtMs = Date.now();
    await storeChatThread(
      env,
      identity,
      sessionId,
      threadId,
      threadUpstream({
        source: "cloudflare-chat-runtime",
        runtime: "cloudflare-simple-chat",
        messages: [],
        model: runtimeConfig.model,
        runtimeConfig,
        behaviorConfig,
      }),
    );
    await touchChatSession(env, identity.scope, sessionId, threadId);
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Thread ownership write",
      layer: "d1",
      startedAtMs: threadStartedAtMs,
      data: { threadId, sessionId },
    });

    const eventStartedAtMs = Date.now();
    await appendControlPlaneEvent(env, identity, {
      type: "chat.thread.created",
      summary: "Created Cloudflare-owned chat thread.",
      targetType: "chat_thread",
      targetId: threadId,
      data: { sessionId, source: "cloudflare-chat-runtime", agent: agentMetadata },
    });
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Thread event write",
      layer: "d1",
      startedAtMs: eventStartedAtMs,
      data: { targetType: "chat_thread" },
    });

    await finishTrace(env, identity, trace, {
      status: "completed",
      summary: "Chat thread created.",
      data: { threadId, sessionId, runtime: "cloudflare-simple-chat" },
    });

    return json(
      {
        thread_id: threadId,
        created_at: new Date().toISOString(),
        metadata: { source: "cloudflare-chat-runtime", traceId: trace.traceId },
        status: "idle",
      },
      { status: 201 },
    );
  } catch (error) {
    await finishTrace(env, identity, trace, {
      status: "failed",
      summary: "Chat thread creation failed.",
      data: { error: error instanceof Error ? truncate(error.message) : "Unknown error" },
    });
    throw error;
  }
};

export const handleCloudflareThreadState = async (thread: ChatThreadRow) =>
  json({
    values: {
      messages: messagesFromThread(thread),
    },
    tasks: [],
    metadata: {
      thread_id: thread.thread_id,
      source: "cloudflare-chat-runtime",
    },
  });

export const handleCloudflareRunStream = async (
  env: Env,
  identity: AgentIdentity,
  thread: ChatThreadRow,
  bodyText: string,
  ctx?: WorkerExecutionContext,
  timingInput?: ChatRunTimingInput,
  incomingTrace?: IncomingRuntimeTrace,
) => {
  const trace = await startTrace(env, identity, {
    traceId: incomingTrace?.traceId,
    kind: "chat.run.stream",
    rootName: "Stream chat response",
    summary: "Run Cloudflare simple chat and stream provider output.",
    startedAtMs: incomingTrace?.authzStartedAtMs ?? timingInput?.facadeEnteredAtMs,
    data: {
      runtime: "cloudflare-simple-chat",
      threadId: thread.thread_id,
      sessionId: thread.session_id,
    },
  });
  await recordIncomingRequestSpans(env, identity, trace, incomingTrace);
  const timing = createChatRunTiming(timingInput);
  timing.mark("runStreamHandlerEntered");
  const bodyParseStartedAtMs = Date.now();
  const parsedBody = parseJson(bodyText);
  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Body parse",
    layer: "cloudflare",
    startedAtMs: bodyParseStartedAtMs,
    data: { bodyBytes: bodyText.length },
  });
  const { executionMode, invalidExecutionMode, requestedExecutionMode } =
    deriveChatExecutionMode(parsedBody);
  const runSetupStartedAtMs = Date.now();
  const runningRun = await getLatestRunningChatRun(env, identity.scope, thread.thread_id);
  const policy = evaluateChatRunPolicy({
    executionMode,
    invalidExecutionMode,
    runningRun,
  });
  const requestedAssistantId = isRecord(parsedBody) ? parsedBody.assistant_id : undefined;
  const activeAgent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const runtimeConfig = resolveAgentRuntimeConfig(env, activeAgent);
  const behaviorConfig = resolveAgentBehaviorConfig(activeAgent);
  const behaviorInstruction = resolveAgentBehaviorInstruction(activeAgent);
  const agentMetadata = toAgentRuntimeMetadata(env, activeAgent, identity.agentId);
  const inputMessages = extractInputMessages(parsedBody);
  const existingMessages = messagesFromThread(thread);
  const nextMessages = dedupeMessages(
    conversationMessages([...existingMessages, ...inputMessages]),
  );
  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Runtime config and policy inputs",
    layer: "d1",
    startedAtMs: runSetupStartedAtMs,
    data: {
      executionMode,
      runningRunId: runningRun?.id ?? null,
      model: runtimeConfig.model,
      behaviorTemplateId: behaviorConfig.templateId,
    },
  });
  const recordsStartedAtMs = Date.now();
  const intentPayload = {
    assistantId: requestedAssistantId,
    bodyBytes: bodyText.length,
    messageCount: inputMessages.length,
    requestedExecutionMode,
    runtime: "cloudflare-simple-chat",
    agent: agentMetadata,
    runtimeConfig,
    behaviorConfig,
  };
  const limitsFor = (currentPolicy: typeof policy) => ({
    sameThreadConcurrency: 1,
    errorCode: currentPolicy.errorCode,
    retryable: currentPolicy.retryable,
  });
  const publishIntentAndPolicyEvents = (
    intentId: string,
    policyDecisionId: string,
    currentPolicy: typeof policy,
  ) => {
    void safeWaitUntil(
      ctx,
      appendControlPlaneEvent(env, identity, {
        type: "chat.intent.created",
        summary: "Created Cloudflare-owned chat response intent.",
        targetType: "chat_intent",
        targetId: intentId,
        data: {
          threadId: thread.thread_id,
          sessionId: thread.session_id,
          executionMode,
          status: currentPolicy.decision,
          runtime: "cloudflare-simple-chat",
          agent: agentMetadata,
          runtimeConfig,
          behaviorConfig,
          timings: timing.snapshot(),
        },
      }),
      "Failed to append chat intent event",
    );
    void safeWaitUntil(
      ctx,
      appendControlPlaneEvent(env, identity, {
        type: currentPolicy.decision === "allow" ? "chat.policy.allowed" : "chat.policy.blocked",
        summary: currentPolicy.reason,
        targetType: "chat_policy_decision",
        targetId: policyDecisionId,
        data: {
          threadId: thread.thread_id,
          intentId,
          executionMode,
          agent: agentMetadata,
          runtimeConfig,
          behaviorConfig,
          timings: timing.snapshot(),
        },
      }),
      "Failed to append chat policy event",
    );
  };

  if (policy.decision === "block") {
    const intentId = await createChatIntent(env, identity, {
      sessionId: thread.session_id,
      threadId: thread.thread_id,
      executionMode,
      status: "blocked",
      payload: intentPayload,
    });
    timing.mark("intentCreated");
    const policyDecisionId = await createChatPolicyDecision(env, identity, {
      intentId,
      threadId: thread.thread_id,
      decision: "block",
      reason: policy.reason,
      executionMode,
      limits: limitsFor(policy),
    });
    timing.mark("policyDecisionCreated");
    publishIntentAndPolicyEvents(intentId, policyDecisionId, policy);
    timing.mark("policyBlocked");
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Intent/policy writes",
      layer: "d1",
      startedAtMs: recordsStartedAtMs,
      status: "blocked",
      data: { intentId, policyDecisionId, reason: policy.reason },
    });
    await finishTrace(env, identity, trace, {
      status: "blocked",
      summary: policy.reason,
      data: {
        threadId: thread.thread_id,
        intentId,
        policyDecisionId,
        errorCode: policy.errorCode ?? "policy_blocked",
      },
    });
    return json(
      {
        ok: false,
        error: policy.reason,
        errorCode: policy.errorCode ?? "policy_blocked",
        retryable: policy.retryable ?? false,
        intentId,
        policyDecisionId,
        decision: policy.decision,
      },
      { status: policy.status },
    );
  }

  let boundary: { intentId: string; policyDecisionId: string; runId: string };
  try {
    boundary = await createAllowedChatRunBoundary(env, identity, {
      sessionId: thread.session_id,
      threadId: thread.thread_id,
      executionMode,
      payload: intentPayload,
      reason: policy.reason,
      limits: limitsFor(policy),
      metadata: {
        executionMode,
        runtime: "cloudflare-simple-chat",
        modelProvider: runtimeConfig.provider,
        model: runtimeConfig.model,
        runtimeConfig,
        behaviorConfig,
        agent: agentMetadata,
        timings: timing.snapshot(),
      },
    });
  } catch (error) {
    if (!isChatRunClaimConflict(error)) throw error;
    const claimPolicy = runningChatRunPolicy(executionMode);
    const intentId = await createChatIntent(env, identity, {
      sessionId: thread.session_id,
      threadId: thread.thread_id,
      executionMode,
      status: "blocked",
      payload: intentPayload,
    });
    const policyDecisionId = await createChatPolicyDecision(env, identity, {
      intentId,
      threadId: thread.thread_id,
      decision: "block",
      reason: claimPolicy.reason,
      executionMode,
      limits: limitsFor(claimPolicy),
    });
    timing.mark("intentCreated");
    timing.mark("policyDecisionCreated");
    publishIntentAndPolicyEvents(intentId, policyDecisionId, claimPolicy);
    timing.mark("policyBlocked");
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Atomic chat run claim",
      layer: "d1",
      startedAtMs: recordsStartedAtMs,
      status: "blocked",
      data: { intentId, policyDecisionId, reason: claimPolicy.reason },
    });
    await finishTrace(env, identity, trace, {
      status: "blocked",
      summary: claimPolicy.reason,
      data: {
        threadId: thread.thread_id,
        intentId,
        policyDecisionId,
        errorCode: claimPolicy.errorCode,
      },
    });
    return json(
      {
        ok: false,
        error: claimPolicy.reason,
        errorCode: claimPolicy.errorCode,
        retryable: claimPolicy.retryable,
        intentId,
        policyDecisionId,
        decision: claimPolicy.decision,
      },
      { status: claimPolicy.status },
    );
  }
  const { intentId, policyDecisionId, runId } = boundary;
  timing.mark("intentCreated");
  timing.mark("policyDecisionCreated");
  timing.mark("runCreated");
  publishIntentAndPolicyEvents(intentId, policyDecisionId, policy);
  await updateChatThreadUpstream(
    env,
    identity.scope,
    thread.thread_id,
    threadUpstream({
      source: "cloudflare-chat-runtime",
      runtime: "cloudflare-simple-chat",
      messages: nextMessages,
      model: runtimeConfig.model,
      runtimeConfig,
      behaviorConfig,
    }),
  );
  timing.mark("threadInputStored");
  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Intent/policy/run writes",
    layer: "d1",
    startedAtMs: recordsStartedAtMs,
    data: { intentId, policyDecisionId, runId, threadId: thread.thread_id },
  });
  void safeWaitUntil(
    ctx,
    appendControlPlaneEvent(env, identity, {
      type: "chat.run.started",
      summary: "Started Cloudflare-owned simple chat run.",
      targetType: "chat_run",
      targetId: runId,
      data: {
        threadId: thread.thread_id,
        intentId,
        policyDecisionId,
        executionMode,
        runtime: "cloudflare-simple-chat",
        agent: agentMetadata,
        runtimeConfig,
        behaviorConfig,
        timings: timing.snapshot(),
      },
    }),
    "Failed to append chat run started event",
  );

  if (requestedAssistantId !== "agent") {
    const error = "This assistant runtime is not available for Cloudflare simple chat.";
    timing.mark("unsupportedAssistantRejected");
    const rejectionStartedAtMs = Date.now();
    await updateChatRun(env, {
      runId,
      scope: identity.scope,
      status: "failed",
      metadata: {
        runtime: "cloudflare-simple-chat",
        errorCode: "unsupported_assistant",
        retryable: false,
        requestedAssistantId,
        timings: timing.snapshot(),
      },
      error,
    });
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Unsupported assistant rejection",
      layer: "cloudflare",
      startedAtMs: rejectionStartedAtMs,
      status: "failed",
      data: { requestedAssistantId, errorCode: "unsupported_assistant" },
    });
    await finishTrace(env, identity, trace, {
      status: "failed",
      summary: error,
      data: { threadId: thread.thread_id, runId, errorCode: "unsupported_assistant" },
    });
    void safeWaitUntil(
      ctx,
      appendControlPlaneEvent(env, identity, {
        type: "chat.run.failed",
        summary: "Cloudflare simple chat rejected an unsupported assistant id.",
        targetType: "chat_run",
        targetId: runId,
        data: {
          threadId: thread.thread_id,
          error,
          errorCode: "unsupported_assistant",
          retryable: false,
          requestedAssistantId,
          timings: timing.snapshot(),
        },
      }),
      "Failed to append unsupported assistant event",
    );
    return json(
      { ok: false, error, errorCode: "unsupported_assistant", retryable: false },
      { status: 422 },
    );
  }

  if (!env.OPENROUTER_API_KEY) {
    const error = "Chat model is not configured for Cloudflare simple chat.";
    timing.mark("missingModelSecretRejected");
    const rejectionStartedAtMs = Date.now();
    await updateChatRun(env, {
      runId,
      scope: identity.scope,
      status: "failed",
      metadata: {
        runtime: "cloudflare-simple-chat",
        errorCode: "missing_model_secret",
        retryable: false,
        timings: timing.snapshot(),
      },
      error,
    });
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Missing model secret rejection",
      layer: "cloudflare",
      startedAtMs: rejectionStartedAtMs,
      status: "failed",
      data: { errorCode: "missing_model_secret" },
    });
    await finishTrace(env, identity, trace, {
      status: "failed",
      summary: error,
      data: { threadId: thread.thread_id, runId, errorCode: "missing_model_secret" },
    });
    void safeWaitUntil(
      ctx,
      appendControlPlaneEvent(env, identity, {
        type: "chat.run.failed",
        summary: "Cloudflare simple chat model secret is missing.",
        targetType: "chat_run",
        targetId: runId,
        data: {
          threadId: thread.thread_id,
          error,
          errorCode: "missing_model_secret",
          retryable: false,
          timings: timing.snapshot(),
        },
      }),
      "Failed to append missing model secret event",
    );
    return json(
      { ok: false, error, errorCode: "missing_model_secret", retryable: false },
      { status: 500 },
    );
  }

  const model = runtimeConfig.model;
  timing.mark("streamResponsePrepared");
  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Pre-stream total",
    layer: "cloudflare",
    spanType: "phase",
    isAggregate: true,
    bottleneckCandidate: false,
    startedAtMs: trace.startedAtMs,
    data: {
      runId,
      threadId: thread.thread_id,
      model,
      note: "Overlapping phase summary from trace start through stream response preparation.",
    },
  });
  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        timing.mark("streamStarted");
        let assistantText = "";
        const assistantMessageId = createId("cf-ai");
        const metadata = {
          thread_id: thread.thread_id,
          run_id: runId,
          runtime: "cloudflare-simple-chat",
          model_provider: runtimeConfig.provider,
          ls_model_name: model,
          runtime_config: runtimeConfig,
          behavior_config: behaviorConfig,
          langgraph_node: "cloudflare-simple-chat",
          agent: agentMetadata,
        };

        try {
          controller.enqueue(sse("metadata", metadata));
          timing.mark("metadataEmitted");
          timing.markProviderStarted();
          const providerStartedAtMs = Date.now();
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: openRouterHeaders(env),
            body: JSON.stringify({
              model,
              temperature: runtimeConfig.temperature,
              max_tokens: runtimeConfig.maxTokens,
              stream: true,
              messages: openRouterMessages(
                messagesWithBehavior(behaviorConfig, behaviorInstruction, nextMessages),
              ),
            }),
          });

          if (!response.ok || !response.body) {
            const detail = await readOpenRouterError(response);
            throw new ChatRuntimeError(
              "The response failed. Try again or start a new chat.",
              "upstream_failed",
              true,
              detail,
            );
          }
          timing.mark("openRouterResponseReceived");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let firstTokenAtMs: number | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";

            for (const block of blocks) {
              const parsed = parseOpenRouterChunk(block);
              if (parsed.done) break;
              if (!parsed.content) continue;
              timing.markFirstToken();
              if (firstTokenAtMs === null) {
                firstTokenAtMs = Date.now();
                await recordSpan(env, identity, {
                  traceId: trace.traceId,
                  name: "OpenRouter first token",
                  layer: "provider",
                  startedAtMs: providerStartedAtMs,
                  endedAtMs: firstTokenAtMs,
                  data: { model },
                });
              }
              assistantText += parsed.content;
              controller.enqueue(
                sse("messages", [
                  {
                    id: assistantMessageId,
                    content: parsed.content,
                    additional_kwargs: {},
                    response_metadata: { model_name: model },
                    type: "AIMessageChunk",
                    name: null,
                    tool_calls: [],
                    invalid_tool_calls: [],
                    tool_call_chunks: [],
                  },
                  metadata,
                ]),
              );
              timing.markFirstMessageChunkEmitted();
            }
          }
          timing.markProviderCompleted();
          const providerCompletedAtMs = Date.now();
          await recordSpan(env, identity, {
            traceId: trace.traceId,
            name: "Stream duration",
            layer: "provider",
            startedAtMs: firstTokenAtMs ?? providerStartedAtMs,
            endedAtMs: providerCompletedAtMs,
            data: { model, outputChars: assistantText.length },
          });

          const finalMessages = dedupeMessages([
            ...nextMessages,
            {
              id: assistantMessageId,
              type: "ai",
              content: assistantText,
              response_metadata: { model_name: model },
            },
          ]);
          const postStreamStartedAtMs = Date.now();
          timing.mark("runCompleted");
          const completion = await updateChatRun(env, {
            runId,
            scope: identity.scope,
            status: "completed",
            metadata: {
              ...metadata,
              outputChars: assistantText.length,
              timings: timing.snapshot(),
            },
          });
          if (!completion.updated) {
            controller.close();
            return;
          }
          await updateChatThreadUpstream(
            env,
            identity.scope,
            thread.thread_id,
            threadUpstream({
              source: "cloudflare-chat-runtime",
              runtime: "cloudflare-simple-chat",
              messages: finalMessages,
              model,
              runtimeConfig,
              behaviorConfig,
            }),
          );
          timing.mark("threadOutputStored");
          await recordSpan(env, identity, {
            traceId: trace.traceId,
            name: "Post-stream D1 writes",
            layer: "d1",
            startedAtMs: postStreamStartedAtMs,
            data: { runId, outputChars: assistantText.length },
          });
          void safeWaitUntil(
            ctx,
            appendControlPlaneEvent(env, identity, {
              type: "chat.run.completed",
              summary: "Cloudflare-owned simple chat run completed.",
              targetType: "chat_run",
              targetId: runId,
              data: {
                threadId: thread.thread_id,
                runId,
                runtime: "cloudflare-simple-chat",
                timings: timing.snapshot(),
              },
            }),
            "Failed to append chat run completed event",
          );
          finishRuntimeTrace(env, identity, trace, {
            status: "completed",
            summary: "Chat response completed.",
            data: {
              threadId: thread.thread_id,
              runId,
              runtime: "cloudflare-simple-chat",
              model,
              outputChars: assistantText.length,
            },
          });
          controller.close();
        } catch (error) {
          timing.markProviderCompleted();
          const runtimeError =
            error instanceof ChatRuntimeError
              ? error
              : new ChatRuntimeError(
                  "The response failed. Try again or start a new chat.",
                  "runtime_failed",
                  true,
                  error instanceof Error ? error.message : undefined,
                );
          const message = runtimeError.message;
          timing.mark("runFailed");
          const failureStartedAtMs = Date.now();
          const failure = await updateChatRun(env, {
            runId,
            scope: identity.scope,
            status: "failed",
            metadata: {
              ...metadata,
              outputChars: assistantText.length,
              errorCode: runtimeError.errorCode,
              retryable: runtimeError.retryable,
              errorDetail: runtimeError.detail,
              timings: timing.snapshot(),
            },
            error: truncate(message),
          });
          if (!failure.updated) {
            controller.close();
            return;
          }
          await recordSpan(env, identity, {
            traceId: trace.traceId,
            name: "Run failure write",
            layer: "d1",
            startedAtMs: failureStartedAtMs,
            status: "failed",
            data: {
              runId,
              errorCode: runtimeError.errorCode,
              retryable: runtimeError.retryable,
            },
          });
          void safeWaitUntil(
            ctx,
            appendControlPlaneEvent(env, identity, {
              type: "chat.run.failed",
              summary: "Cloudflare-owned simple chat run failed.",
              targetType: "chat_run",
              targetId: runId,
              data: {
                threadId: thread.thread_id,
                error: truncate(message),
                errorCode: runtimeError.errorCode,
                retryable: runtimeError.retryable,
                errorDetail: runtimeError.detail,
                timings: timing.snapshot(),
              },
            }),
            "Failed to append chat run failed event",
          );
          controller.enqueue(
            sse("error", {
              message: truncate(message),
              errorCode: runtimeError.errorCode,
              retryable: runtimeError.retryable,
            }),
          );
          finishRuntimeTrace(env, identity, trace, {
            status: "failed",
            summary: truncate(message),
            data: {
              threadId: thread.thread_id,
              runId,
              runtime: "cloudflare-simple-chat",
              model,
              errorCode: runtimeError.errorCode,
              retryable: runtimeError.retryable,
            },
          });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...sseHeaders,
      "content-location": `/threads/${thread.thread_id}/runs/${runId}`,
    },
  });
};
