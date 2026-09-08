import { getWorkbenchIdentityHeaders } from "@/lib/workbench/agent-identity";
import { signFacadeRequest } from "@/lib/workbench/control-plane-signing";

export class ControlPlaneRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

const requestTimeoutMs = 10_000;

const getControlPlaneConfig = () => {
  const baseUrl = process.env.CLOUDFLARE_CONTROL_PLANE_URL?.replace(/\/$/, "");
  const token = process.env.CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN;
  const signingSecret = process.env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET;
  return baseUrl && (token || signingSecret) ? { baseUrl, token, signingSecret } : null;
};

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs = requestTimeoutMs,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ControlPlaneRequestError(
        `Cloudflare control-plane request timed out after ${timeoutMs}ms`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const controlPlaneRequest = async (path: string, init?: RequestInit) => {
  const config = getControlPlaneConfig();
  if (!config) {
    throw new Error(
      "CLOUDFLARE_CONTROL_PLANE_URL and signed-facade or local-dev authentication are required",
    );
  }
  const identityHeaders = await getWorkbenchIdentityHeaders();
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...identityHeaders,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.signingSecret?.trim()) {
    Object.assign(
      headers,
      await signFacadeRequest({
        secret: config.signingSecret,
        method,
        pathWithQuery: path,
        body,
        headers,
      }),
    );
  }
  return {
    url: `${config.baseUrl}${path}`,
    init: { ...init, headers } satisfies RequestInit,
  };
};

export const parseErrorBody = async (response: Response) => {
  const body = await response.text();
  if (!body) return response.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; run?: unknown };
    if (parsed.run) return body;
    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body;
  }
};

export const requestControlPlane = async <T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> => {
  const request = await controlPlaneRequest(path, init);
  const response = await fetchWithTimeout(request.url, request.init, timeoutMs);
  if (!response.ok) {
    throw new ControlPlaneRequestError(await parseErrorBody(response), response.status);
  }
  return (await response.json()) as T;
};

export const requestControlPlaneResponse = async (path: string, init?: RequestInit) => {
  const request = await controlPlaneRequest(path, init);
  const response = await fetchWithTimeout(request.url, request.init);
  if (!response.ok) {
    throw new ControlPlaneRequestError(await parseErrorBody(response), response.status);
  }
  return response;
};
