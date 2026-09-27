/** Compatibility entry point for existing native and cookie-facade consumers. */
import { loadAccessTokenConfig } from "./access-token";
export {
  parseAuthoritativeBearer,
  verifyWorkbenchAccessToken as verifyWorkbenchMobileAccessToken,
  type AccessTokenConfig as MobileAccessTokenConfig,
} from "./access-token";

export const loadMobileAccessTokenConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadAccessTokenConfig({
    ...source,
    WORKBENCH_PUBLIC_API_ENABLED: source.WORKBENCH_MOBILE_CLIENTS_ENABLED,
  });
