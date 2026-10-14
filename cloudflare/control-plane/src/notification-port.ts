import type {
  AgentPackNotification,
  RuntimeNotificationEvent,
  RuntimeNotificationPort,
} from "@operloom/agent-sdk";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { appendControlPlaneEvent } from "./control-plane-events";
import { enqueueNotificationEvent } from "./notification-delivery";
import { notificationSeverities } from "./notification-channels";
import type { AgentIdentity, Env } from "./types";

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

const validEvent = (event: RuntimeNotificationEvent) =>
  event &&
  typeof event.type === "string" &&
  typeof event.title === "string" &&
  event.title.trim().length > 0 &&
  event.title.length <= 120 &&
  typeof event.body === "string" &&
  event.body.length <= 2000 &&
  event.target &&
  typeof event.target.type === "string" &&
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(event.target.type) &&
  typeof event.target.id === "string" &&
  event.target.id.length > 0 &&
  event.target.id.length <= 200 &&
  (notificationSeverities as readonly string[]).includes(event.severity);

export const manifestNotifications = (packId: string): readonly AgentPackNotification[] => {
  const entry = agentManifestRegistry[packId as keyof typeof agentManifestRegistry];
  return (
    (entry?.module as { notifications?: readonly AgentPackNotification[] } | undefined)
      ?.notifications ?? []
  );
};

/** Records a declared notification as a control-plane event and routes it by the user's preferences. */
export const createNotificationPort = (
  env: Env,
  identity: AgentIdentity,
  pack: { id: string },
  runId: string,
): RuntimeNotificationPort => ({
  async emit(event) {
    if (!validEvent(event))
      throw fail("notification_event_invalid", "Notification event is invalid.");
    const declared = manifestNotifications(pack.id).find((item) => item.type === event.type);
    if (!declared)
      throw fail(
        "notification_type_undeclared",
        `Notification type ${event.type} is not declared.`,
      );
    const appended = await appendControlPlaneEvent(env, identity, {
      type: event.type,
      summary: event.title,
      targetType: event.target.type,
      targetId: event.target.id,
      data: { severity: event.severity, body: event.body, packId: pack.id, runId },
    });
    const { queued } = await enqueueNotificationEvent(env, identity, {
      type: event.type,
      targetType: event.target.type,
      targetId: event.target.id,
      package: {
        severity: event.severity,
        title: event.title,
        body: event.body,
        defaultChannels: declared.defaultChannels,
      },
    });
    return { eventId: appended, queued };
  },
});
