import { serviceSignatureHeader, signServiceRequest } from "../lib/workbench/control-plane-signing";
import { createSmokeContext, runSmoke } from "./smoke-utils";

const { baseUrl, suffix } = createSmokeContext();
const signingSecret =
  process.env.WORKBENCH_CALLBACK_SIGNING_SECRET?.trim() ||
  process.env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim();

if (!signingSecret) {
  throw new Error(
    "WORKBENCH_CALLBACK_SIGNING_SECRET or CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET is required",
  );
}

const path = "/workbench/run-callbacks";
const body = JSON.stringify({
  event: "run.started",
  runId: `missing-run-${suffix}`,
  workflowIntentId: `missing-intent-${suffix}`,
  summary: "auth smoke",
});

const signedHeaders = async (input?: {
  body?: string;
  nonce?: string;
  timestamp?: string;
  tamper?: (headers: Record<string, string>) => void;
}) => {
  const signedBody = input?.body ?? body;
  const headers: Record<string, string> = { "content-type": "application/json" };
  Object.assign(
    headers,
    await signServiceRequest({
      secret: signingSecret,
      method: "POST",
      pathWithQuery: path,
      body: signedBody,
      headers,
      nonce: input?.nonce,
      timestamp: input?.timestamp,
    }),
  );
  input?.tamper?.(headers);
  return headers;
};

const expectErrorCode = async (response: Response, status: number, code: string) => {
  if (response.status !== status) {
    throw new Error(`expected ${status} ${code}, got ${response.status}: ${await response.text()}`);
  }
  const parsed = (await response.json()) as { details?: { code?: string } };
  if (parsed.details?.code !== code) {
    throw new Error(`expected ${code}, got ${JSON.stringify(parsed)}`);
  }
};

runSmoke("Cloudflare workflow callback auth smoke", async () => {
  console.log(`Smoking workflow callback auth at ${baseUrl}`);

  const unsigned = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await expectErrorCode(unsigned, 401, "signature_required");

  const stale = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: await signedHeaders({
      timestamp: String(Date.now() - 10 * 60 * 1000),
      nonce: `stale-${suffix}`,
    }),
    body,
  });
  await expectErrorCode(stale, 401, "signature_stale");

  const signedBody = JSON.stringify({
    event: "run.started",
    runId: `body-run-${suffix}`,
    workflowIntentId: `body-intent-${suffix}`,
  });
  const bodyMismatch = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: await signedHeaders({ body: signedBody, nonce: `body-${suffix}` }),
    body: JSON.stringify({
      event: "run.started",
      runId: `tampered-run-${suffix}`,
      workflowIntentId: `body-intent-${suffix}`,
    }),
  });
  await expectErrorCode(bodyMismatch, 401, "body_hash_mismatch");

  const missingSignature = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: await signedHeaders({
      nonce: `missing-${suffix}`,
      tamper: (headers) => delete headers[serviceSignatureHeader],
    }),
    body,
  });
  await expectErrorCode(missingSignature, 401, "signature_required");

  const replayHeaders = await signedHeaders({ nonce: `replay-${suffix}` });
  const firstReplay = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: replayHeaders,
    body,
  });
  await expectErrorCode(firstReplay, 404, "run_not_found");
  const secondReplay = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: replayHeaders,
    body,
  });
  await expectErrorCode(secondReplay, 401, "signature_replay");
});

export {};
