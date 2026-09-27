import type { z } from "zod";

export class WorkbenchResponseValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchResponseValidationError";
  }
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type InternalResponseSchema = z.ZodType;

export const parseWorkbenchResponse = <T>(
  schema: InternalResponseSchema,
  value: unknown,
  label: string,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
    throw new WorkbenchResponseValidationError(`${label}${path} is invalid`);
  }
  return result.data as T;
};
