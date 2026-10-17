import { requestControlPlane } from "./transport";

/** Billing is a thin pass-through; contracts live in `@operloom/client`. */
export const getCloudflareBilling = () => requestControlPlane<unknown>("/workbench/billing");
export const getCloudflareBillingPlans = () =>
  requestControlPlane<unknown>("/workbench/billing/plans");
export const assignCloudflareBillingPlan = (body: unknown) =>
  requestControlPlane<unknown>("/workbench/billing/plan", {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const createCloudflareBillingCheckout = (body: unknown) =>
  requestControlPlane<unknown>("/workbench/billing/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const createCloudflareBillingPortal = (body: unknown) =>
  requestControlPlane<unknown>("/workbench/billing/portal", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const getCloudflareBillingUsage = (query: string) =>
  requestControlPlane<unknown>(`/workbench/billing/usage${query}`);
export const reportCloudflareBillingUsage = (body: unknown) =>
  requestControlPlane<unknown>("/workbench/billing/usage/report", {
    method: "POST",
    body: JSON.stringify(body),
  });
