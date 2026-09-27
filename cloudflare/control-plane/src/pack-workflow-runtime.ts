import { executeRuntimeWorkflowRequest } from "./runtime-workflows";
import type { AgentIdentity, Env } from "./types";

export type WorkflowInvocationContext =
  | { source: "user" }
  | {
      source: "trigger";
      triggerId: string;
      dispatchId: string;
      leaseOwner: string;
      triggerSource: "manual" | "schedule" | "monitor" | "webhook" | "replay";
      attemptCount: number;
      idempotencyKey: string;
      scheduledFor: string | null;
      previousRunId: string | null;
      triggerSnapshot?: {
        inputJson: string;
        executionJson: string;
        configJson: string;
        payloadJson: string;
      };
    };

export type RuntimeWorkflowExecutor = (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  invocation: WorkflowInvocationContext,
) => Promise<Response>;

export const executeRuntimeWorkflow = (
  workflowType: string,
  request: Request,
  env: Env,
  identity: AgentIdentity,
  invocation: WorkflowInvocationContext = { source: "user" },
) => executeRuntimeWorkflowRequest(workflowType, request, env, identity, invocation);

export const runtimeWorkflowTypeForPath = (pathname: string): string | null => {
  const prefix = "/workbench/workflows/";
  if (!pathname.startsWith(prefix)) return null;
  const workflowType = decodeURIComponent(pathname.slice(prefix.length));
  return workflowType || null;
};
