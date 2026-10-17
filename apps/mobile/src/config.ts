import Constants from "expo-constants";
import { Platform } from "react-native";

const value = (input: string | undefined, fallback = "") => input?.trim() || fallback;
const configuredScheme = Constants.expoConfig?.scheme;

export const mobileConfig = {
  // Expo inlines only statically referenced EXPO_PUBLIC_* expressions.
  controlPlaneOrigin: value(
    process.env.EXPO_PUBLIC_CONTROL_PLANE_ORIGIN,
    "http://127.0.0.1:8788",
  ).replace(/\/$/, ""),
  workosClientId: value(process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID),
  workosIssuer: value(process.env.EXPO_PUBLIC_WORKOS_ISSUER, "https://api.workos.com"),
  authScheme:
    (Array.isArray(configuredScheme) ? configuredScheme[0] : configuredScheme) || "operloom",
  authCallbackPath: "auth/callback",
  platform: Platform.OS === "ios" ? ("ios" as const) : ("android" as const),
  version: Constants.expoConfig?.version ?? "0.1.0",
};

export const mobileAuthConfigured = Boolean(
  mobileConfig.workosClientId && mobileConfig.workosIssuer,
);
