type Environment = Readonly<Record<string, string | undefined>>;

/** One server-side decision for the proxy, layout, and authoritative identity resolver. */
export const getAuthConfiguration = (environment: Environment = process.env) => {
  const workOsConfigured = Boolean(
    environment.WORKOS_CLIENT_ID?.trim() &&
    environment.WORKOS_API_KEY?.trim() &&
    environment.WORKOS_COOKIE_PASSWORD?.trim() &&
    environment.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim(),
  );
  const localIdentityEnabled =
    !workOsConfigured &&
    environment.WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY === "true" &&
    environment.NODE_ENV === "development" &&
    !environment.VERCEL_ENV &&
    !environment.RAILWAY_ENVIRONMENT_ID &&
    !environment.FLY_APP_NAME;
  return { workOsConfigured, localIdentityEnabled };
};
