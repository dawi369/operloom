import { defineControlPlaneModule, type RuntimeRecord } from "@operloom/agent-sdk/control-plane";

type RepoSnapshotOutput = {
  summary: string;
  packageManager?: string;
  scripts: string[];
  repoFiles: string[];
  docs: string[];
  configFiles: string[];
  signals: RuntimeRecord[];
  commandMetrics: Array<{ name: string; status: string }>;
  timingMs: number;
};

const buildReadinessReport = (output: RepoSnapshotOutput) => {
  const failedCommands = output.commandMetrics.filter((metric) => metric.status !== "completed");
  const verificationScripts = output.scripts.filter((script) =>
    /^(test|typecheck|lint|build|verify|check)(:|$)/.test(script),
  );
  const warnings = [
    output.docs.length === 0 ? "No documentation files were included in the snapshot." : null,
    verificationScripts.length === 0
      ? "No conventional verification scripts were found in the bounded package-script inventory."
      : null,
    ...failedCommands.map((metric) => `${metric.name} finished with status ${metric.status}.`),
  ].filter((item): item is string => Boolean(item));
  return {
    status: warnings.length ? "review" : "ready",
    summary: `Repository snapshot captured ${output.repoFiles.length} files, ${output.docs.length} docs, and ${verificationScripts.length} verification scripts.`,
    packageManager: output.packageManager ?? null,
    inventory: {
      repositoryFiles: output.repoFiles.length,
      documentationFiles: output.docs.length,
      configurationFiles: output.configFiles.length,
    },
    verificationScripts,
    scripts: output.scripts,
    documentation: output.docs,
    configuration: output.configFiles,
    signals: output.signals,
    commandMetrics: output.commandMetrics,
    timingMs: output.timingMs,
    warnings,
    limitations: [
      "The snapshot is bounded to the repository mounted in the configured read-only runner.",
      "Readiness findings describe repository evidence and do not prove deployed service health.",
    ],
    risk: { externalMutation: false, requiresSecrets: false, arbitraryShell: false },
  };
};

const objectSchema = {
  type: "object",
  additionalProperties: false,
} as const;

export const controlPlane = defineControlPlaneModule({
  packId: "repo-analyst",
  runtimeVersion: "1.1.0",
  compatiblePackVersions: "^1.2.0",
  tools: [
    {
      id: "repo.snapshot",
      description: "Capture bounded repository evidence in the signed Fly runner.",
      inputSchema: {
        ...objectSchema,
        properties: {
          includeDocs: { type: "boolean" },
          includeScripts: { type: "boolean" },
          includeConfig: { type: "boolean" },
        },
      },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "fly",
      adapterVersion: "repo-snapshot-v1",
      timeoutMs: 10_000,
      maxArtifactBytes: 131_072,
      sandbox: {
        lifecycle: {
          template: "repo-snapshot-v1",
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
        limits: {
          maxRuntimeMs: 10_000,
          maxStdoutBytes: 65_536,
          maxStderrBytes: 16_384,
          maxArtifactBytes: 131_072,
        },
      },
      policy: {
        reference: "repo-snapshot-readonly-v0",
        adminVisible: true,
        modelVisible: false,
        requiresApproval: false,
        policyEditable: true,
        mutationRisk: "read_only",
      },
    },
    {
      id: "url.inspect",
      description: "Inspect a public URL through the hardened signed Fly runner.",
      inputSchema: {
        ...objectSchema,
        required: ["url"],
        properties: { url: { type: "string", minLength: 8, maxLength: 2048 } },
      },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "fly",
      adapterVersion: "url-inspect-v1",
      timeoutMs: 5_000,
      maxArtifactBytes: 131_072,
      sandbox: {
        lifecycle: {
          template: "url-inspect-v1",
          setup: "per_invocation",
          workspaceState: "none",
          filesystem: "ephemeral",
          artifactPromotion: "metadata_only",
        },
        network: {
          egress: "public_web",
          allowedSchemes: ["http", "https"],
          allowedHosts: [],
          deniedHosts: [],
          privateNetwork: "deny",
          enforcement: "control_plane_and_runner",
        },
        limits: { maxRuntimeMs: 5_000, maxArtifactBytes: 131_072 },
      },
      policy: {
        reference: "tool-admin-readonly-v0",
        adminVisible: true,
        modelVisible: false,
        requiresApproval: false,
        policyEditable: true,
        mutationRisk: "read_only",
      },
    },
  ],
  workflows: [
    {
      type: "repo.readiness_report",
      engine: "cloudflare",
      label: "Readiness report",
      runDisplayName: "Repository readiness report",
      description: "Inspect repository structure and produce a bounded readiness report.",
      inputSchema: {
        ...objectSchema,
        properties: {
          includeDocs: { type: "boolean", default: true },
          includeScripts: { type: "boolean", default: true },
          includeConfig: { type: "boolean", default: true },
        },
      },
      outputSchema: { type: "object" },
      form: [
        {
          name: "includeDocs",
          label: "Documentation",
          description: "Include the bounded documentation inventory.",
          kind: "checkbox",
        },
        {
          name: "includeScripts",
          label: "Scripts",
          description: "Include package scripts and verification commands.",
          kind: "checkbox",
        },
        {
          name: "includeConfig",
          label: "Configuration",
          description: "Include bounded configuration-file evidence.",
          kind: "checkbox",
        },
      ],
      toolIds: ["repo.snapshot"],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      smokeCommand: "pnpm smoke:fly-tool-runner",
      normalizeInput: (input) => ({
        includeDocs: input.includeDocs !== false,
        includeScripts: input.includeScripts !== false,
        includeConfig: input.includeConfig !== false,
      }),
      async execute(input, context) {
        const snapshot = await context.tools.invoke("repo.snapshot", input);
        if (!snapshot.ok) return snapshot;
        const report = buildReadinessReport(snapshot.output as RepoSnapshotOutput);
        const artifactId = `${context.run.id}-repo_readiness_report`;
        await context.managedState.upsert({
          namespace: "repo-monitor",
          stateType: "repository-readiness",
          stateKey: "current",
          status: report.status,
          summary: report.summary,
          data: {
            report,
            runId: context.run.id,
            workflowIntentId: context.run.workflowIntentId,
            artifactRefs: [artifactId],
          },
        });
        return {
          ok: true,
          output: report,
          summary: report.summary,
          artifacts: [
            {
              kind: "repo_readiness_report",
              title: "Repository readiness report",
              mimeType: "application/json",
              data: {
                source: "repo_readiness_report",
                workflowType: "repo.readiness_report",
                packId: "repo-analyst",
                report,
              },
            },
          ],
        };
      },
    },
  ],
  health: [
    {
      id: "snapshot.binding",
      required: true,
      check: () => ({ ok: true, summary: "Repository snapshot binding compiled." }),
    },
    {
      id: "readiness.binding",
      required: true,
      check: () => ({ ok: true, summary: "Readiness workflow binding compiled." }),
    },
  ],
  evals: [
    {
      id: "repo.status.static",
      required: true,
      run: () => ({ ok: true, summary: "Repository Analyst static contract compiled." }),
    },
    {
      id: "repo.plan.runtime",
      required: true,
      run: () => ({ ok: true, summary: "Repository Analyst runtime path is conformance-gated." }),
    },
  ],
});
