import { Redirect } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useMobileAuth } from "../src/auth/auth-provider";
import type { MobileSignInProvider } from "../src/auth/workos-mobile-auth";
import { Screen } from "../src/components/screen";
import { mobileConfig } from "../src/config";
import { colors } from "../src/theme";

// Pinned providers skip AuthKit's chooser; each must be enabled on the WorkOS environment.
const providers: Array<{ id: MobileSignInProvider; label: string; primary?: boolean }> = [
  { id: "AppleOAuth", label: "Continue with Apple", primary: true },
  { id: "GoogleOAuth", label: "Continue with Google" },
  { id: "GitHubOAuth", label: "Continue with GitHub" },
  { id: "authkit", label: "Continue with email" },
];

export default function SignIn() {
  const auth = useMobileAuth();
  if (auth.state === "signed-in") return <Redirect href="/(tabs)/chat" />;
  const busy = auth.operation !== "idle";
  return (
    <Screen
      title="Operloom"
      subtitle={`Signed-in access to ${mobileConfig.controlPlaneOrigin}`}
      scroll={false}
    >
      <View style={{ padding: 18, gap: 10 }}>
        {!auth.configured ? (
          <Text style={{ color: colors.danger }}>
            Set EXPO_PUBLIC_WORKOS_CLIENT_ID and EXPO_PUBLIC_WORKOS_ISSUER to enable sign-in.
          </Text>
        ) : null}
        {auth.error ? <Text style={{ color: colors.danger }}>{auth.error.message}</Text> : null}
        {providers.map((provider) => (
          <Pressable
            key={provider.id}
            accessibilityRole="button"
            disabled={!auth.configured || busy}
            onPress={() => void auth.signIn(provider.id)}
            style={{
              backgroundColor: provider.primary ? colors.ink : colors.surface,
              borderColor: colors.line,
              borderWidth: 1,
              borderRadius: 12,
              padding: 14,
              opacity: auth.configured && !busy ? 1 : 0.5,
            }}
          >
            <Text
              style={{
                color: provider.primary ? "white" : colors.ink,
                textAlign: "center",
                fontWeight: "600",
              }}
            >
              {busy ? "Signing in…" : provider.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}
