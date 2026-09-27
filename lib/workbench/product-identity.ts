import product from "@/config/product.json";

export type WorkbenchProductIdentity = {
  schemaVersion: number;
  id: string;
  displayName: string;
  webTitle: string;
  description: string;
  webOrigin: string;
  mobile: {
    displayName: string;
    slug: string;
    scheme: string;
    bundleIdentifier: string;
  };
  workspace: { defaultAgentPack: string; maxAgents: number };
};

export const workbenchProduct = product satisfies WorkbenchProductIdentity;
