export type DeploymentSql = (sql: string) => Promise<Record<string, unknown>[]>;
export type DeploymentFence = { deploymentId: string; artifactSha256: string };

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const validate = (fence: DeploymentFence) => {
  if (
    !/^[a-zA-Z0-9-]{1,80}$/.test(fence.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(fence.artifactSha256)
  )
    throw new Error("Invalid deployment fence identity");
};
export const acquireDeploymentFence = async (sql: DeploymentSql, fence: DeploymentFence) => {
  validate(fence);
  await sql(`INSERT INTO control_durable_deployment_fence (singleton,deployment_id,artifact_sha256,acquired_at)
    VALUES (1,${literal(fence.deploymentId)},${literal(fence.artifactSha256)},strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  await requireDeploymentFence(sql, fence);
};
export const requireDeploymentFence = async (sql: DeploymentSql, fence: DeploymentFence) => {
  validate(fence);
  const rows = await sql(
    "SELECT deployment_id,artifact_sha256 FROM control_durable_deployment_fence WHERE singleton=1",
  );
  if (
    rows.length !== 1 ||
    rows[0]!.deployment_id !== fence.deploymentId ||
    rows[0]!.artifact_sha256 !== fence.artifactSha256
  )
    throw new Error("Deployment fence ownership is missing or changed");
};
export const releaseDeploymentFence = async (sql: DeploymentSql, fence: DeploymentFence) => {
  await requireDeploymentFence(sql, fence);
  await sql(
    `DELETE FROM control_durable_deployment_fence WHERE singleton=1 AND deployment_id=${literal(fence.deploymentId)} AND artifact_sha256=${literal(fence.artifactSha256)}`,
  );
};

export const activateDeploymentFence = async (sql: DeploymentSql, fence: DeploymentFence) => {
  validate(fence);
  const active = await sql(
    "SELECT deployment_id,artifact_sha256 FROM control_durable_deployment_generation WHERE singleton=1",
  );
  if (
    active.length === 1 &&
    active[0]!.deployment_id === fence.deploymentId &&
    active[0]!.artifact_sha256 === fence.artifactSha256
  )
    return; // Activation committed but its acknowledgement may have been lost.
  await requireDeploymentFence(sql, fence);
  await sql(
    `UPDATE control_durable_deployment_fence SET activate_on_release=1 WHERE singleton=1 AND deployment_id=${literal(fence.deploymentId)} AND artifact_sha256=${literal(fence.artifactSha256)}`,
  );
};

export const loadRequiredDurableHandlers = async (sql: DeploymentSql, fence: DeploymentFence) => {
  await requireDeploymentFence(sql, fence);
  const rows =
    await sql(`SELECT DISTINCT pack_id,pack_version,workflow_type,workflow_version,runtime_version,definition_hash
    FROM control_durable_executions WHERE status IN ('pending','started')
    ORDER BY pack_id,pack_version,workflow_type,workflow_version,runtime_version,definition_hash LIMIT 1001`);
  if (rows.length > 1000)
    throw new Error("More than 1000 active handler versions; deployment inspection limit exceeded");
  return rows;
};

/** Never release on an uncertain upload/activation. Resume uses the same artifact and fence. */
export const withDurableDeploymentGate = async (input: {
  sql: DeploymentSql;
  fence: DeploymentFence;
  resume?: boolean;
  activate?: boolean;
  check: (pins: Record<string, unknown>[]) => Promise<void>;
  deploy: () => Promise<void>;
  verify: () => Promise<void>;
}) => {
  if (input.resume) await requireDeploymentFence(input.sql, input.fence);
  else await acquireDeploymentFence(input.sql, input.fence);
  let attempted = input.resume ?? false;
  try {
    await input.check(await loadRequiredDurableHandlers(input.sql, input.fence));
    await requireDeploymentFence(input.sql, input.fence);
    attempted = true;
    await input.deploy();
    await input.verify();
    if (input.activate === false) await releaseDeploymentFence(input.sql, input.fence);
    else await activateDeploymentFence(input.sql, input.fence);
  } catch (error) {
    if (!attempted) await releaseDeploymentFence(input.sql, input.fence);
    throw error;
  }
};
