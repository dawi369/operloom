import { requestControlPlane } from "./transport";

/** Memory is a pass-through; contracts live in `@operloom/client`. */
export const listCloudflareMemory = (query: string) =>
  requestControlPlane<unknown>(`/workbench/memory${query}`);
export const rememberCloudflareMemory = (kind: string, key: string, body: unknown) =>
  requestControlPlane<unknown>(
    `/workbench/memory/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
export const confirmCloudflareMemory = (id: string) =>
  requestControlPlane<unknown>(`/workbench/memory/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
  });
export const forgetCloudflareMemory = (id: string) =>
  requestControlPlane<unknown>(`/workbench/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
