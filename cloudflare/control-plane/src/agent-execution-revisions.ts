/** D1 wraps trigger errors; never expose the surrounding SQL or bound values. */
export const agentRevisionConflict = (error: unknown) =>
  error instanceof Error && error.message.includes("agent_runtime_revision_conflict")
    ? {
        code: "agent_runtime_revision_conflict",
        error:
          "The agent runtime changed before execution began. Refresh its configuration and submit a new command.",
      }
    : null;
