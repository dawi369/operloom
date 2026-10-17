import { Redirect } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useMobileAuth } from "../src/auth/auth-provider";
import { Screen } from "../src/components/screen";
import { mobileConfig } from "../src/config";
import { colors } from "../src/theme";

export default function SignIn() {
  const auth = useMobileAuth();
  if (auth.state === "signed-in") return <Redirect href="/(tabs)/chat" />;
  return (
    <Screen
      title="Operloom"
      subtitle={`Signed-in access to ${mobileConfig.controlPlaneOrigin}`}
      scroll={false}
    >
      <View style={{ padding: 18, gap: 12 }}>
        {!auth.configured ? (
          <Text style={{ color: colors.danger }}>
            Set EXPO_PUBLIC_WORKOS_CLIENT_ID and EXPO_PUBLIC_WORKOS_ISSUER to enable sign-in.
          </Text>
        ) : null}
        {auth.error ? <Text style={{ color: colors.danger }}>{auth.error.message}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={!auth.configured || auth.operation !== "idle"}
          onPress={() => void auth.signIn()}
          style={{
            backgroundColor: colors.accent,
            borderRadius: 12,
            padding: 14,
            opacity: auth.configured ? 1 : 0.5,
          }}
        >
          <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
            {auth.operation === "signing-in" ? "Signing in…" : "Sign in with WorkOS"}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
