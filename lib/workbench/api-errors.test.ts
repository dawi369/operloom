import { afterEach, describe, expect, it, vi } from "vitest";

import { toWorkbenchApiError } from "./api-errors";

class ControlPlaneRequestError extends Error {
  readonly name = "ControlPlaneRequestError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("workbench API errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs compact control-plane failure metadata without raw response blobs", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rawMessage = JSON.stringify({
      ok: false,
      run: {
        id: "run-1",
        workflowIntentId: "intent-1",
      },
      toolCall: {
        id: "tool-call-1",
        toolId: "runner.echo",
        scope: {
          userId: "user-secret",
          workspaceId: "workspace-secret",
        },
        data: {
          traceId: "trace-1",
          runner: {
            sandbox: {
              network: {
                deniedHosts: ["*"],
              },
            },
          },
        },
      },
      error: {
        code: "runner_request_failed",
        message: "Fly runner request failed with 500.",
        retryable: true,
        redacted: true,
      },
    });

    const response = toWorkbenchApiError(
      new ControlPlaneRequestError(rawMessage, 502),
      "Cloudflare tool run failed",
    );
    const body = (await response.json()) as { error?: string; errorId?: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe("Cloudflare tool run failed");
    expect(body.errorId).toBeTruthy();
    expect(body).toHaveProperty("runId", "run-1");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe("Cloudflare tool run failed");

    const logged = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(logged).toMatchObject({
      status: 502,
      name: "ControlPlaneRequestError",
      controlPlane: {
        code: "runner_request_failed",
        message: "Fly runner request failed with 500.",
        runId: "run-1",
        workflowIntentId: "intent-1",
        toolCallId: "tool-call-1",
        toolId: "runner.echo",
        traceId: "trace-1",
        retryable: true,
        redacted: true,
      },
    });

    const serializedLog = JSON.stringify(logged);
    expect(serializedLog).not.toContain("user-secret");
    expect(serializedLog).not.toContain("workspace-secret");
    expect(serializedLog).not.toContain("deniedHosts");
    expect(serializedLog).not.toContain("sandbox");
    expect(serializedLog).not.toContain(rawMessage);
  });

  it("records expected client failures without classifying them as server errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = toWorkbenchApiError(
      new ControlPlaneRequestError("Authentication required", 401),
      "Cloudflare chat session request failed",
    );
    const body = (await response.json()) as { error?: string; errorId?: string };

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "Authentication required" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(
      "Cloudflare chat session request failed",
      expect.objectContaining({
        errorId: undefined,
        status: 401,
        name: "ControlPlaneRequestError",
      }),
    );
  });
});
