import type { Env } from "./types";

/** Keep identities and request hashes while pruning resolved provider payloads. */
export const sweepProviderOperationPayloads = async (env: Env) =>
  env.DB.prepare(`UPDATE control_provider_operations SET result_json=json_object('payloadPrunedAt',?)
    WHERE id IN (SELECT o.id FROM control_provider_operations o
      JOIN control_action_proposals p ON p.id=o.proposal_id
      LEFT JOIN control_retention_policies policy ON policy.workspace_id=p.workspace_id
      WHERE o.status IN ('succeeded','failed') AND json_extract(o.result_json,'$.payloadPrunedAt') IS NULL
      AND p.status IN ('executed','failed','reconciled','cancelled','expired')
      AND NOT EXISTS (SELECT 1 FROM control_action_reservations held WHERE held.proposal_id=p.id AND held.status='held')
      AND p.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || COALESCE(policy.run_payload_retention_days,90) || ' days')
      ORDER BY o.updated_at ASC LIMIT 50)`)
    .bind(new Date().toISOString())
    .run();
