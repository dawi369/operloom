export type WorkbenchSessionEventType =
  | "session.snapshot"
  | "session.thread.created"
  | "session.thread.activated"
  | "session.agent.handoff"
  | "session.thread.updated"
  | "session.threads.refreshed"
  | "chat.run.started"
  | "chat.run.completed"
  | "chat.run.failed"
  | "chat.turn.queued"
  | "chat.turn.steered"
  | "workflow.run.updated"
  | "approval.updated"
  | "action.updated"
  | "tool.run.updated"
  | "trace.updated"
  | "admin.summary.invalidated";

export type WorkbenchSessionEvent = {
  id: string;
  type: WorkbenchSessionEventType;
  revision?: number;
  createdAt: string;
  data: Record<string, unknown>;
};
