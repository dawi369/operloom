import {
  defineControlPlaneModule,
  type ControlPlaneRuntimeModule,
  type RuntimeRecord,
} from "@operloom/agent-sdk/control-plane";

const objectSchema = { type: "object", additionalProperties: false } as const;
const policy = (reference: string, modelVisible = false) => ({
  reference,
  adminVisible: true,
  modelVisible,
  requiresApproval: false,
  policyEditable: true,
  mutationRisk: "read_only" as const,
});

const mutationPolicy = {
  reference: "operator.action.execute.v1",
  adminVisible: true,
  modelVisible: false,
  requiresApproval: true,
  policyEditable: true,
  mutationRisk: "mutation_capable" as const,
};

export const operatorSnapshotTool = {
  id: "operator.snapshot",
  description: "Return a deterministic signed-runner snapshot.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    additionalProperties: false,
    properties: { subject: { type: "string", minLength: 1, maxLength: 80 } },
  },
  outputSchema: { type: "object", required: ["subject", "observedAt", "status"] },
  executionModes: ["dry_run"],
  transport: "fly",
  adapterVersion: "operator-snapshot-v1",
  timeoutMs: 2_000,
  maxArtifactBytes: 8_192,
  sandbox: {
    lifecycle: {
      template: "operator-snapshot-v1",
      setup: "per_invocation",
      workspaceState: "none",
      filesystem: "ephemeral",
      artifactPromotion: "metadata_only",
    },
    network: {
      egress: "none",
      allowedSchemes: [],
      allowedHosts: [],
      deniedHosts: ["*"],
      privateNetwork: "deny",
      enforcement: "control_plane_and_runner",
    },
    limits: { maxRuntimeMs: 2_000, maxArtifactBytes: 8_192 },
  },
  policy: {
    reference: "operator.snapshot.v1",
    adminVisible: true,
    modelVisible: false,
    requiresApproval: false,
    policyEditable: false,
    mutationRisk: "read_only",
  },
} as const;

const controlPlaneDefinition: Omit<ControlPlaneRuntimeModule, "apiVersion" | "kind"> = {
  packId: "complex-operator",
  runtimeVersion: "1.2.3",
  compatiblePackVersions: "^1.1.0",
  tools: [
    {
      id: "operator.signal.read",
      description: "Return a deterministic Cloudflare-native signal.",
      inputSchema: objectSchema,
      outputSchema: { type: "object", required: ["signal"] },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "operator-signal-v1",
      timeoutMs: 1_000,
      maxArtifactBytes: 8_192,
      policy: policy("operator.signal.read.v1", true),
      execute: () => ({
        ok: true,
        output: { signal: "nominal", sequence: 1 },
        summary: "Deterministic operator signal is nominal.",
      }),
    },
    {
      id: "operator.action.propose",
      description: "Create an auditable dry-run action proposal.",
      inputSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 160 },
          preview: { type: "object", additionalProperties: true },
        },
      },
      outputSchema: { type: "object", required: ["proposalId", "status"] },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "operator-proposal-v1",
      timeoutMs: 1_000,
      maxArtifactBytes: 8_192,
      policy: policy("operator.action.propose.v1"),
      async execute(input, context) {
        const proposal = await context.actions.propose({
          toolId: "operator.action.execute",
          type: "operator.synthetic_action",
          summary: String(input.summary),
          idempotencyKey: `${context.run.id}-proposal`,
          preview:
            input.preview && typeof input.preview === "object"
              ? (input.preview as RuntimeRecord)
              : { mutation: false },
        });
        return {
          ok: true,
          output: proposal as unknown as RuntimeRecord,
          summary: "Dry-run action proposal created; mutation remains disabled.",
        };
      },
    },
    {
      id: "operator.action.execute",
      description: "Execute an approved deterministic synthetic action.",
      inputSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 160 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
          preview: { type: "object", additionalProperties: true },
        },
      },
      outputSchema: {
        type: "object",
        required: ["status", "summary"],
        additionalProperties: true,
      },
      executionModes: ["dry_run", "execute"],
      transport: "fly",
      adapterVersion: "operator-action-v2",
      timeoutMs: 11_000,
      maxArtifactBytes: 8_192,
      sandbox: {
        lifecycle: {
          template: "operator-action-v2",
          setup: "per_invocation",
          workspaceState: "none",
          filesystem: "ephemeral",
          artifactPromotion: "metadata_only",
        },
        network: {
          egress: "broker_only",
          allowedSchemes: ["https"],
          allowedHosts: ["platform-connection-broker"],
          deniedHosts: ["*"],
          privateNetwork: "deny",
          enforcement: "control_plane_and_runner",
        },
        limits: { maxRuntimeMs: 11_000, maxArtifactBytes: 8_192 },
      },
      policy: mutationPolicy,
      action: {
        connectionId: "operator.external-account",
        proposalSchema: {
          type: "object",
          required: ["mutation"],
          additionalProperties: true,
          properties: { mutation: { type: "boolean" } },
        },
        resultSchema: {
          type: "object",
          required: ["status", "idempotencyKey"],
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            idempotencyKey: { type: "string" },
          },
        },
        idempotency: "required",
        approval: "required",
        timeoutMs: 7_000,
        execute(proposal) {
          if (proposal.preview.outcome === "unknown") {
            return {
              proposalId: "pending",
              status: "outcome_unknown",
              summary: "Synthetic provider accepted the request but withheld its outcome.",
              externalReference: `synthetic:${proposal.idempotencyKey}`,
              output: { status: "outcome_unknown", idempotencyKey: proposal.idempotencyKey },
            };
          }
          return {
            proposalId: "pending",
            status: "executed",
            summary: "Synthetic external action executed idempotently.",
            externalReference: `synthetic:${proposal.idempotencyKey}`,
            output: { status: "executed", idempotencyKey: proposal.idempotencyKey },
          };
        },
        async reconcile(proposal, context) {
          const connection = await context.connections.resolve(
            "operator.external-account",
            "operator.action.execute",
          );
          if (connection.status !== "authorized" || !connection.request) {
            return {
              proposalId: "pending",
              status: "failed",
              summary: "The synthetic provider could not be queried for reconciliation.",
            };
          }
          const response = await connection.request({
            url: "broker://configured",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              idempotencyKey: proposal.idempotencyKey,
              reconcile: true,
            }),
          });
          const body = JSON.parse(response.body) as {
            externalReference?: string;
            found?: boolean;
          };
          return {
            proposalId: "pending",
            status: body.found ? "reconciled" : "outcome_unknown",
            summary: body.found
              ? "Synthetic external action outcome reconciled through the connection broker."
              : "The synthetic provider has not recorded a terminal outcome.",
            externalReference: body.externalReference,
            output: {
              status: body.found ? "reconciled" : "outcome_unknown",
              idempotencyKey: proposal.idempotencyKey,
            },
          };
        },
      },
      execute() {
        return {
          ok: false,
          error: {
            code: "action_authority_required",
            message: "Use the durable action proposal and approval flow.",
            redacted: true,
          },
          summary: "Durable action authority is required.",
        };
      },
    },
    operatorSnapshotTool,
  ],
  workflows: [
    {
      type: "complex-operator.observe",
      engine: "cloudflare",
      label: "Observe system",
      description: "Combine inline and signed-runner evidence into a report.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", minLength: 1, maxLength: 80, default: "demo-system" },
        },
      },
      outputSchema: { type: "object", required: ["status", "signal", "snapshot"] },
      form: [
        {
          name: "subject",
          label: "Subject",
          description: "Bounded synthetic subject.",
          kind: "text",
          placeholder: "demo-system",
        },
      ],
      toolIds: ["operator.signal.read", "operator.snapshot", "operator.action.propose"],
      cancellation: { adapter: "external", physicalAbort: "best_effort" },
      smokeCommand: "pnpm agent-packs:test --pack complex-operator",
      async execute(input, context) {
        const signal = await context.tools.invoke("operator.signal.read", {});
        if (!signal.ok) return signal;
        const snapshot = await context.tools.invoke("operator.snapshot", {
          subject: String(input.subject ?? "demo-system"),
        });
        if (!snapshot.ok) return snapshot;
        const subject = String(input.subject ?? "demo-system");
        const proposal = await context.tools.invoke("operator.action.propose", {
          summary: `Review ${subject}`,
          preview: {
            mutation: false,
            ...(subject === "timeout" ? { delayMs: 9_000 } : {}),
          },
        });
        if (!proposal.ok) return proposal;
        const report = {
          status: "review",
          signal: signal.output,
          snapshot: snapshot.output,
          proposal: proposal.output,
        };
        await context.managedState.upsert({
          namespace: "complex-operator",
          stateType: "observation",
          stateKey: "current",
          status: "review",
          summary: "Deterministic observation completed.",
          data: report,
        });
        return {
          ok: true,
          output: report,
          summary: "Complex operator observation completed.",
          artifacts: [
            {
              kind: "complex_operator_report",
              title: "Complex operator report",
              mimeType: "application/json",
              data: report,
            },
          ],
        };
      },
    },
    {
      type: "complex-operator.status",
      engine: "cloudflare",
      label: "Check operator status",
      description: "Exercise a second isolated workflow with explicit conformance input.",
      inputSchema: {
        type: "object",
        required: ["scope"],
        additionalProperties: false,
        properties: { scope: { type: "string", minLength: 1, maxLength: 80 } },
      },
      outputSchema: {
        type: "object",
        required: ["scope", "signal"],
        additionalProperties: false,
        properties: {
          scope: { type: "string" },
          signal: { type: "object" },
        },
      },
      conformanceInput: { scope: "installed-package" },
      form: [
        {
          name: "scope",
          label: "Scope",
          description: "Deterministic status scope.",
          kind: "text",
          placeholder: "installed-package",
        },
      ],
      toolIds: ["operator.signal.read"],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(input, context) {
        const signal = await context.tools.invoke("operator.signal.read", {});
        if (!signal.ok) return signal;
        return {
          ok: true,
          output: { scope: String(input.scope), signal: signal.output },
          summary: "Complex operator status checked.",
        };
      },
    },
  ],
  health: [
    {
      id: "signal.binding",
      required: true,
      check: () => ({ ok: true, summary: "Inline signal binding is ready." }),
    },
    {
      id: "snapshot.binding",
      required: true,
      check: () => ({ ok: true, summary: "Signed runner binding is registered." }),
    },
    {
      id: "workflow.binding",
      required: true,
      check: () => ({ ok: true, summary: "Multi-step workflow binding is ready." }),
    },
  ],
  evals: [
    {
      id: "operator.static",
      required: true,
      run: () => ({ ok: true, summary: "Complex Operator static contract passed." }),
    },
    {
      id: "operator.runtime",
      required: true,
      run: () => ({ ok: true, summary: "Runtime execution is covered by conformance." }),
    },
  ],
};

export const controlPlane = defineControlPlaneModule(controlPlaneDefinition);

export const operatorActionTool = controlPlane.tools.find(
  (tool) => tool.id === "operator.action.execute",
)!;
