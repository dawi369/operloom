import type { RuntimeStateDefinition, RuntimeStateMigration } from "./state.js";
import type { RuntimeRecord } from "./runtime.js";
import { assertSchemaValue } from "./schema.js";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const field = (value: string) =>
  identifier.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "state_migration_invalid" });
};
const jsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  return (
    Object.values(value).every((item) => jsonValue(item, depth + 1)) &&
    (Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
};

export const assertRuntimeStateMigrations = (
  definitions: readonly RuntimeStateDefinition[],
  migrations: readonly RuntimeStateMigration[],
) => {
  if (migrations.length > 32) invalid("Declare at most 32 state migrations");
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (
      !identifier.test(migration.id) ||
      ids.has(migration.id) ||
      !identifier.test(migration.namespace) ||
      !identifier.test(migration.kind) ||
      !Number.isSafeInteger(migration.fromVersion) ||
      !Number.isSafeInteger(migration.toVersion) ||
      migration.fromVersion < 1 ||
      migration.toVersion <= migration.fromVersion
    )
      invalid("Migration identities and increasing versions must be valid and unique");
    ids.add(migration.id);
    for (const version of [migration.fromVersion, migration.toVersion])
      if (
        definitions.filter(
          (definition) =>
            definition.namespace === migration.namespace &&
            definition.kind === migration.kind &&
            definition.schemaVersion === version,
        ).length !== 1
      )
        invalid("Migration source and destination schemas must both be declared");
    if (
      !Array.isArray(migration.operations) ||
      migration.operations.length > 32 ||
      new TextEncoder().encode(JSON.stringify(migration)).length > 32768
    )
      invalid("Migration exceeds 32 operations or 32 KiB");
    for (const operation of migration.operations) {
      if (operation.op === "rename") {
        if (!field(operation.from) || !field(operation.to) || operation.from === operation.to)
          invalid("Migration rename fields are invalid");
      } else if (["set", "default", "remove"].includes(operation.op)) {
        if (!("field" in operation) || !field(operation.field))
          invalid("Migration field is invalid");
        if ("value" in operation && !jsonValue(operation.value))
          invalid("Migration values must be finite, bounded JSON");
        if (operation.op !== "remove" && !("value" in operation))
          invalid("Migration value is required");
      } else invalid("Unknown migration operation");
    }
  }
};

export const transformRuntimeState = (
  migration: RuntimeStateMigration,
  definition: RuntimeStateDefinition,
  source: RuntimeRecord,
): RuntimeRecord => {
  const data = JSON.parse(JSON.stringify(source)) as RuntimeRecord;
  for (const operation of migration.operations) {
    if (operation.op === "rename") {
      if (!Object.hasOwn(data, operation.from)) continue;
      if (Object.hasOwn(data, operation.to))
        invalid("Migration rename would overwrite an existing field");
      data[operation.to] = data[operation.from];
      delete data[operation.from];
    } else if (operation.op === "remove") delete data[operation.field];
    else if (operation.op === "set" || !Object.hasOwn(data, operation.field))
      data[operation.field] = JSON.parse(JSON.stringify(operation.value));
  }
  assertSchemaValue(definition.schema, data, "migrated state");
  return data;
};
