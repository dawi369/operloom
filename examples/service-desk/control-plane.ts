import {
  calendarReadTool,
  defineControlPlaneModule,
  transactionalEmailOperation,
  transactionalEmailSchema,
  type AgentExecutionContext,
  type CalendarEvent,
  type RuntimeRecord,
  type RuntimeResult,
} from "@operloom/agent-sdk/control-plane";

/** Recorded sample used while no calendar is connected (local, conformance, simulation). */
const recordedEvents: CalendarEvent[] = [
  {
    id: "evt-1",
    title: "Roof inspection — 12 Elm St",
    start: "2026-10-15T09:00:00Z",
    end: "2026-10-15T10:00:00Z",
    location: "12 Elm St",
    attendees: ["owner@example.test"],
  },
  {
    id: "evt-2",
    title: "Quote review — Harbor Rd",
    start: "2026-10-15T13:00:00Z",
    end: "2026-10-15T13:30:00Z",
    attendees: [],
  },
];

const calendar = calendarReadTool({
  id: "calendar.read",
  connectionId: "calendar.primary",
  adapter: "google-calendar",
  recorded: recordedEvents,
});

export const controlPlane = defineControlPlaneModule({
  packId: "service-desk",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  requirements: {
    minimumBackendVersion: "2.0.0",
    capabilities: ["workflow.request", "actions.provider_operations"],
  },
  providerOperations: [transactionalEmailOperation({ providerId: "transactional-email" })],
  tools: [
    calendar,
    {
      id: "email.send",
      description:
        "Send a plain-text confirmation email through the reviewed transactional provider.",
      inputSchema: transactionalEmailSchema,
      outputSchema: { type: "object" },
      executionModes: ["dry_run", "execute"],
      transport: "cloudflare_inline",
      adapterVersion: "transactional-email-v1",
      timeoutMs: 15_000,
      maxArtifactBytes: 8_192,
      policy: {
        reference: "email.send.v1",
        adminVisible: true,
        modelVisible: false,
        requiresApproval: true,
        policyEditable: true,
        mutationRisk: "mutation_capable",
      },
      action: {
        connectionId: "email.transactional",
        proposalSchema: transactionalEmailSchema,
        resultSchema: { type: "object", required: ["requestId", "messageId", "status"] },
        idempotency: "required",
        approval: "required",
        timeoutMs: 10_000,
        providerOperation: { id: "email.send", version: "1" },
        simulate: (proposal) => ({
          requestId: `simulation:${proposal.idempotencyKey}`,
          messageId: `sim-${proposal.idempotencyKey}`,
          status: "queued",
        }),
      },
    },
  ],
  workflows: [
    {
      type: "service-desk.agenda",
      label: "Today's agenda",
      description: "List calendar events in a window through the broker.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: { type: "string", minLength: 10, maxLength: 40 },
          to: { type: "string", minLength: 10, maxLength: 40 },
        },
      },
      outputSchema: { type: "object", required: ["events", "source"] },
      conformanceInput: { from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z" },
      form: [
        { name: "from", label: "From", description: "Window start (ISO)", kind: "text" },
        { name: "to", label: "To", description: "Window end (ISO)", kind: "text" },
      ],
      toolIds: ["calendar.read"],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(input: RuntimeRecord, context: AgentExecutionContext): Promise<RuntimeResult> {
        const result = await context.tools.invoke("calendar.read", input);
        if (!result.ok) return result;
        const events = (result.output.events as CalendarEvent[]) ?? [];
        return {
          ok: true,
          output: { events, source: result.output.source },
          summary: `${events.length} event${events.length === 1 ? "" : "s"} (${String(result.output.source)}).`,
        };
      },
    },
    {
      type: "service-desk.confirm",
      label: "Confirm appointment",
      description: "Propose a confirmation email; it is sent only after operator approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["to", "subject", "text"],
        properties: transactionalEmailSchema.properties as Record<string, unknown>,
      },
      outputSchema: { type: "object", required: ["proposalId", "status"] },
      conformanceInput: {
        to: ["owner@example.test"],
        subject: "Your roof inspection is confirmed",
        text: "See you Wednesday at 9:00.",
      },
      form: [
        { name: "to", label: "To", description: "Recipient addresses", kind: "text" },
        { name: "subject", label: "Subject", description: "Email subject", kind: "text" },
        { name: "text", label: "Text", description: "Plain-text body", kind: "text" },
      ],
      // The action is proposed, not invoked inline; approval happens on the proposal.
      toolIds: [],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(input: RuntimeRecord, context: AgentExecutionContext): Promise<RuntimeResult> {
        const proposal = await context.actions.propose({
          toolId: "email.send",
          type: "email.send",
          summary: `Email ${String((input.to as string[])[0])}: ${String(input.subject)}`,
          idempotencyKey: `${context.run.id}.confirm`,
          preview: { to: input.to, subject: input.subject, text: input.text },
        });
        return {
          ok: true,
          output: { proposalId: proposal.proposalId, status: proposal.status },
          summary: "Confirmation email proposed for review.",
        };
      },
    },
  ],
  health: [],
  evals: [],
});
