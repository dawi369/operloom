import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useMobileAuth } from "../src/auth/auth-provider";

export default function Index() {
  const { state } = useMobileAuth();
  if (state === "loading")
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  return <Redirect href={state === "signed-in" ? "/(tabs)/chat" : "/sign-in"} />;
}
