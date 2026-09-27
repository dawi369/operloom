export const userIdHeader = "x-assistant-mk1-user-id";
export const accountIdHeader = "x-assistant-mk1-account-id";
export const accountSourceHeader = "x-assistant-mk1-account-source";
export const workspaceIdHeader = "x-assistant-mk1-workspace-id";
export const agentIdHeader = "x-assistant-mk1-agent-id";

export const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ControlPlaneAuthContext = {
  mode: "access_token" | "local_api";
};

export const internalErrorResponse = (label: string, error: unknown) => {
  const errorId = crypto.randomUUID();
  const message = error instanceof Error ? error.message : String(error);
  console.error(label, {
    errorId,
    error: message,
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return json({ ok: false, error: "Internal control-plane error", errorId }, { status: 500 });
};

export const readRequiredHeader = (request: Request, name: string) => {
  const value = request.headers.get(name)?.trim();
  return value ? value : null;
};

export const parseDataJson = (raw: string) => {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
