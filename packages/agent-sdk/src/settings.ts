import type { JsonSchema, RuntimeRecord } from "./runtime.js";
import { assertSchemaDefinition, assertSchemaValue, validateSchemaValue } from "./schema.js";

/** Operator-editable package configuration. Values are data for the package, never instructions. */
export type RuntimeSettingsDefinition = {
  schema: JsonSchema;
  defaults: RuntimeRecord;
  /** Top-level keys operators may change. */
  editable: readonly string[];
};
/** Effective values pinned for one execution; version 0 means nothing has been stored. */
export type RuntimeSettings = Readonly<{ version: number; values: RuntimeRecord }>;

const isRecord = (value: unknown): value is RuntimeRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const assertRuntimeSettingsDefinition = (
  definition: RuntimeSettingsDefinition,
  label = "settings",
) => {
  if (!isRecord(definition)) throw new Error(`${label} must be an object`);
  assertSchemaDefinition(definition.schema, `${label} schema`);
  if (definition.schema.type !== "object") throw new Error(`${label} schema must be an object`);
  const properties = isRecord(definition.schema.properties) ? definition.schema.properties : {};
  if (
    !Array.isArray(definition.editable) ||
    new Set(definition.editable).size !== definition.editable.length ||
    definition.editable.some(
      (key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(properties, key),
    )
  )
    throw new Error(`${label} editable keys must be unique top-level schema properties`);
  if (!isRecord(definition.defaults)) throw new Error(`${label} defaults must be an object`);
  assertSchemaValue(definition.schema, definition.defaults, `${label} defaults`);
};

/** Defaults overlaid with stored values for editable keys; invalid stored values fall back to defaults. */
export const resolveRuntimeSettings = (
  definition: RuntimeSettingsDefinition | undefined,
  stored: { version?: number; values?: unknown } = {},
): RuntimeSettings => {
  const version =
    typeof stored.version === "number" && Number.isSafeInteger(stored.version) && stored.version > 0
      ? stored.version
      : 0;
  if (!definition) return freeze({ version, values: {} });
  const overrides = isRecord(stored.values) ? stored.values : {};
  const values = structuredClone(definition.defaults);
  for (const key of definition.editable)
    if (Object.prototype.hasOwnProperty.call(overrides, key))
      values[key] = structuredClone(overrides[key]);
  return freeze({
    version,
    values: validateSchemaValue(definition.schema, values).length
      ? structuredClone(definition.defaults)
      : values,
  });
};
