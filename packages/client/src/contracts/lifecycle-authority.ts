import type { Id } from "../core-contracts.js";

export type CreateArtifactBlobInput = {
  kind: string;
  title?: string;
  mimeType: string;
  contentBase64: string;
  retentionClass?: "standard";
  data?: Record<string, unknown>;
};

export type CloudflareArtifactBlobResponse = {
  ok?: boolean;
  artifact?: {
    id: Id;
    kind: string;
    uri: string;
    title?: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    retentionClass: "standard";
    createdAt: string;
  };
  error?: string;
};

export type CloudflareRetentionPolicyResponse = {
  ok?: boolean;
  policy?: {
    artifactRetentionDays: number;
    operationalEventRetentionDays: number;
    runtimeTraceRetentionDays: number;
    chatMessageRetentionDays: number;
    runPayloadRetentionDays: number;
    auditActionRetentionDays: number;
    confirmed: boolean;
    confirmedAt?: string;
    source: "default" | "workspace";
    updatedAt?: string;
  };
  error?: string;
};

export type CloudflareConnectionsResponse = {
  ok?: boolean;
  enabled?: boolean;
  packId?: string | null;
  connections?: Array<{
    id: string;
    provider: string;
    principal: "none" | "app" | "user";
    credentialClass: "none" | "oauth2" | "api_key";
    required: boolean;
    toolIds: string[];
    requestedScopes: string[];
    status: string;
    grantedScopes: string[];
    tokenExpiresAt?: string;
    lastHealthAt?: string;
    lastErrorCode?: string;
    version?: number;
  }>;
  error?: string;
};

export type ConnectionAuthorizationResponse = {
  ok: boolean;
  authorizationUrl: string;
  expiresAt: string;
  error?: string;
};

export type CloudflareActionsResponse = {
  ok?: boolean;
  proposals?: Array<{
    id: Id;
    toolId: string;
    actionType: string;
    proposal?: Record<string, unknown>;
    result?: Record<string, unknown>;
    review?: { requestHash: string; expiresAt: string } | null;
    providerOperation?: {
      id: Id;
      operationId: string;
      version: string;
      status: "dispatching" | "succeeded" | "failed" | "outcome_unknown";
      output: Record<string, unknown>;
      updatedAt: string;
    } | null;
    status: string;
    summary: string;
    externalReference?: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
    terminalAt?: string | null;
    ledger: Array<{
      sequence: number;
      status: string;
      summary: string;
      externalReference?: string | null;
      createdAt: string;
    }>;
  }>;
  result?: Record<string, unknown>;
  approvalRequest?: { id: Id; status: string; requestHash?: string; expiresAt?: string };
  error?: string;
};

export type CloudflareDataJobResponse = {
  ok?: boolean;
  job?: {
    id: Id;
    kind: "export" | "purge";
    status: string;
    attemptCount?: number;
    manualRetryCount?: number;
    lastErrorCode?: string;
    lastFailedAt?: string;
    sizeBytes?: number;
    contentSha256?: string;
    expiresAt?: string;
    createdAt: string;
    updatedAt?: string;
    completedAt?: string;
  };
  error?: string;
};

export type CloudflareWorkspaceDeletionResponse = {
  ok?: boolean;
  deletion?: {
    status: string;
    requestedAt?: string;
    purgeAfter?: string;
    recoveredAt?: string;
    credentialsRecoverable?: boolean;
    credentialRevocation?: "completed" | "pending_retry";
    purgeJobId?: string;
    phase?: string;
    attemptCount?: number;
    manualRetryCount?: number;
    lastErrorCode?: string;
    lastFailedAt?: string;
    canRetry?: boolean;
    canRecover?: boolean;
    credentialsRestored?: boolean;
    triggersRestored?: boolean;
  };
  error?: string;
};

export type CloudflareKillSwitchesResponse = {
  ok?: boolean;
  killSwitches?: Array<Record<string, unknown>>;
  killSwitch?: Record<string, unknown>;
  error?: string;
};

export type ClientDeviceSummary = {
  id: Id;
  installationId: string;
  platform: "ios" | "android";
  provider: "expo";
  status: "active" | "disabled" | "revoked";
  lastSeenAt: string;
  appVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudflareClientDevicesResponse = {
  ok: boolean;
  enabled?: boolean;
  devices?: ClientDeviceSummary[];
  device?: ClientDeviceSummary;
  revoked?: boolean;
  error?: string;
};

export type CloudflareNotificationPreferencesResponse = {
  ok: boolean;
  enabled?: boolean;
  preferences?: {
    approvalRequired: boolean;
    terminalOutcomes: boolean;
    updatedAt?: string;
  };
  error?: string;
};
