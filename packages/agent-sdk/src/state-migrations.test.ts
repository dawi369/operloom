import { describe, expect, it } from "vitest";
import { assertRuntimeStateMigrations, transformRuntimeState } from "./state-migrations";
import type { RuntimeStateDefinition, RuntimeStateMigration } from "./state";

const definitions: RuntimeStateDefinition[] = [1, 2].map((schemaVersion) => ({
  namespace: "documents",
  kind: "review",
  schemaVersion,
  schema: {
    type: "object",
    properties: { title: { type: "string" }, status: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
}));
const migration: RuntimeStateMigration = {
  id: "review-v2",
  namespace: "documents",
  kind: "review",
  fromVersion: 1,
  toVersion: 2,
  operations: [{ op: "default", field: "status", value: "pending" }],
};
describe("reviewed state migrations", () => {
  it("validates portable plans and preserves existing values when applying defaults", () => {
    assertRuntimeStateMigrations(definitions, [migration]);
    const source = { title: "Report", status: "approved" };
    expect(transformRuntimeState(migration, definitions[1]!, source)).toEqual(source);
    expect(transformRuntimeState(migration, definitions[1]!, { title: "Report" })).toEqual({
      title: "Report",
      status: "pending",
    });
    expect(source).toEqual({ title: "Report", status: "approved" });
  });
  it("rejects missing schemas, unbounded/non-JSON values and prototype keys", () => {
    expect(() => assertRuntimeStateMigrations(definitions.slice(1), [migration])).toThrow(
      "both be declared",
    );
    expect(() =>
      assertRuntimeStateMigrations(definitions, [
        { ...migration, operations: [{ op: "set", field: "__proto__", value: {} }] },
      ]),
    ).toThrow("field is invalid");
    expect(() =>
      assertRuntimeStateMigrations(definitions, [
        { ...migration, operations: [{ op: "set", field: "status", value: Infinity }] },
      ]),
    ).toThrow("finite");
    expect(() =>
      assertRuntimeStateMigrations(definitions, [
        {
          ...migration,
          operations: Array.from({ length: 33 }, () => ({
            op: "remove" as const,
            field: "status",
          })),
        },
      ]),
    ).toThrow("32 operations");
  });
  it("fails on destructive rename collisions and invalid target records", () => {
    expect(() =>
      transformRuntimeState(
        { ...migration, operations: [{ op: "rename", from: "title", to: "status" }] },
        definitions[1]!,
        { title: "a", status: "b" },
      ),
    ).toThrow("overwrite");
    expect(() =>
      transformRuntimeState(
        { ...migration, operations: [{ op: "remove", field: "title" }] },
        definitions[1]!,
        { title: "a" },
      ),
    ).toThrow();
  });
});
