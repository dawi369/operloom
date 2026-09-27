import { describe, expect, it } from "vitest";

import { signServiceRequest } from "../../../lib/workbench/control-plane-signing";
import {
  applyWorkflowCallbackPayload,
  handleWorkflowCallback,
  validateWorkflowCallbackPayload,
} from "./workflow-callbacks";
import type { D1PreparedStatement, D1Result, Env } from "./types";

type RecordedStatement = {
  query: string;
  values: unknown[];
};

const runRow = (input?: { status?: string; workflowType?: string }) => ({
  id: "run-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  workflow_intent_id: "intent-1",
  status: input?.status ?? "queued",
  execution_json: "{}",
  stage: "observe",
  engine: "cloudflare",
  heartbeat_at: null,
  last_event_at: null,
  completed_at: null,
  failed_at: null,
  data_json: "{}",
  created_at: "2026-06-18T00:00:00.000Z",
  updated_at: "2026-06-18T00:00:00.000Z",
  workflow_type: input?.workflowType ?? "workflow.test",
});

const createRecordingEnv = (input?: {
  status?: string;
  workflowType?: string;
  runChanges?: number;
}) => {
  const statements: RecordedStatement[] = [];
  const nonces = new Set<unknown>();
  const createStatement = (query: string): D1PreparedStatement & RecordedStatement => {
    const statement = {
      query,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        statement.values = values;
        return statement;
      },
      async first<T = unknown>() {
        if (query.includes("FROM control_runs r")) return runRow(input) as T;
        if (query.includes("FROM runtime_traces")) return null as T | null;
        return null as T | null;
      },
      async all<T = unknown>() {
        return { results: [] as T[] };
      },
      async run() {
        if (query.includes("INSERT INTO control_request_nonces")) {
          const nonce = statement.values[0];
          if (nonces.has(nonce)) throw new Error("duplicate nonce");
          nonces.add(nonce);
        }
        statements.push({ query, values: statement.values });
        return { success: true };
      },
    };
    return statement;
  };

  const env = {
    WORKBENCH_CALLBACK_SIGNING_SECRET: "callback-secret",
    DB: {
      prepare: createStatement,
      async batch(batchStatements: Array<D1PreparedStatement & Partial<RecordedStatement>>) {
        for (const statement of batchStatements) {
          statements.push({
            query: statement.query ?? "unknown",
            values: statement.values ?? [],
          });
        }
        return batchStatements.map((statement) => ({
          success: true,
          meta: {
            changes: statement.query?.includes("UPDATE control_runs")
              ? (input?.runChanges ?? 1)
              : 1,
          },
        })) as D1Result[];
      },
    },
  } satisfies Partial<Env>;

  return { env: env as Env, statements };
};

const signedRequest = async (
  env: Env,
  body: Record<string, unknown>,
  input?: { bodyOverride?: string; tamperBody?: string; nonce?: string; timestamp?: string },
) => {
  const bodyText = input?.bodyOverride ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  Object.assign(
    headers,
    await signServiceRequest({
      secret: env.WORKBENCH_CALLBACK_SIGNING_SECRET ?? "",
      method: "POST",
      pathWithQuery: "/workbench/run-callbacks",
      body: bodyText,
      headers,
      nonce: input?.nonce,
      timestamp: input?.timestamp,
    }),
  );
  return new Request("https://worker.test/workbench/run-callbacks", {
    method: "POST",
    headers,
    body: input?.tamperBody ?? bodyText,
  });
};

describe("workflow callback ingestion", () => {
  it("validates the compact callback payload and rejects raw messages/logs", () => {
    expect(
      validateWorkflowCallbackPayload({
        event: "run.progress",
        runId: "run-1",
        workflowIntentId: "intent-1",
        summary: "halfway",
        progress: { percent: 50 },
      }),
    ).toMatchObject({ ok: true });

    expect(
      validateWorkflowCallbackPayload({
        event: "run.progress",
        runId: "run-1",
        workflowIntentId: "intent-1",
        messages: [{ role: "user", content: "raw" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_body", redacted: true },
    });
  });

  it("requires signed callbacks and rejects body tampering", async () => {
    const { env } = createRecordingEnv();
    const body = { event: "run.started", runId: "run-1", workflowIntentId: "intent-1" };

    const unsigned = await handleWorkflowCallback(
      new Request("https://worker.test/workbench/run-callbacks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(unsigned.status).toBe(401);

    const tampered = await handleWorkflowCallback(
      await signedRequest(env, body, {
        tamperBody: JSON.stringify({ ...body, summary: "tampered" }),
        nonce: "tampered",
      }),
      env,
    );
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({
      details: { code: "body_hash_mismatch" },
    });
  });

  it("rejects stale and replayed signatures", async () => {
    const { env } = createRecordingEnv();
    const body = { event: "run.started", runId: "run-1", workflowIntentId: "intent-1" };

    const stale = await handleWorkflowCallback(
      await signedRequest(env, body, {
        nonce: "stale",
        timestamp: String(Date.now() - 10 * 60 * 1000),
      }),
      env,
    );
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({
      details: { code: "signature_stale" },
    });

    const replayRequest = await signedRequest(env, body, { nonce: "replay" });
    const first = await handleWorkflowCallback(replayRequest, env);
    expect(first.status).toBe(200);
    const replay = await handleWorkflowCallback(
      await signedRequest(env, body, { nonce: "replay" }),
      env,
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      details: { code: "signature_replay" },
    });
  });

  it("updates the stored run and emits audit/control/session events", async () => {
    const { env, statements } = createRecordingEnv();
    const result = await applyWorkflowCallbackPayload(env, {
      event: "run.completed",
      runId: "run-1",
      workflowIntentId: "intent-1",
      summary: "completed",
      outputSummary: "done",
    });

    expect(result.ok).toBe(true);
    expect(statements.some((statement) => statement.query.includes("UPDATE control_runs"))).toBe(
      true,
    );
    expect(
      statements.some((statement) => statement.query.includes("UPDATE control_workflow_intents")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.query.includes("INSERT INTO control_audit_events")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.query.includes("INSERT INTO control_plane_events")),
    ).toBe(true);
  });

  it("rejects callbacks after a terminal run status", async () => {
    const { env } = createRecordingEnv({ status: "completed" });
    const result = await applyWorkflowCallbackPayload(env, {
      event: "run.progress",
      runId: "run-1",
      workflowIntentId: "intent-1",
      summary: "late",
    });

    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toMatchObject({
      details: { code: "run_terminal" },
    });
  });

  it("rejects a callback that loses the active-run compare-and-set", async () => {
    const { env, statements } = createRecordingEnv({ runChanges: 0 });
    const result = await applyWorkflowCallbackPayload(env, {
      event: "run.completed",
      runId: "run-1",
      workflowIntentId: "intent-1",
      summary: "late completion",
      artifact: {
        id: "late-artifact",
        kind: "report",
        uri: "d1://late-artifact",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toMatchObject({ details: { code: "run_terminal" } });
    expect(
      statements
        .filter((statement) =>
          /control_artifacts|control_audit_events|control_plane_events/.test(statement.query),
        )
        .every((statement) => statement.query.includes("WHERE EXISTS")),
    ).toBe(true);
  });

  it("persists repo.snapshot artifact and tool-call metadata from callbacks", async () => {
    const { env, statements } = createRecordingEnv({ workflowType: "tool.repo.snapshot" });
    const result = await applyWorkflowCallbackPayload(env, {
      event: "artifact.created",
      runId: "run-1",
      workflowIntentId: "intent-1",
      summary: "Created repository snapshot artifact metadata.",
      artifact: {
        id: "run-1-artifact-repo-snapshot",
        kind: "report",
        uri: "d1://control-plane/run-1/repo-snapshot-report.json",
        title: "Repository snapshot report",
        mimeType: "application/json",
        data: {
          runner: { transport: "fly", adapterVersion: "repo-snapshot-v1", source: "admin" },
          timingMs: 42,
        },
      },
      toolCall: {
        id: "run-1-tool-repo-snapshot",
        toolId: "repo.snapshot",
        status: "running",
        artifactRefs: [
          {
            id: "run-1-artifact-repo-snapshot",
            kind: "report",
            uri: "d1://control-plane/run-1/repo-snapshot-report.json",
          },
        ],
        data: {
          runner: { transport: "fly", adapterVersion: "repo-snapshot-v1", source: "admin" },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(
      statements.some((statement) => statement.query.includes("INSERT INTO control_artifacts")),
    ).toBe(true);
    const toolCallInsert = statements.find((statement) =>
      statement.query.includes("INSERT INTO control_tool_calls"),
    );
    expect(toolCallInsert?.values).toContain("run-1-tool-repo-snapshot");
    expect(toolCallInsert?.values).toContain("repo.snapshot");
    expect(JSON.stringify(toolCallInsert?.values)).toContain("repo-snapshot-v1");
  });

  it("persists runner.echo tool-call metadata from callbacks", async () => {
    const { env, statements } = createRecordingEnv({ workflowType: "tool.runner.echo" });
    const result = await applyWorkflowCallbackPayload(env, {
      event: "run.completed",
      runId: "run-1",
      workflowIntentId: "intent-1",
      summary: "runner.echo completed.",
      outputSummary: "Echoed 12 characters.",
      toolCall: {
        id: "run-1-tool-runner-echo",
        toolId: "runner.echo",
        status: "completed",
        data: {
          runner: { transport: "fly", adapterVersion: "runner-echo-v1", source: "admin" },
          output: {
            status: "ok",
            summary: "Echoed 12 characters.",
            length: 12,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    const toolCallInsert = statements.find((statement) =>
      statement.query.includes("INSERT INTO control_tool_calls"),
    );
    expect(toolCallInsert?.values).toContain("run-1-tool-runner-echo");
    expect(toolCallInsert?.values).toContain("runner.echo");
    expect(JSON.stringify(toolCallInsert?.values)).toContain("runner-echo-v1");
  });
});
