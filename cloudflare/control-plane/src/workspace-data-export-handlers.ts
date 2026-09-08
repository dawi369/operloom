import { retainedDataEnabled } from "./feature-gates";
import { isRecord, json } from "./http";
import { createId, toJson, type AgentIdentity, type Env } from "./types";
import {
  jobSummary,
  lifecycleFaultInjectionEnabled,
  requireLifecycleAdmin,
  selectJob,
} from "./workspace-data-export";
import type { ExportSnapshotCursor } from "./workspace-data-export";
import { processDataLifecycleJobs } from "./workspace-data-jobs";

export const handleCreateWorkspaceExport = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  if (!retainedDataEnabled(env))
    return json(
      {
        ok: false,
        code: "retained_data_disabled",
        error: "Retained-data operations are disabled.",
      },
      { status: 503 },
    );
  const adminError = await requireLifecycleAdmin(env, identity);
  if (adminError) return adminError;
  if (!env.ARTIFACTS || !env.WorkbenchThreadChatAgent)
    return json({ ok: false, error: "Complete export storage is unavailable." }, { status: 503 });
  const body = await request.json().catch(() => null);
  const requestedFailurePhase =
    request.headers.get("x-workbench-e2e-export-failure-phase")?.trim() ??
    new URL(request.url).searchParams.get("e2eFailPhase")?.trim() ??
    (isRecord(body) ? String(body.e2eFailPhase ?? "") : "");
  const e2eFailPhase =
    lifecycleFaultInjectionEnabled(env) &&
    ["after_d1_materialized", "after_r2_pinned", "assembling"].includes(requestedFailurePhase)
      ? (requestedFailurePhase as NonNullable<ExportSnapshotCursor["e2eFailPhase"]>)
      : undefined;
  const id = createId("cf-data-export");
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_data_jobs (id, user_id, workspace_id, kind, status, cursor_json,
       created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'export', 'queued', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      identity.scope.userId,
      identity.scope.workspaceId,
      toJson({
        phase: "awaiting_quiescence",
        e2eFailPhase,
        e2eFailuresRemaining: e2eFailPhase ? 1 : undefined,
      } satisfies ExportSnapshotCursor),
      identity.scope.userId,
      timestamp,
      timestamp,
    )
    .run();
  waitUntil?.(processDataLifecycleJobs(env, { owner: `request:${id}`, limit: 1 }));
  return json(
    {
      ok: true,
      job: {
        id,
        kind: "export",
        status: "queued",
        createdAt: timestamp,
        ...(lifecycleFaultInjectionEnabled(env) && e2eFailPhase
          ? { injectedFailurePhase: e2eFailPhase }
          : {}),
      },
    },
    { status: 202 },
  );
};

export const handleGetWorkspaceDataJob = async (
  env: Env,
  identity: AgentIdentity,
  jobId: string,
) => {
  const adminError = await requireLifecycleAdmin(env, identity);
  if (adminError) return adminError;
  const row = await selectJob(env, identity, jobId);
  return row
    ? json({ ok: true, job: jobSummary(row) })
    : json({ ok: false, error: "Data job not found." }, { status: 404 });
};

export const handleDownloadWorkspaceExport = async (
  env: Env,
  identity: AgentIdentity,
  jobId: string,
) => {
  const adminError = await requireLifecycleAdmin(env, identity);
  if (adminError) return adminError;
  const row = await selectJob(env, identity, jobId);
  if (!row || row.kind !== "export")
    return json({ ok: false, error: "Data export not found." }, { status: 404 });
  if (row.status !== "completed" || !row.storage_key || !env.ARTIFACTS)
    return json(
      { ok: false, code: "export_not_ready", error: "Data export is not ready." },
      { status: 409 },
    );
  if (row.expires_at && row.expires_at <= new Date().toISOString())
    return json({ ok: false, error: "Data export expired." }, { status: 410 });
  const object = await env.ARTIFACTS.get(row.storage_key);
  if (!object)
    return json({ ok: false, error: "Data export content is unavailable." }, { status: 410 });
  return new Response(object.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="operloom-${encodeURIComponent(identity.scope.workspaceId)}-export.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-content-sha256": row.content_sha256 ?? "",
    },
  });
};
