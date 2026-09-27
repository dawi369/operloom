import type { AgentIdentity, Env } from "./types";
import type { WorkflowInvocationContext } from "./pack-workflow-runtime";

export type DurableTriggerInvocation = Extract<WorkflowInvocationContext, { source: "trigger" }>;

/** CHECK failure rolls back the entire run admission if the dispatch lease changed. */
export const durableTriggerLinkStatement = (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  workflowType: string,
  packId: string,
  invocation: DurableTriggerInvocation,
  timestamp: string,
) => {
  const snapshot = invocation.triggerSnapshot;
  if (!snapshot) throw new Error("Durable trigger admission requires a pinned dispatch snapshot");
  return env.DB.prepare(`INSERT INTO control_durable_trigger_links
  (run_id,dispatch_id,trigger_id,user_id,workspace_id,agent_id,workflow_type,pack_id,execution_json,input_json,config_json,created_at,preconditions_met)
  VALUES (?,?,?,?,?,?,?,?,
    COALESCE((SELECT execution_json FROM control_triggers WHERE id=?),'{}'),
    COALESCE((SELECT input_json FROM control_triggers WHERE id=?),'{}'),
    COALESCE((SELECT config_json FROM control_triggers WHERE id=?),'{}'),?,
    CASE WHEN EXISTS (SELECT 1 FROM control_trigger_dispatches d JOIN control_triggers t ON t.id=d.trigger_id
      WHERE d.id=? AND t.id=? AND d.user_id=? AND d.workspace_id=? AND d.agent_id=?
       AND t.user_id=d.user_id AND t.workspace_id=d.workspace_id AND t.agent_id=d.agent_id
       AND t.status='enabled' AND t.workflow_type=? AND t.pack_id=?
       AND json_extract(t.execution_json,'$.runtime')='durable'
       AND t.input_json=? AND t.execution_json=? AND t.config_json=? AND d.payload_json=?
       AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=d.user_id AND m.workspace_id=d.workspace_id
         AND m.status='active' AND m.role IN ('owner','admin'))
       AND d.status='leased' AND d.run_id IS NULL AND d.lease_owner=? AND d.attempt_count=?
       AND d.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE 0 END)`).bind(
    runId,
    invocation.dispatchId,
    invocation.triggerId,
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    workflowType,
    packId,
    invocation.triggerId,
    invocation.triggerId,
    invocation.triggerId,
    timestamp,
    invocation.dispatchId,
    invocation.triggerId,
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    workflowType,
    packId,
    snapshot.inputJson,
    snapshot.executionJson,
    snapshot.configJson,
    snapshot.payloadJson,
    invocation.leaseOwner,
    invocation.attemptCount,
  );
};
