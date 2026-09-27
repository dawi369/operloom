// Use the official module-scoped types without replacing the frontend DOM globals.
declare module "cloudflare:workers" {
  import { CloudflareWorkersModule } from "@cloudflare/workers-types/index.ts";
  export = CloudflareWorkersModule;
}
