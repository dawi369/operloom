import { parseDataJson } from "./http";
import { createStoredZip, textZipEntry } from "./zip-archive";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlArtifactRow,
  type ControlDataJobRow,
  type Env,
} from "./types";
import {
  acquireExportFence,
  batchStatements,
  clearExportSnapshot,
  collectionPageSize,
  exportCollections,
  exportExpiryMs,
  exportStorageKey,
  lifecycleFaultInjectionEnabled,
  listWorkspaceThreads,
  maximumCollectionRows,
  maximumExportBytes,
  pauseE2eExportBoundary,
  readExportSnapshotCursor,
  recordExportFenceReleased,
  releaseExportFence,
  renewExportFence,
  selectJob,
  sha256Hex,
  stageSnapshotRows,
  threadLifecycleRequest,
  updateExportSnapshotCursor,
  workspaceExportOmittedTables,
} from "./workspace-data-export-core";
import type { ExportSnapshotCursor } from "./workspace-data-export-core";

export const injectE2eExportFailure = async (
  env: Env,
  job: ControlDataJobRow,
  cursor: ExportSnapshotCursor,
  phase: NonNullable<ExportSnapshotCursor["e2eFailPhase"]>,
) => {
  if (
    !lifecycleFaultInjectionEnabled(env) ||
    cursor.e2eFailPhase !== phase ||
    (cursor.e2eFailuresRemaining ?? 0) <= 0
  ) {
    return cursor;
  }
  const next = await updateExportSnapshotCursor(env, job, {
    ...cursor,
    e2eFailuresRemaining: (cursor.e2eFailuresRemaining ?? 0) - 1,
  });
  throw Object.assign(new Error(`e2e_export_${phase}_failure`), { cursor: next });
};

export const loadStagedArtifacts = async (env: Env, jobId: string) => {
  const rows = await env.DB.prepare(
    `SELECT payload_json FROM control_data_export_rows
     WHERE job_id = ? AND collection_name = 'control_artifacts'
     ORDER BY row_key ASC`,
  )
    .bind(jobId)
    .all<{ payload_json: string }>();
  return rows.results.map(
    (row) => parseDataJson(row.payload_json) as unknown as ControlArtifactRow,
  );
};

export const captureExportSnapshot = async (
  env: Env,
  identity: AgentIdentity,
  job: ControlDataJobRow,
) => {
  let cursor = readExportSnapshotCursor(job);
  const snapshotAt = cursor.snapshotAt ?? new Date().toISOString();
  try {
    if (
      !cursor.phase ||
      ["awaiting_quiescence", "fenced", "do_frozen", "d1_materialized"].includes(cursor.phase)
    ) {
      await acquireExportFence(env, job);
    }
    if (!cursor.phase || cursor.phase === "awaiting_quiescence") {
      await clearExportSnapshot(env, job.id);
      cursor = await updateExportSnapshotCursor(env, job, {
        ...cursor,
        phase: "fenced",
        snapshotAt,
        fenceAcquiredAt: new Date().toISOString(),
      });
      await pauseE2eExportBoundary(env);
    }

    if (cursor.phase === "fenced") {
      await env.DB.prepare(
        `DELETE FROM control_data_export_rows
         WHERE job_id = ? AND collection_name = 'durable_object_thread_messages'`,
      )
        .bind(job.id)
        .run();
      const threads = await listWorkspaceThreads(env, identity.scope.workspaceId);
      const threadRows: Array<{ key: string; payload: Record<string, unknown> }> = [];
      const durableObjectChecksums: Record<string, string> = {};
      for (const thread of threads.results) {
        const frozen = await threadLifecycleRequest(env, thread, "freeze", job.id);
        if (!frozen?.contentSha256 || frozen.messageCount !== (frozen.messages ?? []).length) {
          throw new Error("durable_object_snapshot_evidence_invalid");
        }
        durableObjectChecksums[thread.thread_id] = frozen.contentSha256;
        threadRows.push({
          key: thread.thread_id,
          payload: {
            threadId: thread.thread_id,
            snapshotAt: frozen.snapshotAt,
            messageCount: frozen.messageCount,
            contentSha256: frozen.contentSha256,
            messages: frozen.messages ?? [],
            turnReceipts: frozen.turnReceipts ?? [],
          },
        });
      }
      await stageSnapshotRows(env, job, "durable_object_thread_messages", threadRows, snapshotAt);
      cursor = await updateExportSnapshotCursor(env, job, {
        ...cursor,
        phase: "do_frozen",
        durableObjectThreadCount: threadRows.length,
        durableObjectChecksums,
      });
      await pauseE2eExportBoundary(env);
    }

    if (cursor.phase === "do_frozen") {
      await env.DB.prepare(
        `DELETE FROM control_data_export_rows
         WHERE job_id = ? AND collection_name <> 'durable_object_thread_messages'`,
      )
        .bind(job.id)
        .run();
      const collectionCounts: Record<string, number> = {};
      for (const collection of exportCollections) {
        let rowCursor = "";
        let count = 0;
        while (count < maximumCollectionRows) {
          const page = await env.DB.prepare(
            `SELECT export_rows.*, CAST(${collection.keyExpression} AS TEXT) AS __export_key
             FROM (${collection.query}) export_rows
             WHERE CAST(${collection.keyExpression} AS TEXT) > ?
             ORDER BY CAST(${collection.keyExpression} AS TEXT) ASC
             LIMIT ?`,
          )
            .bind(...collection.bindings(identity), rowCursor, collectionPageSize)
            .all<Record<string, unknown> & { __export_key: string }>();
          const staged = page.results.map((row) => {
            const { __export_key: key, ...payload } = row;
            return { key, payload };
          });
          await stageSnapshotRows(env, job, collection.name, staged, snapshotAt);
          count += staged.length;
          if (staged.length < collectionPageSize) break;
          rowCursor = staged.at(-1)?.key ?? rowCursor;
          await renewExportFence(env, job);
        }
        if (count >= maximumCollectionRows) {
          throw new Error(`collection_too_large:${collection.name}`);
        }
        collectionCounts[collection.name] = count;
        await renewExportFence(env, job);
      }
      cursor = await updateExportSnapshotCursor(env, job, {
        ...cursor,
        phase: "d1_materialized",
        collectionCounts,
      });
      await injectE2eExportFailure(env, job, cursor, "after_d1_materialized");
    }

    if (cursor.phase === "d1_materialized") {
      await env.DB.prepare("DELETE FROM control_data_export_objects WHERE job_id = ?")
        .bind(job.id)
        .run();
      const pinnedArtifacts = await loadStagedArtifacts(env, job.id);
      const objectStatements = pinnedArtifacts
        .filter(
          (artifact) =>
            artifact.storage_provider === "r2" &&
            artifact.storage_key &&
            artifact.content_sha256 &&
            !artifact.deleted_at,
        )
        .map((artifact) =>
          env.DB.prepare(
            `INSERT OR REPLACE INTO control_data_export_objects (
               job_id, artifact_id, storage_key, content_sha256, size_bytes, status, created_at
             ) VALUES (?, ?, ?, ?, ?, 'pinned', ?)`,
          ).bind(
            job.id,
            artifact.id,
            artifact.storage_key,
            artifact.content_sha256,
            artifact.size_bytes,
            snapshotAt,
          ),
        );
      await batchStatements(env, objectStatements);
      cursor = await updateExportSnapshotCursor(env, job, {
        ...cursor,
        phase: "r2_pinned",
      });
      await injectE2eExportFailure(env, job, cursor, "after_r2_pinned");
    }

    if (cursor.phase === "r2_pinned") {
      await releaseExportFence(env, job);
      cursor = await recordExportFenceReleased(env, job, cursor);
    }
    return cursor;
  } catch (error) {
    if (error instanceof Error && error.message === "data_job_publication_revoked") {
      await releaseExportFence(env, job).catch(() => undefined);
    }
    throw error;
  }
};

export const loadStagedSnapshot = async (env: Env, jobId: string) => {
  const collections = new Map<string, string[]>();
  let collectionCursor = "";
  let rowCursor = "";
  while (true) {
    const page = await env.DB.prepare(
      `SELECT collection_name, row_key, payload_json FROM control_data_export_rows
       WHERE job_id = ? AND (
         collection_name > ? OR (collection_name = ? AND row_key > ?)
       )
       ORDER BY collection_name ASC, row_key ASC LIMIT ?`,
    )
      .bind(jobId, collectionCursor, collectionCursor, rowCursor, collectionPageSize)
      .all<{ collection_name: string; row_key: string; payload_json: string }>();
    for (const row of page.results) {
      const values = collections.get(row.collection_name) ?? [];
      values.push(row.payload_json);
      collections.set(row.collection_name, values);
      collectionCursor = row.collection_name;
      rowCursor = row.row_key;
    }
    if (page.results.length < collectionPageSize) break;
  }
  return collections;
};

export const runExportJob = async (env: Env, identity: AgentIdentity, job: ControlDataJobRow) => {
  if (!env.ARTIFACTS) throw new Error("artifact_storage_unavailable");
  let cursor = readExportSnapshotCursor(job);
  if (cursor.phase !== "released" && cursor.phase !== "assembling") {
    await captureExportSnapshot(env, identity, job);
    const refreshed = await selectJob(env, identity, job.id);
    if (!refreshed) throw new Error("data_job_publication_revoked");
    cursor = readExportSnapshotCursor(refreshed);
  }
  if (cursor.phase === "released") {
    cursor = await updateExportSnapshotCursor(env, job, { ...cursor, phase: "assembling" });
  }
  await injectE2eExportFailure(env, job, cursor, "assembling");
  const refreshed = await selectJob(env, identity, job.id);
  if (!refreshed) throw new Error("data_job_publication_revoked");
  cursor = readExportSnapshotCursor(refreshed);
  if (cursor.phase !== "assembling" || !cursor.snapshotAt) {
    throw new Error("workspace_export_snapshot_incomplete");
  }

  const collections = await loadStagedSnapshot(env, job.id);
  const entries: Array<{ name: string; content: Uint8Array }> = [];
  for (const [name, rows] of collections) {
    if (name === "durable_object_thread_messages") continue;
    entries.push(textZipEntry(`d1/${name}.ndjson`, rows.join("\n")));
  }
  entries.push(
    textZipEntry(
      "durable-objects/thread-messages.ndjson",
      (collections.get("durable_object_thread_messages") ?? []).join("\n"),
    ),
  );

  const objects = await env.DB.prepare(
    `SELECT artifact_id, storage_key, content_sha256, size_bytes
     FROM control_data_export_objects WHERE job_id = ? ORDER BY artifact_id ASC`,
  )
    .bind(job.id)
    .all<{
      artifact_id: string;
      storage_key: string;
      content_sha256: string;
      size_bytes: number | null;
    }>();
  for (const pinned of objects.results) {
    const object = await env.ARTIFACTS.get(pinned.storage_key);
    if (!object) throw new Error(`artifact_content_missing:${pinned.artifact_id}`);
    const content = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(content)) !== pinned.content_sha256) {
      throw new Error(`artifact_checksum_mismatch:${pinned.artifact_id}`);
    }
    entries.push({ name: `artifacts/${encodeURIComponent(pinned.artifact_id)}`, content });
  }

  const fileEvidence = await Promise.all(
    entries.map(async (entry) => ({
      path: entry.name,
      sizeBytes: entry.content.byteLength,
      sha256: await sha256Hex(entry.content),
    })),
  );

  const generatedAt = new Date().toISOString();
  const manifest = {
    version: 3,
    generatedAt,
    snapshotId: job.id,
    snapshotAt: cursor.snapshotAt,
    fenceDurationMs: cursor.fenceDurationMs ?? 0,
    scope: identity.scope,
    collections: cursor.collectionCounts ?? {},
    durableObjectThreadCount: cursor.durableObjectThreadCount ?? 0,
    artifactCount: entries.filter((entry) => entry.name.startsWith("artifacts/")).length,
    files: fileEvidence,
    omittedTables: workspaceExportOmittedTables,
    excludedSecurityState: [
      "control_request_nonces",
      "control_triggers.secret_hash",
      "control_connection_oauth_states",
      "control_connection_capabilities",
      "control_connections.vault_object_id",
      "control_connections.vault_version",
      "control_client_devices.vault_object_id",
      "control_client_devices.vault_version",
      "Expo push tokens",
      "WorkOS Vault credential objects",
    ],
  };
  entries.unshift(textZipEntry("manifest.json", JSON.stringify(manifest, null, 2)));
  const archive = createStoredZip(entries);
  if (archive.byteLength > maximumExportBytes) throw new Error("workspace_export_too_large");
  const digest = await sha256Hex(archive);
  const storageKey = exportStorageKey(identity, job.id);
  await env.ARTIFACTS.put(storageKey, archive, {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: {
      jobId: job.id,
      workspaceId: identity.scope.workspaceId,
      contentSha256: digest,
    },
  });
  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + exportExpiryMs).toISOString();
  const published = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_data_jobs SET status = 'completed', storage_key = ?, content_sha256 = ?,
         size_bytes = ?, result_json = ?, error_json = '{}', lease_owner = NULL,
         lease_expires_at = NULL, expires_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
    ).bind(
      storageKey,
      digest,
      archive.byteLength,
      toJson({ manifest }),
      expiresAt,
      completedAt,
      completedAt,
      job.id,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, 'workspace.data.exported', 'Workspace data export completed.',
         'dataJob', ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM control_data_jobs WHERE id = ? AND status = 'completed'
         )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      job.id,
      toJson({
        sizeBytes: archive.byteLength,
        contentSha256: digest,
        snapshotAt: cursor.snapshotAt,
      }),
      completedAt,
      job.id,
    ),
  ]);
  if ((published[0]?.meta?.changes ?? 0) === 0) {
    await env.ARTIFACTS.delete(storageKey).catch(() => undefined);
    throw new Error("data_job_publication_revoked");
  }
  await clearExportSnapshot(env, job.id);
};
