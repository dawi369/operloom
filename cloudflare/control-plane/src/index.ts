import * as Sentry from "@sentry/cloudflare";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "../../../lib/observability/sentry-scrubber";
import { routeAgentRequest } from "agents";
import { handleWorkflowCallback } from "./workflow-callbacks";
import { handleAdminWorkspaceSummary } from "./admin-summary";
import {
  handleApproveToolApproval,
  handleDenyToolApproval,
  handleListToolApprovals,
  handleListTools,
  handleRunTool,
  handleUpdateToolPolicy,
} from "./admin-tools";
import {
  handleActivateAgent,
  handleCreateAgent,
  handleInstantiateAgentPack,
  handleListAgentBehaviorTemplates,
  handleListAgents,
} from "./agents";
import { handleChatRuntimeSummary } from "./chat-runtime-summary";
import {
  handleActivateChatSessionThread,
  handleChatSession,
  handleChatSessionStream,
  handleCreateChatSessionThread,
  handleStageChatSessionThread,
  handleListChatSessionThreads,
  handleMaterializeChatSessionTurn,
  handleSwitchChatSessionAgent,
  handleUpdateChatSessionThread,
} from "./chat-session";
import { handleGetChatThread, handleListChatThreads } from "./chat-threads";
import {
  handleControlPlaneEvents,
  handleControlPlaneEventStream,
  handleLatestControlPlaneEvents,
} from "./control-plane-events";
import { corsHeadersForRequest, withCors } from "./cors";
import {
  handleChatBoundarySnapshot,
  handleCreateChatSession,
  handleGetChatSession,
  handleLangGraphFacade,
  handleLatestChatSession,
} from "./langgraph-facade";
import { executeRuntimeWorkflow, runtimeWorkflowTypeForPath } from "./pack-workflow-runtime";
import { listRuntimeWorkflows } from "./runtime-workflows";
import {
  getTraceId,
  handleGetRuntimeTrace,
  handleLatestRuntimeTraces,
  readVercelTimingHeaders,
} from "./runtime-traces";
import { handleWorkspaceContext } from "./workspace-context";
import {
  expireDataExports,
  handleCreateWorkspaceExport,
  handleDownloadWorkspaceExport,
  handleGetWorkspaceDataJob,
  handleGetWorkspaceDeletion,
  handleOperatorRetryWorkspaceDeletion,
  handleRecoverWorkspace,
  handleRetryWorkspaceDeletion,
  handleRequestWorkspaceDeletion,
  handleWorkspaceDeletionPlan,
  processDataLifecycleJobs,
  retryQuarantinedCredentialRevocations,
} from "./workspace-data-lifecycle";
import {
  handleCreateArtifactBlob,
  handleGetArtifactBlob,
  handleGetRetentionPolicy,
  handleUpdateRetentionPolicy,
  sweepExpiredArtifacts,
  sweepExpiredChatMessages,
  sweepExpiredOperationalData,
} from "./artifact-lifecycle";
import { handleCancelExecutionRun, handleRetryExecutionRun } from "./run-control";
import {
  getExecutionHistoryRun,
  listArtifactHistory,
  listExecutionHistory,
} from "./workbench-history";
import { handleActivateWorkspace, handleCreateWorkspace, handleListWorkspaces } from "./workspaces";
import {
  handleAddWorkspaceMember,
  handleListWorkspaceMembers,
  handleUpdateWorkspaceMember,
} from "./workspace-members";
import { resolveAgentIdentity } from "./authz";
import { internalErrorResponse, json, requireControlPlaneAuth } from "./http";
import type { Env, WorkerExecutionContext, WorkerScheduledController } from "./types";
import { WorkbenchThreadChatAgent } from "./thread-chat-agent";
import { WorkbenchSessionAgent } from "./session-agent";
import { handleGetManagedState, handleListManagedState } from "./managed-state";
import { runTriggerSchedulerTick } from "./trigger-scheduler";
import { agentControlPlaneRegistry } from "../../../generated/agent-runtime/control-plane";
import {
  deliverPendingOperatorAlerts,
  handleListOperatorAlerts,
  handleRetryOperatorAlertDelivery,
  handleUpdateOperatorAlert,
} from "./operator-alerts";
import { handleTriggerWebhookIngress } from "./trigger-webhook";
import {
  handleCreateTrigger,
  handleCreateTriggerDispatch,
  handleGetTrigger,
  handleGetTriggerDispatch,
  handleListTriggerDispatches,
  handleListTriggers,
  handleReplayTriggerDispatch,
  handleUpdateTrigger,
} from "./triggers";
import {
  expireConnectionOAuthStates,
  handleCompleteConnectionAuthorization,
  handleConnectionHealth,
  handleListConnections,
  handleRedeemConnectionCapability,
  handleRefreshConnection,
  handleRevokeConnection,
  handleStartConnectionAuthorization,
  handleStoreConnectionCredential,
} from "./connection-broker";
import {
  handleListActionProposals,
  handleListKillSwitches,
  handleReconcileAction,
  handleRequestActionExecution,
  handleUpdateKillSwitch,
} from "./action-authority";
import { releaseFeatureConfigurationValid } from "./feature-gates";
import { connectionProviderRegistry } from "./connection-providers";
import { compiledWorkbenchVersion } from "../../../generated/agent-runtime/platform";
import {
  handleListClientDevices,
  handleNotificationPreferences,
  handleRegisterClientDevice,
  handleRevokeClientDevice,
  processNotificationQueue,
  sweepNotificationDeliveries,
} from "./notification-delivery";
import type { MessageBatch, NotificationQueueMessage } from "./types";

export { WorkbenchThreadChatAgent };
export { WorkbenchSessionAgent };

const isCloudflareAgentSdkPath = (pathname: string) => {
  if (pathname === "/agents" || /^\/agents\/[^/]+\/activate$/.test(pathname)) return false;
  return pathname.startsWith("/agents/") || pathname.startsWith("/agents_");
};

const handleRequest = async (request: Request, env: Env, ctx: WorkerExecutionContext) => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health/live") {
    return json({
      ok: true,
      service: "operloom-control-plane",
      version: compiledWorkbenchVersion,
      release: env.WORKBENCH_RELEASE_SHA ?? "development",
    });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    try {
      const database = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (
        database?.ok !== 1 ||
        !env.ARTIFACTS ||
        !env.WorkbenchThreadChatAgent ||
        !env.WorkbenchSessionAgent ||
        !releaseFeatureConfigurationValid(env)
      ) {
        return json({ ok: false, service: "operloom-control-plane" }, { status: 503 });
      }
      connectionProviderRegistry(env);
      const runtimeChecks = await Promise.all(
        Object.values(agentControlPlaneRegistry)
          .filter((entry) => !entry.conformanceOnly)
          .flatMap((entry) =>
            entry.module.health
              .filter((check) => check.required)
              .map(async (check) => {
                try {
                  return await check.check();
                } catch {
                  return { ok: false, summary: "Runtime health check failed." };
                }
              }),
          ),
      );
      if (runtimeChecks.some((check) => !check.ok)) {
        return json({ ok: false, service: "operloom-control-plane" }, { status: 503 });
      }
      return json({
        ok: true,
        service: "operloom-control-plane",
        version: compiledWorkbenchVersion,
        storage: "d1",
        release: env.WORKBENCH_RELEASE_SHA ?? "development",
      });
    } catch {
      return json({ ok: false, service: "operloom-control-plane" }, { status: 503 });
    }
  }

  if (isCloudflareAgentSdkPath(url.pathname)) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersForRequest(request, env) });
    }
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return withCors(agentResponse, request, env);
    return withCors(
      json({ ok: false, error: "Agent route not found" }, { status: 404 }),
      request,
      env,
    );
  }

  if (request.method === "POST" && url.pathname === "/workbench/run-callbacks") {
    return handleWorkflowCallback(request, env);
  }

  if (request.method === "POST" && url.pathname === "/workbench/connection-capabilities/redeem") {
    return handleRedeemConnectionCapability(request, env);
  }

  const triggerIngressMatch = url.pathname.match(/^\/trigger-ingress\/([^/]+)$/);
  if (request.method === "POST" && triggerIngressMatch?.[1]) {
    const authResult = await requireControlPlaneAuth(request, env);
    if (!authResult.ok) return authResult.response;
    return handleTriggerWebhookIngress(
      request,
      env,
      decodeURIComponent(triggerIngressMatch[1]),
      ctx,
    );
  }

  const authResult = await requireControlPlaneAuth(request, env);
  if (!authResult.ok) return authResult.response;

  if (request.method === "GET" && url.pathname === "/health/facade") {
    return json({
      ok: true,
      service: "operloom-control-plane-facade",
      version: compiledWorkbenchVersion,
      release: env.WORKBENCH_RELEASE_SHA ?? "development",
    });
  }

  const authzStartedAtMs = Date.now();
  const deletionRecoveryRoute =
    (url.pathname === "/workbench/workspace-deletion" &&
      (request.method === "GET" || request.method === "DELETE")) ||
    (url.pathname === "/workbench/workspace-deletion/retry" && request.method === "POST");
  const exportObservationRoute =
    request.method === "GET" &&
    /^\/workbench\/data-exports\/[^/]+(?:\/download)?$/.test(url.pathname);
  const identityResult = await resolveAgentIdentity(request, env, authResult.context, {
    allowedInactiveWorkspaceStatuses: deletionRecoveryRoute
      ? ["quarantined", "purging", "failed"]
      : undefined,
    skipBootstrapWrites: exportObservationRoute,
  });
  const authzEndedAtMs = Date.now();
  if (!identityResult.ok) return identityResult.response;
  const { identity } = identityResult;
  const vercelTiming = readVercelTimingHeaders(request);
  const incomingTrace = {
    traceId: getTraceId(request),
    authzStartedAtMs,
    authzEndedAtMs,
    authzSpans: identityResult.authzSpans,
    vercelStartedAtMs: vercelTiming.startedAtMs,
    vercelDurationMs: vercelTiming.durationMs,
  };

  if (request.method === "GET" && url.pathname === "/workspace-context") {
    return handleWorkspaceContext(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/admin/workspace-summary") {
    return handleAdminWorkspaceSummary(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/admin/operator-alerts") {
    return handleListOperatorAlerts(env, identity, url);
  }

  const operatorPurgeRetryMatch = url.pathname.match(/^\/admin\/workspace-purges\/([^/]+)\/retry$/);
  if (request.method === "POST" && operatorPurgeRetryMatch?.[1]) {
    return handleOperatorRetryWorkspaceDeletion(
      request,
      env,
      identity,
      decodeURIComponent(operatorPurgeRetryMatch[1]),
      authResult.context.mode === "facade_signature",
    );
  }

  if (request.method === "GET" && url.pathname === "/workbench/data-deletion-plan") {
    return handleWorkspaceDeletionPlan(env, identity);
  }

  if (request.method === "POST" && url.pathname === "/workbench/data-exports") {
    return handleCreateWorkspaceExport(request, env, identity, (promise) => ctx.waitUntil(promise));
  }

  const dataExportDownloadMatch = url.pathname.match(
    /^\/workbench\/data-exports\/([^/]+)\/download$/,
  );
  if (request.method === "GET" && dataExportDownloadMatch?.[1]) {
    return handleDownloadWorkspaceExport(
      env,
      identity,
      decodeURIComponent(dataExportDownloadMatch[1]),
    );
  }

  const dataJobMatch = url.pathname.match(/^\/workbench\/data-exports\/([^/]+)$/);
  if (request.method === "GET" && dataJobMatch?.[1]) {
    return handleGetWorkspaceDataJob(env, identity, decodeURIComponent(dataJobMatch[1]));
  }

  if (url.pathname === "/workbench/workspace-deletion") {
    if (request.method === "POST") return handleRequestWorkspaceDeletion(request, env, identity);
    if (request.method === "GET") return handleGetWorkspaceDeletion(env, identity);
    if (request.method === "DELETE") return handleRecoverWorkspace(env, identity);
  }
  if (request.method === "POST" && url.pathname === "/workbench/workspace-deletion/retry") {
    return handleRetryWorkspaceDeletion(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/workbench/connections") {
    return handleListConnections(env, identity);
  }

  if (request.method === "POST" && url.pathname === "/workbench/connections/oauth/callback") {
    return handleCompleteConnectionAuthorization(request, env, identity);
  }

  const connectionAuthorizeMatch = url.pathname.match(
    /^\/workbench\/connections\/([^/]+)\/authorize$/,
  );
  if (request.method === "POST" && connectionAuthorizeMatch?.[1]) {
    return handleStartConnectionAuthorization(
      request,
      env,
      identity,
      decodeURIComponent(connectionAuthorizeMatch[1]),
    );
  }

  const connectionCredentialMatch = url.pathname.match(
    /^\/workbench\/connections\/([^/]+)\/credentials$/,
  );
  if (request.method === "POST" && connectionCredentialMatch?.[1]) {
    return handleStoreConnectionCredential(
      request,
      env,
      identity,
      decodeURIComponent(connectionCredentialMatch[1]),
    );
  }

  const connectionRefreshMatch = url.pathname.match(/^\/workbench\/connections\/([^/]+)\/refresh$/);
  if (request.method === "POST" && connectionRefreshMatch?.[1]) {
    return handleRefreshConnection(env, identity, decodeURIComponent(connectionRefreshMatch[1]));
  }

  const connectionHealthMatch = url.pathname.match(/^\/workbench\/connections\/([^/]+)\/health$/);
  if (request.method === "POST" && connectionHealthMatch?.[1]) {
    return handleConnectionHealth(env, identity, decodeURIComponent(connectionHealthMatch[1]));
  }

  const connectionMatch = url.pathname.match(/^\/workbench\/connections\/([^/]+)$/);
  if (request.method === "DELETE" && connectionMatch?.[1]) {
    return handleRevokeConnection(env, identity, decodeURIComponent(connectionMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/workbench/actions") {
    return handleListActionProposals(env, identity, url);
  }

  if (url.pathname === "/workbench/devices") {
    if (request.method === "GET") return handleListClientDevices(env, identity);
    if (request.method === "POST") return handleRegisterClientDevice(request, env, identity);
  }

  const clientDeviceMatch = url.pathname.match(/^\/workbench\/devices\/([^/]+)$/);
  if (request.method === "DELETE" && clientDeviceMatch?.[1]) {
    return handleRevokeClientDevice(env, identity, decodeURIComponent(clientDeviceMatch[1]));
  }

  if (
    url.pathname === "/workbench/notification-preferences" &&
    (request.method === "GET" || request.method === "PUT")
  ) {
    return handleNotificationPreferences(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/workbench/workflows") {
    return listRuntimeWorkflows(env, identity);
  }

  const actionExecuteMatch = url.pathname.match(/^\/workbench\/actions\/([^/]+)\/execute$/);
  if (request.method === "POST" && actionExecuteMatch?.[1]) {
    return handleRequestActionExecution(env, identity, decodeURIComponent(actionExecuteMatch[1]));
  }

  const actionReconcileMatch = url.pathname.match(/^\/workbench\/actions\/([^/]+)\/reconcile$/);
  if (request.method === "POST" && actionReconcileMatch?.[1]) {
    return handleReconcileAction(env, identity, decodeURIComponent(actionReconcileMatch[1]));
  }

  if (url.pathname === "/workbench/kill-switches") {
    if (request.method === "GET") return handleListKillSwitches(env, identity);
    if (request.method === "PUT") return handleUpdateKillSwitch(request, env, identity);
  }

  const operatorAlertMatch = url.pathname.match(/^\/admin\/operator-alerts\/([^/]+)$/);
  if (request.method === "PATCH" && operatorAlertMatch?.[1]) {
    return handleUpdateOperatorAlert(
      request,
      env,
      identity,
      decodeURIComponent(operatorAlertMatch[1]),
    );
  }

  const retryOperatorAlertMatch = url.pathname.match(
    /^\/admin\/operator-alerts\/([^/]+)\/retry-delivery$/,
  );
  if (request.method === "POST" && retryOperatorAlertMatch?.[1]) {
    return handleRetryOperatorAlertDelivery(
      env,
      identity,
      decodeURIComponent(retryOperatorAlertMatch[1]),
    );
  }

  if (request.method === "GET" && url.pathname === "/tools") {
    return handleListTools(request, env, identity);
  }

  if (request.method === "POST" && url.pathname === "/tools/runs") {
    return handleRunTool(request, env, identity, incomingTrace);
  }

  if (request.method === "POST" && url.pathname === "/external-signals") {
    return json(
      {
        ok: false,
        error: "The deployment-wide external-signal endpoint has been retired.",
        migration: "Use a configured Agent Pack trigger webhook.",
      },
      { status: 410 },
    );
  }

  const runtimeWorkflowType =
    request.method === "POST" ? runtimeWorkflowTypeForPath(url.pathname) : null;
  if (runtimeWorkflowType) {
    return executeRuntimeWorkflow(runtimeWorkflowType, request, env, identity, { source: "user" });
  }

  if (request.method === "POST" && url.pathname === "/tools/policy") {
    return handleUpdateToolPolicy(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/tools/approvals") {
    return handleListToolApprovals(request, env, identity);
  }

  const approveToolApprovalMatch = url.pathname.match(/^\/tools\/approvals\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveToolApprovalMatch?.[1]) {
    return handleApproveToolApproval(
      request,
      env,
      identity,
      decodeURIComponent(approveToolApprovalMatch[1]),
    );
  }

  const denyToolApprovalMatch = url.pathname.match(/^\/tools\/approvals\/([^/]+)\/deny$/);
  if (request.method === "POST" && denyToolApprovalMatch?.[1]) {
    return handleDenyToolApproval(
      request,
      env,
      identity,
      decodeURIComponent(denyToolApprovalMatch[1]),
    );
  }

  if (request.method === "GET" && url.pathname === "/runtime/traces/latest") {
    return handleLatestRuntimeTraces(env, identity, url);
  }

  const runtimeTraceMatch = url.pathname.match(/^\/runtime\/traces\/([^/]+)$/);
  if (request.method === "GET" && runtimeTraceMatch?.[1]) {
    return handleGetRuntimeTrace(env, identity, decodeURIComponent(runtimeTraceMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/chat/runtime-summary") {
    return handleChatRuntimeSummary(env, identity);
  }

  if (request.method === "GET" && url.pathname === "/chat/session") {
    return handleChatSession(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/chat/session/stream") {
    return handleChatSessionStream(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/chat/session/threads") {
    return handleListChatSessionThreads(request, env, identity);
  }

  if (request.method === "POST" && url.pathname === "/chat/session/threads") {
    return handleCreateChatSessionThread(request, env, identity);
  }

  if (request.method === "POST" && url.pathname === "/chat/session/stage-thread") {
    return handleStageChatSessionThread(request, env, identity);
  }

  if (request.method === "POST" && url.pathname === "/chat/session/materialize-turn") {
    return handleMaterializeChatSessionTurn(request, env, identity);
  }

  if (request.method === "POST" && url.pathname === "/chat/session/agent-switch") {
    return handleSwitchChatSessionAgent(request, env, identity);
  }

  const activateChatSessionThreadMatch = url.pathname.match(
    /^\/chat\/session\/threads\/([^/]+)\/activate$/,
  );
  if (request.method === "POST" && activateChatSessionThreadMatch?.[1]) {
    return handleActivateChatSessionThread(
      request,
      env,
      identity,
      decodeURIComponent(activateChatSessionThreadMatch[1]),
    );
  }

  const updateChatSessionThreadMatch = url.pathname.match(/^\/chat\/session\/threads\/([^/]+)$/);
  if (request.method === "PATCH" && updateChatSessionThreadMatch?.[1]) {
    return handleUpdateChatSessionThread(
      request,
      env,
      identity,
      decodeURIComponent(updateChatSessionThreadMatch[1]),
    );
  }

  if (request.method === "GET" && url.pathname === "/chat/threads") {
    return handleListChatThreads(env, identity, url);
  }

  const chatThreadMatch = url.pathname.match(/^\/chat\/threads\/([^/]+)$/);
  if (request.method === "GET" && chatThreadMatch?.[1]) {
    return handleGetChatThread(env, identity, decodeURIComponent(chatThreadMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/workbench/history/runs") {
    return listExecutionHistory(env, identity, url);
  }

  const historyRunMatch = url.pathname.match(/^\/workbench\/history\/runs\/([^/]+)$/);
  if (request.method === "GET" && historyRunMatch?.[1]) {
    return getExecutionHistoryRun(env, identity, decodeURIComponent(historyRunMatch[1]));
  }

  const cancelHistoryRunMatch = url.pathname.match(/^\/workbench\/history\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelHistoryRunMatch?.[1]) {
    return handleCancelExecutionRun(env, identity, decodeURIComponent(cancelHistoryRunMatch[1]));
  }

  const retryHistoryRunMatch = url.pathname.match(/^\/workbench\/history\/runs\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryHistoryRunMatch?.[1]) {
    return handleRetryExecutionRun(
      request,
      env,
      identity,
      decodeURIComponent(retryHistoryRunMatch[1]),
    );
  }

  if (request.method === "GET" && url.pathname === "/workbench/history/artifacts") {
    return listArtifactHistory(env, identity, url);
  }

  if (request.method === "POST" && url.pathname === "/workbench/artifacts") {
    return handleCreateArtifactBlob(request, env, identity);
  }

  if (url.pathname === "/workbench/retention-policy") {
    if (request.method === "GET") return handleGetRetentionPolicy(env, identity);
    if (request.method === "PATCH") return handleUpdateRetentionPolicy(request, env, identity);
  }

  const artifactContentMatch = url.pathname.match(/^\/workbench\/artifacts\/([^/]+)\/content$/);
  if (request.method === "GET" && artifactContentMatch?.[1]) {
    return handleGetArtifactBlob(env, identity, decodeURIComponent(artifactContentMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/workbench/managed-state") {
    return handleListManagedState(env, identity, url);
  }

  if (url.pathname === "/triggers") {
    if (request.method === "GET") return handleListTriggers(env, identity, url);
    if (request.method === "POST") return handleCreateTrigger(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/trigger-dispatches") {
    return handleListTriggerDispatches(env, identity, url);
  }

  const triggerDispatchMatch = url.pathname.match(/^\/trigger-dispatches\/([^/]+)$/);
  if (request.method === "GET" && triggerDispatchMatch?.[1]) {
    return handleGetTriggerDispatch(env, identity, decodeURIComponent(triggerDispatchMatch[1]));
  }

  const triggerReceiptMatch = url.pathname.match(/^\/triggers\/([^/]+)\/dispatches$/);
  if (request.method === "POST" && triggerReceiptMatch?.[1]) {
    return handleCreateTriggerDispatch(
      request,
      env,
      identity,
      decodeURIComponent(triggerReceiptMatch[1]),
      ctx,
    );
  }

  const replayTriggerDispatchMatch = url.pathname.match(/^\/trigger-dispatches\/([^/]+)\/replay$/);
  if (request.method === "POST" && replayTriggerDispatchMatch?.[1]) {
    return handleReplayTriggerDispatch(
      env,
      identity,
      decodeURIComponent(replayTriggerDispatchMatch[1]),
      ctx,
    );
  }

  const triggerMatch = url.pathname.match(/^\/triggers\/([^/]+)$/);
  if (triggerMatch?.[1]) {
    const triggerId = decodeURIComponent(triggerMatch[1]);
    if (request.method === "GET") return handleGetTrigger(env, identity, triggerId);
    if (request.method === "PATCH") {
      return handleUpdateTrigger(request, env, identity, triggerId);
    }
  }

  const managedStateMatch = url.pathname.match(/^\/workbench\/managed-state\/([^/]+)$/);
  if (request.method === "GET" && managedStateMatch?.[1]) {
    return handleGetManagedState(env, identity, decodeURIComponent(managedStateMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/workspaces") {
    return handleListWorkspaces(env, identity);
  }

  if (request.method === "POST" && url.pathname === "/workspaces") {
    return handleCreateWorkspace(request, env, identity);
  }

  const activateWorkspaceMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/activate$/);
  if (request.method === "POST" && activateWorkspaceMatch?.[1]) {
    return handleActivateWorkspace(env, identity, decodeURIComponent(activateWorkspaceMatch[1]));
  }

  const workspaceMembersMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/members$/);
  if (request.method === "GET" && workspaceMembersMatch?.[1]) {
    return handleListWorkspaceMembers(env, identity, decodeURIComponent(workspaceMembersMatch[1]));
  }
  if (request.method === "POST" && workspaceMembersMatch?.[1]) {
    return handleAddWorkspaceMember(
      request,
      env,
      identity,
      decodeURIComponent(workspaceMembersMatch[1]),
    );
  }

  const workspaceMemberMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/members\/([^/]+)$/);
  if (request.method === "PATCH" && workspaceMemberMatch?.[1] && workspaceMemberMatch[2]) {
    return handleUpdateWorkspaceMember(
      request,
      env,
      identity,
      decodeURIComponent(workspaceMemberMatch[1]),
      decodeURIComponent(workspaceMemberMatch[2]),
    );
  }

  if (request.method === "GET" && url.pathname === "/agents") {
    return handleListAgents(env, identity);
  }

  if (request.method === "GET" && url.pathname === "/agent-behavior-templates") {
    return handleListAgentBehaviorTemplates();
  }

  if (request.method === "POST" && url.pathname === "/agents") {
    return handleCreateAgent(request, env, identity);
  }

  const instantiatePackMatch = url.pathname.match(/^\/agent-packs\/([^/]+)\/instantiate$/);
  if (request.method === "POST" && instantiatePackMatch?.[1]) {
    return handleInstantiateAgentPack(env, identity, decodeURIComponent(instantiatePackMatch[1]));
  }

  const activateAgentMatch = url.pathname.match(/^\/agents\/([^/]+)\/activate$/);
  if (request.method === "POST" && activateAgentMatch?.[1]) {
    return handleActivateAgent(env, identity, decodeURIComponent(activateAgentMatch[1]));
  }

  if (request.method === "GET" && url.pathname === "/events/latest") {
    return json(await handleLatestControlPlaneEvents(env, identity, url));
  }

  if (request.method === "GET" && url.pathname === "/events/stream") {
    return handleControlPlaneEventStream(env, identity, request);
  }

  if (request.method === "GET" && url.pathname === "/events") {
    return json(await handleControlPlaneEvents(env, identity, url));
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    return handleCreateChatSession(request, env, identity);
  }

  if (request.method === "GET" && url.pathname === "/sessions/latest") {
    return handleLatestChatSession(env, identity);
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch?.[1]) {
    return handleGetChatSession(env, identity, sessionMatch[1]);
  }

  const chatBoundaryMatch = url.pathname.match(
    /^\/internal\/chat-boundary\/threads\/([^/]+)\/snapshot$/,
  );
  if (request.method === "GET" && chatBoundaryMatch?.[1]) {
    return handleChatBoundarySnapshot(env, identity, chatBoundaryMatch[1]);
  }

  if (url.pathname === "/langgraph" || url.pathname.startsWith("/langgraph/")) {
    return handleLangGraphFacade(request, env, ctx, identity, url, incomingTrace);
  }

  return json({ ok: false, error: "not found" }, { status: 404 });
};

const parseSampleRate = (value: string | undefined) => {
  if (!value) return 0.02;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.02;
  return parsed;
};

export default Sentry.withSentry<Env>(
  (env) => {
    if (!env.SENTRY_DSN) return undefined;

    return {
      dsn: env.SENTRY_DSN,
      sendDefaultPii: false,
      beforeSend: scrubSentryEvent,
      beforeBreadcrumb: scrubSentryBreadcrumb,
      environment: env.SENTRY_ENVIRONMENT ?? "production",
      release: env.SENTRY_RELEASE,
      tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
      initialScope: {
        tags: {
          service: "operloom",
          "runtime.surface": "cloudflare-worker",
          "runtime.target": "control-plane",
        },
      },
    };
  },
  {
    async fetch(request: Request, env: Env, ctx: WorkerExecutionContext) {
      try {
        return await handleRequest(request, env, ctx);
      } catch (error) {
        if (error instanceof Error && error.message.includes("workspace_export_in_progress")) {
          return json(
            {
              ok: false,
              code: "workspace_export_in_progress",
              error: "Workspace writes are briefly paused while an export snapshot is captured.",
            },
            { status: 423 },
          );
        }
        Sentry.captureException(error);
        return internalErrorResponse("Unhandled control-plane error", error);
      }
    },
    async scheduled(controller: WorkerScheduledController, env: Env, ctx: WorkerExecutionContext) {
      ctx.waitUntil(
        Promise.all([
          runTriggerSchedulerTick(env, {
            now: new Date(controller.scheduledTime),
            leaseOwner: `cron:${controller.cron}:${controller.scheduledTime}`,
          }),
          sweepExpiredArtifacts(env, { now: new Date(controller.scheduledTime) }),
          sweepExpiredOperationalData(env, { now: new Date(controller.scheduledTime) }),
          sweepExpiredChatMessages(env, { now: new Date(controller.scheduledTime) }),
          (async () => {
            await retryQuarantinedCredentialRevocations(env);
            return processDataLifecycleJobs(env, {
              now: new Date(controller.scheduledTime),
              owner: `cron:${controller.cron}:${controller.scheduledTime}`,
            });
          })(),
          expireDataExports(env, new Date(controller.scheduledTime)),
          expireConnectionOAuthStates(env, new Date(controller.scheduledTime)),
          deliverPendingOperatorAlerts(env, { now: new Date(controller.scheduledTime) }),
          sweepNotificationDeliveries(env, new Date(controller.scheduledTime)),
        ]),
      );
    },
    async queue(batch: MessageBatch<NotificationQueueMessage>, env: Env) {
      await processNotificationQueue(batch, env);
    },
  },
);
