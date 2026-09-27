import { buildPackWorkflowRequest } from "../../../lib/agent-runtime/registry";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { processPendingTriggerDispatches } from "./trigger-execution";
import {
  createId,
  toJson,
  type ControlTriggerDispatchRow,
  type ControlTriggerRow,
  type Env,
  type WorkerExecutionContext,
} from "./types";

const maximumWebhookBytes = 32 * 1024;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const triggerSecretHeader = "x-operloom-trigger-secret";

const constantTimeEqual = (left: string, right: string) => {
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
};

const dispatchColumns = `id, trigger_id, user_id, workspace_id, agent_id, idempotency_key,
  source, status, attempt_count, run_id, previous_run_id, scheduled_for, received_at,
  lease_owner, lease_expires_at, heartbeat_at, payload_json, error_json, created_at, updated_at`;

export const handleTriggerWebhookIngress = async (
  request: Request,
  env: Env,
  publicId: string,
  ctx?: WorkerExecutionContext,
) => {
  if (!/^hook-[A-Za-z0-9-]{8,160}$/.test(publicId)) {
    return json({ ok: false, error: "Trigger webhook not found" }, { status: 404 });
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKeyPattern.test(idempotencyKey)) {
    return json({ ok: false, error: "A valid Idempotency-Key is required" }, { status: 400 });
  }
  const secret = request.headers.get(triggerSecretHeader)?.trim() ?? "";
  if (!secret) return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const trigger = await env.DB.prepare(
    `SELECT id, public_id, secret_hash, user_id, workspace_id, agent_id, pack_id,
            pack_trigger_id, kind, workflow_type, status, execution_json, config_json,
            input_json, max_concurrent_runs, version, next_trigger_at, last_triggered_at,
            created_by_user_id, created_at, updated_at
     FROM control_triggers
     WHERE public_id = ? AND kind = 'webhook' AND status = 'enabled' LIMIT 1`,
  )
    .bind(publicId)
    .first<ControlTriggerRow>();
  if (!trigger?.secret_hash) {
    return json({ ok: false, error: "Trigger webhook not found" }, { status: 404 });
  }
  const actualHash = await sha256Hex(secret);
  if (!constantTimeEqual(actualHash, trigger.secret_hash)) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > maximumWebhookBytes) {
    return json({ ok: false, error: "Webhook body is too large" }, { status: 413 });
  }
  const payload = bodyText ? parseJson(bodyText) : {};
  if (!isRecord(payload)) {
    return json({ ok: false, error: "Webhook body must be an object" }, { status: 400 });
  }
  const requestInput = buildPackWorkflowRequest(trigger.workflow_type, {
    ...parseDataJson(trigger.input_json),
    ...payload,
  });
  if (!requestInput) {
    return json({ ok: false, error: "Trigger workflow is unavailable" }, { status: 409 });
  }
  const normalizedPayload = requestInput.input;
  if (new TextEncoder().encode(JSON.stringify(normalizedPayload)).byteLength > 8 * 1024) {
    return json({ ok: false, error: "Normalized webhook input is too large" }, { status: 413 });
  }

  const dispatchId = createId("cf-dispatch");
  const timestamp = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO control_trigger_dispatches (
         id, trigger_id, user_id, workspace_id, agent_id, idempotency_key, source,
         status, attempt_count, received_at, payload_json, error_json, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, 'webhook', 'pending', 0, ?, ?, '{}', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_triggers
         WHERE id = ? AND public_id = ? AND status = 'enabled' AND kind = 'webhook'
           AND (json_extract(execution_json,'$.runtime') IS NOT 'durable' OR
             (SELECT COUNT(*) FROM control_trigger_dispatches d WHERE d.trigger_id=control_triggers.id AND d.status='pending') < 100)
       )`,
    ).bind(
      dispatchId,
      trigger.id,
      trigger.user_id,
      trigger.workspace_id,
      trigger.agent_id,
      idempotencyKey,
      timestamp,
      toJson(normalizedPayload),
      timestamp,
      timestamp,
      trigger.id,
      publicId,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, 'trigger.dispatch.received', ?, 'triggerDispatch', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_trigger_dispatches WHERE id = ? AND created_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      trigger.user_id,
      trigger.workspace_id,
      `Received webhook dispatch for ${trigger.pack_trigger_id}.`,
      dispatchId,
      toJson({ triggerId: trigger.id, source: "webhook" }),
      timestamp,
      dispatchId,
      timestamp,
    ),
  ]);
  const created = results[0]?.meta?.changes === 1;
  const dispatch = await env.DB.prepare(
    `SELECT ${dispatchColumns} FROM control_trigger_dispatches
     WHERE trigger_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(trigger.id, idempotencyKey)
    .first<ControlTriggerDispatchRow>();
  if (!dispatch)
    return json({ ok: false, error: "Trigger dispatch was not accepted" }, { status: 409 });
  if (
    parseDataJson(trigger.execution_json).runtime === "durable" &&
    runtimeStateCanonicalJson(parseDataJson(dispatch.payload_json)) !==
      runtimeStateCanonicalJson(normalizedPayload)
  )
    return json(
      {
        ok: false,
        error: "Dispatch key already identifies different content",
        code: "trigger_dispatch_conflict",
      },
      { status: 409 },
    );
  if (created && ctx) {
    ctx.waitUntil(
      processPendingTriggerDispatches(env, {
        leaseOwner: `webhook:${publicId}:${crypto.randomUUID()}`,
        dispatchId: dispatch.id,
        limit: 1,
      }),
    );
  }
  return json(
    {
      ok: true,
      duplicate: !created,
      dispatchId: dispatch.id,
      runId: dispatch.run_id ?? undefined,
    },
    { status: created ? 202 : 200 },
  );
};

export { triggerSecretHeader };
