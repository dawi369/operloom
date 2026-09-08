import { createAgentBehaviorSnapshot } from "./agent-behavior-templates";
import {
  accountIdHeader,
  accountSourceHeader,
  agentIdHeader,
  json,
  parseJson,
  parseDataJson,
  readRequiredHeader,
  type ControlPlaneAuthContext,
  userIdHeader,
  workspaceIdHeader,
} from "./http";
import {
  countWorkspaceMemberships,
  selectActiveAgentPreference,
  selectActiveWorkspacePreference,
  selectAgent,
  selectDefaultAgent,
  selectDefaultWorkspaceForAccount,
  selectMembership,
  selectUser,
  selectWorkspace,
} from "./authz-store";
import { adminMembershipRoles } from "./membership-policy";
import type { RuntimeTraceInputSpan } from "./runtime-traces";
import { createId, toJson, type AgentIdentity, type Env } from "./types";

const userEmailHeader = "x-assistant-mk1-user-email";
const userNameHeader = "x-assistant-mk1-user-name";
const membershipRoleHeader = "x-assistant-mk1-membership-role";
const membershipRolesHeader = "x-assistant-mk1-membership-roles";
const membershipPermissionsHeader = "x-assistant-mk1-membership-permissions";
const membershipStatusHeader = "x-assistant-mk1-membership-status";
const workspaceNameHeader = "x-assistant-mk1-workspace-name";
const workspaceStatusHeader = "x-assistant-mk1-workspace-status";

type ResolveResult =
  | { ok: true; identity: AgentIdentity; authzSpans: RuntimeTraceInputSpan[] }
  | { ok: false; response: Response };

const withAuthzSpan = async <T>(
  authzSpans: RuntimeTraceInputSpan[],
  input: Pick<RuntimeTraceInputSpan, "name" | "layer" | "data">,
  fn: () => Promise<T>,
) => {
  const startedAtMs = Date.now();
  try {
    return await fn();
  } finally {
    authzSpans.push({
      name: input.name,
      layer: input.layer,
      startedAtMs,
      endedAtMs: Date.now(),
      data: input.data,
    });
  }
};

const readOptionalHeader = (request: Request, name: string) =>
  request.headers.get(name)?.trim() || undefined;

const parseStringArrayHeader = (value: string | undefined) => {
  if (!value) return [];
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
};

const firstPresent = (...values: Array<string | undefined>) =>
  values.find((value) => value && value.trim())?.trim();

export const defaultAgentId = (workspaceId: string) => `agent-${workspaceId}`;
export const defaultWorkspaceId = (accountId: string) => `workspace:${accountId}:default`;

const normalizedAdminRole = (role: string | undefined) => {
  const normalized = role?.trim().toLowerCase();
  return normalized && adminMembershipRoles.has(normalized) ? normalized : undefined;
};

const initialMembershipSeed = (input: {
  isFirstMembership: boolean;
  externalRole?: string;
  externalRoles: string[];
  externalPermissions: string[];
  status?: string;
}) => {
  const externalAdminRole =
    normalizedAdminRole(input.externalRole) ??
    input.externalRoles.map(normalizedAdminRole).find((role) => role);
  const role = input.isFirstMembership ? "owner" : (externalAdminRole ?? "member");
  const roles = Array.from(
    new Set([
      role,
      ...input.externalRoles.map((externalRole) => externalRole.trim()).filter(Boolean),
    ]),
  );

  return {
    role,
    roles,
    permissions: input.externalPermissions,
    status: input.status ?? "active",
  };
};

const upsertUser = async (
  env: Env,
  input: { userId: string; email?: string; displayName?: string },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, status, data_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       display_name = COALESCE(excluded.display_name, users.display_name),
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.userId,
      input.email ?? null,
      input.displayName ?? null,
      toJson({ provider: "workos" }),
      timestamp,
      timestamp,
    )
    .run();
};

const upsertDefaultWorkspace = async (
  env: Env,
  input: {
    workspaceId: string;
    accountId: string;
    accountSource: string;
    userId: string;
    name?: string;
    status?: string;
  },
) => {
  const timestamp = new Date().toISOString();
  const name = input.name ?? "Default Workspace";
  const status = input.status ?? "active";
  await env.DB.prepare(
    `INSERT INTO workspaces (
       id, account_id, account_source, name, status, is_default, created_by_user_id,
       data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       account_source = excluded.account_source,
       name = CASE WHEN ? = 1 THEN excluded.name ELSE workspaces.name END,
       is_default = excluded.is_default,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.workspaceId,
      input.accountId,
      input.accountSource,
      name,
      status,
      input.userId,
      toJson({
        provider: "workos",
        accountId: input.accountId,
        accountSource: input.accountSource,
      }),
      timestamp,
      timestamp,
      input.name ? 1 : 0,
    )
    .run();
  await ensureDefaultRetentionPolicy(env, input.userId, input.workspaceId);
};

const ensureDefaultRetentionPolicy = async (env: Env, userId: string, workspaceId: string) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO control_retention_policies (
       user_id, workspace_id, artifact_retention_days, operational_event_retention_days,
       runtime_trace_retention_days, chat_message_retention_days, run_payload_retention_days,
       audit_action_retention_days, created_at, updated_at
     ) VALUES (?, ?, 90, 30, 14, 90, 90, 365, ?, ?)`,
  )
    .bind(userId, workspaceId, timestamp, timestamp)
    .run();
};

export const insertWorkspace = async (
  env: Env,
  input: {
    workspaceId: string;
    accountId: string;
    accountSource: string;
    userId: string;
    name: string;
    isDefault?: boolean;
  },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workspaces (
       id, account_id, account_source, name, status, is_default, created_by_user_id,
       data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.workspaceId,
      input.accountId,
      input.accountSource,
      input.name,
      input.isDefault ? 1 : 0,
      input.userId,
      toJson({
        provider: "workos",
        accountId: input.accountId,
        accountSource: input.accountSource,
      }),
      timestamp,
      timestamp,
    )
    .run();
  await ensureDefaultRetentionPolicy(env, input.userId, input.workspaceId);
};

export const upsertMembership = async (
  env: Env,
  input: {
    userId: string;
    workspaceId: string;
    role: string;
    roles: string[];
    permissions: string[];
    status?: string;
  },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO memberships (
       id, user_id, workspace_id, role, status, roles_json, permissions_json, data_json,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id) DO UPDATE SET
       updated_at = excluded.updated_at`,
  )
    .bind(
      createId("membership"),
      input.userId,
      input.workspaceId,
      input.role,
      input.status ?? "active",
      toJson(input.roles),
      toJson(input.permissions),
      toJson({ provider: "workos" }),
      timestamp,
      timestamp,
    )
    .run();
};

export const createDefaultAgentIfMissing = async (
  env: Env,
  input: { workspaceId: string; userId: string },
) => {
  const existing = await selectDefaultAgent(env, input.workspaceId);
  if (existing) {
    const data = parseDataJson(existing.data_json);
    // Upgrade only the untouched bootstrap record; custom agents and saved choices survive.
    if (
      existing.name === "Default Agent" &&
      data.bootstrap === "workos" &&
      data.profile === "default" &&
      !data.behavior
    ) {
      await env.DB.prepare(
        `UPDATE agents SET name = ?, description = ?, data_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND name = ? AND data_json = ?`,
      )
        .bind(
          "Operloom",
          "Your everyday assistant for thinking, writing, debugging, and planning.",
          toJson({ ...data, behavior: createAgentBehaviorSnapshot("default") }),
          new Date().toISOString(),
          existing.id,
          input.workspaceId,
          existing.name,
          existing.data_json,
        )
        .run();
    }
    return;
  }

  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO agents (
       id, workspace_id, name, description, status, is_default, created_by_user_id,
       data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
  )
    .bind(
      defaultAgentId(input.workspaceId),
      input.workspaceId,
      "Operloom",
      "Your everyday assistant for thinking, writing, debugging, and planning.",
      input.userId,
      toJson({
        bootstrap: "workos",
        profile: "default",
        behavior: createAgentBehaviorSnapshot("default"),
      }),
      timestamp,
      timestamp,
    )
    .run();
};

export const upsertActiveWorkspacePreference = async (
  env: Env,
  input: { userId: string; accountId: string; workspaceId: string; reason: string },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO active_workspace_preferences (
       user_id, account_id, workspace_id, data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       data_json = excluded.data_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.userId,
      input.accountId,
      input.workspaceId,
      toJson({ reason: input.reason }),
      timestamp,
      timestamp,
    )
    .run();
};

export const upsertActiveAgentPreference = async (
  env: Env,
  input: { userId: string; workspaceId: string; agentId: string; reason: string },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO active_agent_preferences (
       user_id, workspace_id, agent_id, data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       data_json = excluded.data_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.userId,
      input.workspaceId,
      input.agentId,
      toJson({ reason: input.reason }),
      timestamp,
      timestamp,
    )
    .run();
};

const bootstrapAuthz = async (
  env: Env,
  request: Request,
  input: { userId: string; accountId: string; accountSource: string; workspaceId: string },
) => {
  const email = readOptionalHeader(request, userEmailHeader);
  const displayName = readOptionalHeader(request, userNameHeader) ?? email;
  const externalRole = firstPresent(readOptionalHeader(request, membershipRoleHeader));
  const roles = parseStringArrayHeader(readOptionalHeader(request, membershipRolesHeader));
  const permissions = parseStringArrayHeader(
    readOptionalHeader(request, membershipPermissionsHeader),
  );
  const membershipStatus = readOptionalHeader(request, membershipStatusHeader);
  const workspaceStatus = readOptionalHeader(request, workspaceStatusHeader);

  await upsertUser(env, { userId: input.userId, email, displayName });
  await upsertDefaultWorkspace(env, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    accountSource: input.accountSource,
    userId: input.userId,
    name: readOptionalHeader(request, workspaceNameHeader),
    status: workspaceStatus,
  });
  const membershipCount = await countWorkspaceMemberships(env, input.workspaceId);
  const membershipSeed = initialMembershipSeed({
    isFirstMembership: (membershipCount?.count ?? 0) === 0,
    externalRole,
    externalRoles: roles,
    externalPermissions: permissions,
    status: membershipStatus,
  });
  await upsertMembership(env, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    ...membershipSeed,
  });
  await createDefaultAgentIfMissing(env, {
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
};

const createLocalExplicitAgentIfMissing = async (
  env: Env,
  input: { userId: string; workspaceId: string; agentId: string },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO agents (
       id, workspace_id, name, description, status, is_default, created_by_user_id,
       data_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
  )
    .bind(
      input.agentId,
      input.workspaceId,
      "Local Development Agent",
      "Explicit local-development workbench agent.",
      input.userId,
      toJson({
        bootstrap: "local-dev",
        profile: "default",
        behavior: createAgentBehaviorSnapshot("default"),
      }),
      timestamp,
      timestamp,
    )
    .run();
};

const selectActiveWorkspaceId = async (
  env: Env,
  input: { userId: string; accountId: string; defaultWorkspaceId: string },
) => {
  const preference = await selectActiveWorkspacePreference(env, {
    userId: input.userId,
    accountId: input.accountId,
  });

  if (preference) return preference.workspace_id;

  await upsertActiveWorkspacePreference(env, {
    userId: input.userId,
    accountId: input.accountId,
    workspaceId: input.defaultWorkspaceId,
    reason: "default-bootstrap",
  });
  return input.defaultWorkspaceId;
};

const selectActiveAgent = async (
  env: Env,
  input: { userId: string; workspaceId: string },
  options: { allowPreferenceBootstrap?: boolean } = {},
) => {
  const preference = await selectActiveAgentPreference(env, input);

  if (preference) {
    const preferredAgent = await selectAgent(env, preference.agent_id, input.workspaceId);
    if (!preferredAgent || preferredAgent.status !== "active") {
      return {
        ok: false as const,
        response: json(
          { ok: false, error: "Active agent preference is not valid" },
          { status: 403 },
        ),
      };
    }
    return { ok: true as const, agent: preferredAgent };
  }

  if (options.allowPreferenceBootstrap === false) {
    return {
      ok: false as const,
      response: json({ ok: false, error: "Active agent preference not found" }, { status: 403 }),
    };
  }

  const defaultAgent = await selectDefaultAgent(env, input.workspaceId);
  if (!defaultAgent || defaultAgent.status !== "active") {
    return {
      ok: false as const,
      response: json({ ok: false, error: "Active default agent not found" }, { status: 403 }),
    };
  }

  await upsertActiveAgentPreference(env, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentId: defaultAgent.id,
    reason: "default-bootstrap",
  });
  return { ok: true as const, agent: defaultAgent };
};

export const resolveAgentIdentity = async (
  request: Request,
  env: Env,
  auth: ControlPlaneAuthContext,
  options: {
    allowedInactiveWorkspaceStatuses?: readonly string[];
    skipBootstrapWrites?: boolean;
  } = {},
): Promise<ResolveResult> => {
  const workspaceStatusAllowed = (status: string) =>
    status === "active" || options.allowedInactiveWorkspaceStatuses?.includes(status) === true;
  const authzSpans: RuntimeTraceInputSpan[] = [];
  const headerStartedAtMs = Date.now();
  const userId = readRequiredHeader(request, userIdHeader);
  const accountId = readRequiredHeader(request, accountIdHeader);
  const accountSource = readRequiredHeader(request, accountSourceHeader);
  const workspaceId = readRequiredHeader(request, workspaceIdHeader);
  const explicitAgentId = readRequiredHeader(request, agentIdHeader);
  authzSpans.push({
    name: "Header/account parse",
    layer: "cloudflare",
    startedAtMs: headerStartedAtMs,
    endedAtMs: Date.now(),
    data: {
      hasAccount: Boolean(accountId),
      hasWorkspace: Boolean(workspaceId),
      hasExplicitAgent: Boolean(explicitAgentId),
    },
  });

  if (!userId) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "x-assistant-mk1-user-id is required",
        },
        { status: 400 },
      ),
    };
  }

  if (explicitAgentId) {
    if (!workspaceId) {
      return {
        ok: false,
        response: json(
          { ok: false, error: "x-assistant-mk1-workspace-id is required for explicit agent" },
          { status: 400 },
        ),
      };
    }
    let resolvedAgentId = explicitAgentId;
    if (auth.mode === "dev_token") {
      if (!accountId || !accountSource) {
        return {
          ok: false,
          response: json(
            { ok: false, error: "Local explicit identity requires account headers" },
            { status: 400 },
          ),
        };
      }
      const [existingUser, existingWorkspace, existingMembership, existingWorkspacePreference] =
        await Promise.all([
          selectUser(env, userId),
          selectWorkspace(env, workspaceId),
          selectMembership(env, userId, workspaceId),
          selectActiveWorkspacePreference(env, { userId, accountId }),
        ]);
      let activeAgentPreference = await selectActiveAgentPreference(env, { userId, workspaceId });
      const existingAgent = activeAgentPreference
        ? await selectAgent(env, activeAgentPreference.agent_id, workspaceId)
        : null;
      const identityAlreadyBootstrapped =
        existingUser?.status === "active" &&
        existingWorkspace?.status === "active" &&
        existingWorkspace.account_id === accountId &&
        existingWorkspace.account_source === accountSource &&
        existingMembership?.status === "active" &&
        existingWorkspacePreference?.workspace_id === workspaceId &&
        existingAgent?.status === "active";
      if (!identityAlreadyBootstrapped) {
        await bootstrapAuthz(env, request, { userId, accountId, accountSource, workspaceId });
        await createLocalExplicitAgentIfMissing(env, {
          userId,
          workspaceId,
          agentId: explicitAgentId,
        });
        await upsertActiveWorkspacePreference(env, {
          userId,
          accountId,
          workspaceId,
          reason: "local-dev-bootstrap",
        });
        activeAgentPreference = await selectActiveAgentPreference(env, { userId, workspaceId });
      }
      if (activeAgentPreference) {
        resolvedAgentId = activeAgentPreference.agent_id;
      } else {
        await upsertActiveAgentPreference(env, {
          userId,
          workspaceId,
          agentId: explicitAgentId,
          reason: "local-dev-bootstrap",
        });
      }
    }

    const [user, workspace, membership, agent] = await Promise.all([
      selectUser(env, userId),
      selectWorkspace(env, workspaceId),
      selectMembership(env, userId, workspaceId),
      selectAgent(env, resolvedAgentId, workspaceId),
    ]);
    if (!user || user.status !== "active") {
      return {
        ok: false,
        response: json({ ok: false, error: "User is not active" }, { status: 403 }),
      };
    }
    if (
      !workspace ||
      !workspaceStatusAllowed(workspace.status) ||
      (accountId && workspace.account_id !== accountId) ||
      (accountSource && workspace.account_source !== accountSource)
    ) {
      return {
        ok: false,
        response: json({ ok: false, error: "Workspace is not active" }, { status: 403 }),
      };
    }
    if (!membership || membership.status !== "active") {
      return {
        ok: false,
        response: json({ ok: false, error: "Workspace membership is not active" }, { status: 403 }),
      };
    }
    if (!agent || agent.status !== "active") {
      return {
        ok: false,
        response: json({ ok: false, error: "Agent is not active" }, { status: 403 }),
      };
    }
    return {
      ok: true,
      identity: {
        scope: { userId, workspaceId },
        agentId: resolvedAgentId,
        accountId: accountId ?? undefined,
        accountSource: accountSource ?? undefined,
        authMode: auth.mode,
      },
      authzSpans,
    };
  }

  if (!accountId || !accountSource) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "x-assistant-mk1-account-id and x-assistant-mk1-account-source are required",
        },
        { status: 400 },
      ),
    };
  }

  const expectedWorkspaceId = defaultWorkspaceId(accountId);
  if (workspaceId && workspaceId !== expectedWorkspaceId) {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "Hosted workspace selection is Cloudflare-owned",
        },
        { status: 400 },
      ),
    };
  }

  if (!options.skipBootstrapWrites) {
    await withAuthzSpan(
      authzSpans,
      {
        name: "User/workspace bootstrap",
        layer: "d1",
        data: { accountSource, defaultWorkspaceId: expectedWorkspaceId },
      },
      () =>
        bootstrapAuthz(env, request, {
          userId,
          accountId,
          accountSource,
          workspaceId: expectedWorkspaceId,
        }),
    );
  }
  const activeWorkspaceId = await withAuthzSpan(
    authzSpans,
    {
      name: "Active workspace preference",
      layer: "d1",
      data: { defaultWorkspaceId: expectedWorkspaceId },
    },
    async () => {
      if (!options.skipBootstrapWrites) {
        return selectActiveWorkspaceId(env, {
          userId,
          accountId,
          defaultWorkspaceId: expectedWorkspaceId,
        });
      }
      const preference = await selectActiveWorkspacePreference(env, { userId, accountId });
      return preference?.workspace_id ?? null;
    },
  );
  if (!activeWorkspaceId) {
    return {
      ok: false,
      response: json(
        { ok: false, error: "Active workspace preference not found" },
        { status: 403 },
      ),
    };
  }

  const user = await withAuthzSpan(authzSpans, { name: "User status resolve", layer: "d1" }, () =>
    selectUser(env, userId),
  );
  if (!user || user.status !== "active") {
    return {
      ok: false,
      response: json({ ok: false, error: "User is not active" }, { status: 403 }),
    };
  }

  const workspace = await withAuthzSpan(
    authzSpans,
    {
      name: "Workspace status resolve",
      layer: "d1",
      data: { activeWorkspaceId },
    },
    () => selectWorkspace(env, activeWorkspaceId),
  );
  if (
    !workspace ||
    workspace.account_id !== accountId ||
    !workspaceStatusAllowed(workspace.status)
  ) {
    return {
      ok: false,
      response: json({ ok: false, error: "Workspace is not active" }, { status: 403 }),
    };
  }

  const membership = await withAuthzSpan(
    authzSpans,
    {
      name: "Membership resolve",
      layer: "d1",
      data: { activeWorkspaceId },
    },
    () => selectMembership(env, userId, activeWorkspaceId),
  );
  if (!membership || membership.status !== "active") {
    return {
      ok: false,
      response: json({ ok: false, error: "Workspace membership is not active" }, { status: 403 }),
    };
  }

  const defaultWorkspace = await withAuthzSpan(
    authzSpans,
    { name: "Default workspace resolve", layer: "d1" },
    () => selectDefaultWorkspaceForAccount(env, accountId),
  );
  if (!defaultWorkspace) {
    return {
      ok: false,
      response: json({ ok: false, error: "Default workspace not found" }, { status: 403 }),
    };
  }

  const agentResult = await withAuthzSpan(
    authzSpans,
    {
      name: "Active/default agent resolve",
      layer: "d1",
      data: { activeWorkspaceId },
    },
    () =>
      selectActiveAgent(
        env,
        { userId, workspaceId: activeWorkspaceId },
        { allowPreferenceBootstrap: !options.skipBootstrapWrites },
      ),
  );
  if (!agentResult.ok) {
    return {
      ok: false,
      response: agentResult.response,
    };
  }

  return {
    ok: true,
    identity: {
      scope: { userId, workspaceId: activeWorkspaceId },
      agentId: agentResult.agent.id,
      accountId,
      accountSource,
      authMode: auth.mode,
    },
    authzSpans,
  };
};
